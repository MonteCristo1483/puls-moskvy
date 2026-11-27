// Городские факты (S6): данные, которые раз в сутки кладёт в `live/`
// `.github/workflows/live-data.yml`. Здесь всё, что не React: URL, запрос,
// разбор `meta.json` и форматирование времени в МСК.
//
// Слой на карте — S7. В S6 показываем только дату данных: файла нет или он
// старше суток → «нет данных» (S9: «нет данных — нет слоя»).
//
// Путь относительный: сайт живёт в подпапке Pages `/puls-moskvy/`, и
// `live/meta.json` рядом со страницей (basePath в next.config.ts).
export const LIVE_META_URL = "live/meta.json";

/** Порог устаревания данных: старше суток — не показываем (ROADMAP S6/S9). */
export const LIVE_STALE_MS = 24 * 60 * 60 * 1000;

export type LiveMeta = {
  generated_at?: unknown;
  fetched_at?: unknown;
  stale?: unknown;
  version?: unknown;
  sources?: unknown;
};

/**
 * `live/meta.json` или null, если файла нет/ответ не JSON.
 * `cache: "no-cache"` — файл перезаписывается по тому же URL, как и data/.
 */
export async function fetchLiveMeta(signal?: AbortSignal): Promise<LiveMeta | null> {
  const response = await fetch(LIVE_META_URL, { signal, cache: "no-cache" });
  if (!response.ok) return null;
  const payload: unknown = await response.json();
  return payload !== null && typeof payload === "object" ? (payload as LiveMeta) : null;
}

/** Время данных (мс) из `generated_at`; null, если метки нет или она битая. */
export function liveTimestamp(meta: LiveMeta | null): number | null {
  if (!meta || typeof meta.generated_at !== "string") return null;
  const stamp = Date.parse(meta.generated_at);
  return Number.isFinite(stamp) ? stamp : null;
}

/** «27.11 09:14» — дата и время данных в московском поясе. */
export function liveClock(iso: string): string | null {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return null;
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(stamp));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const day = pick("day");
  const month = pick("month");
  const hour = pick("hour");
  const minute = pick("minute");
  if (!day || !month || !hour || !minute) return null;
  return `${day}.${month} ${hour}:${minute}`;
}

/**
 * Данные устарели? Считаем по `generated_at` — это время последнего изменения
 * данных. `stale: true` в meta.json тоже устаревание.
 */
export function liveStale(meta: LiveMeta | null, now: number = Date.now()): boolean {
  const stamp = liveTimestamp(meta);
  if (stamp === null) return true;
  if (meta?.stale === true) return true;
  return now - stamp > LIVE_STALE_MS;
}
