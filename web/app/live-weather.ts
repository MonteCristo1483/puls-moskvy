// Погода и ветер — данные Open-Meteo напрямую из браузера (ADR-001: без
// бэкенда, CORS открыт, ключа нет). Здесь всё, что не React: типы, URL,
// запрос с таймаутом и отменой, кэш в памяти и разбор ответа.
//
// S4: один и тот же запрос отдаёт и «сейчас», и часовой ряд на сутки назад и
// вперёд (`hourly` + `past_days=1&forecast_days=1`), чтобы таймлайн мог
// показать «было» без второго запроса. Кэш общий: смена выбранного часа в
// таймлайне не ходит в сеть вообще.
export const WEATHER_REFRESH_MS = 15 * 60 * 1000;
// Порог «карта заметно сдвинулась»: 0.05° ≈ 3–5 км, сетка модели 1–11 км.
export const WEATHER_MOVE_THRESHOLD_DEG = 0.05;

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MINUTES_PER_DAY = 1440;

export type WeatherValues = {
  temperatureC: number;
  windSpeedMs: number;
  /** Метеорологическое направление «откуда», градусы 0–360. */
  windDirectionDeg: number;
  precipitationMm: number;
  /** Код погоды WMO (0–99): дождь/снег/туман. null — поля в ответе не было. */
  weatherCode: number | null;
};

export type WeatherSnapshot = WeatherValues & {
  /** Локальное время точки, как отдаёт API: «2026-11-27T11:00». */
  time: string;
  /**
   * Часовой ряд: вчера + сегодня (48 значений) — «было» на таймлайне.
   * Пусто, если ответ пришёл без блока hourly (старый кэш, офлайн).
   */
  hours: WeatherHour[];
};

export type WeatherHour = WeatherValues & {
  /** Время API: «2026-11-27T14:00». */
  time: string;
  /** Календарная дата API: «2026-11-27» (московская). */
  date: string;
  /** Час от полуночи, 0–23. */
  hour: number;
};

export class WeatherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherError";
  }
}

type CacheEntry = { at: number; data: WeatherSnapshot };

// Кэш в памяти: имя по координатам с тремя знаками (~100 м). Ключ без Map —
// TS7 (tsgo) ломается на глобальном `new Map<K,V>()` (см. DECISIONS).
const cache: Record<string, CacheEntry> = {};

/**
 * URL запроса: «сейчас» и часовой ряд в одном ответе. `past_days=1` — вчера,
 * `forecast_days=1` — сегодня, то есть ровно двое суток по часам; ветер в м/с,
 * время московское (пояс задаём, чтобы «14:00» в UI совпадало с данными).
 */
export function weatherQueryUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current:
      "temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,weather_code",
    hourly:
      "temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,weather_code",
    past_days: "1",
    forecast_days: "1",
    wind_speed_unit: "ms",
    timezone: "Europe/Moscow",
  });
  return `${OPEN_METEO_URL}?${params.toString()}`;
}

function numberField(current: Record<string, unknown>, key: string): number {
  const value = current[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WeatherError(`Open-Meteo: нет поля current.${key}`);
  }
  return value;
}

/** Необязательное числовое поле: старые ответы и моки могут его не отдавать. */
function optionalNumber(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberAt(values: unknown, index: number): number | null {
  if (!Array.isArray(values)) return null;
  const value = values[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Разбор блока hourly. Нетерпим к пропускам: null в массивах Open-Meteo
 * отдаёт регулярно, а отсутствие блока hourly не должно ронять плашку «сейчас».
 */
function parseHours(payload: unknown): WeatherHour[] {
  const hourly = (payload as { hourly?: unknown } | null)?.hourly;
  if (!hourly || typeof hourly !== "object") return [];
  const record = hourly as Record<string, unknown>;
  const times = record.time;
  if (!Array.isArray(times)) return [];

  const hours: WeatherHour[] = [];
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];
    if (typeof time !== "string") continue;
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(time);
    if (!match) continue;
    const temperatureC = numberAt(record.temperature_2m, index);
    const windSpeedMs = numberAt(record.wind_speed_10m, index);
    const windDirectionDeg = numberAt(record.wind_direction_10m, index);
    if (
      temperatureC === null ||
      windSpeedMs === null ||
      windDirectionDeg === null
    ) {
      continue;
    }
    hours.push({
      time,
      date: match[1],
      hour: Number(match[2]),
      temperatureC,
      windSpeedMs,
      windDirectionDeg,
      precipitationMm: numberAt(record.precipitation, index) ?? 0,
      // weather_code в часовом ряду нужен осадкам на выбранный час; если его
      // нет — состояние неба считаем «ясно».
      weatherCode: numberAt(record.weather_code, index),
    });
  }
  return hours;
}

/** Разбор ответа API. Вынесен отдельно: его же гоняют проверки точности. */
export function parseWeather(payload: unknown): WeatherSnapshot {
  const current = (payload as { current?: unknown } | null)?.current;
  if (!current || typeof current !== "object") {
    throw new WeatherError("Open-Meteo: в ответе нет блока current");
  }
  const record = current as Record<string, unknown>;
  const time = typeof record.time === "string" ? record.time : "";
  if (!time) throw new WeatherError("Open-Meteo: нет поля current.time");
  return {
    temperatureC: numberField(record, "temperature_2m"),
    windSpeedMs: numberField(record, "wind_speed_10m"),
    windDirectionDeg: numberField(record, "wind_direction_10m"),
    precipitationMm: numberField(record, "precipitation"),
    weatherCode: optionalNumber(record, "weather_code"),
    time,
    hours: parseHours(payload),
  };
}

/** «2026-11-27T11:00» → «11:00». Часовой пояс уже московский от API. */
export function weatherClock(time: string): string {
  const match = /T(\d{2}:\d{2})/.exec(time);
  return match ? match[1] : "—";
}

/**
 * Значение на выбранное время суток (минуты от полуночи, московское):
 * ближайший час с округлением вниз, в пределах даты снимка (`14:37` → `14:00`).
 * null — часового ряда в снимке нет, вызывающий берёт текущее значение.
 */
export function weatherAt(
  snapshot: WeatherSnapshot | null,
  minutes: number | null,
): WeatherHour | null {
  if (!snapshot || snapshot.hours.length === 0) return null;
  if (minutes === null || !Number.isFinite(minutes)) return null;
  const date = snapshot.time.slice(0, 10);
  const target = Math.floor(minutes / 60) * 60;
  let best: WeatherHour | null = null;
  for (const hour of snapshot.hours) {
    if (hour.date !== date) continue;
    const minute = hour.hour * 60;
    if (minute > target) continue;
    if (best === null || minute > best.hour * 60) best = hour;
  }
  return best;
}

/**
 * «Прошедший час — факт, будущий — прогноз». Считаем по московским минутам
 * от полуночи: выбранный час не позже текущей минуты уже состоялся.
 */
export function weatherKind(
  minutes: number,
  nowMinutes: number,
): "факт" | "прогноз" {
  const selection = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return selection <= nowMinutes ? "факт" : "прогноз";
}

/** Нет сети? navigator.onLine врёт при блокировке DNS, поэтому это лишь подсказка. */
export function looksOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export type FetchWeatherOptions = {
  /** Отмена вызывающим (смена слоя, смена центра, размонтирование). */
  signal?: AbortSignal;
  /** Не брать из кэша (плановое обновление раз в 15 минут). */
  force?: boolean;
};

/**
 * Запрос погоды для точки. Бросает WeatherError (кроме отмены вызывающим:
 * тогда пробрасывается DOMException AbortError — вызывающий его игнорирует).
 */
export async function fetchWeather(
  lat: number,
  lon: number,
  options: FetchWeatherOptions = {},
): Promise<WeatherSnapshot> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new WeatherError("Некорректные координаты");
  }
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = cache[key];
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }
  if (options.signal?.aborted) {
    throw new DOMException("Запрос отменён", "AbortError");
  }

  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(weatherQueryUrl(lat, lon), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new WeatherError(`Open-Meteo ответил ${response.status}`);
    }
    const data = parseWeather(await response.json());
    cache[key] = { at: Date.now(), data };
    return data;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof WeatherError) throw error;
    if (timedOut) throw new WeatherError("Open-Meteo не ответил за 10 секунд");
    if (looksOffline()) throw new WeatherError("Нет сети");
    throw new WeatherError(
      error instanceof Error ? error.message : "Не удалось получить погоду",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
