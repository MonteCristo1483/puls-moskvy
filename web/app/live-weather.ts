// Погода и ветер — данные Open-Meteo напрямую из браузера (ADR-001: без
// бэкенда, CORS открыт, ключа нет). Здесь всё, что не React: типы, URL,
// запрос с таймаутом и отменой, кэш в памяти и разбор ответа.
export const WEATHER_REFRESH_MS = 15 * 60 * 1000;
// Порог «карта заметно сдвинулась»: 0.05° ≈ 3–5 км, сетка модели 1–11 км.
export const WEATHER_MOVE_THRESHOLD_DEG = 0.05;

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export type WeatherSnapshot = {
  temperatureC: number;
  windSpeedMs: number;
  /** Метеорологическое направление «откуда», градусы 0–360. */
  windDirectionDeg: number;
  precipitationMm: number;
  /** Локальное время точки, как отдаёт API: «2026-11-27T11:00». */
  time: string;
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

/** URL запроса: ровно те поля, что нужны слою; ветер в м/с, время московское. */
export function weatherQueryUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: "temperature_2m,wind_speed_10m,wind_direction_10m,precipitation",
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
    time,
  };
}

/** «2026-11-27T11:00» → «11:00». Часовой пояс уже московский от API. */
export function weatherClock(time: string): string {
  const match = /T(\d{2}:\d{2})/.exec(time);
  return match ? match[1] : "—";
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
