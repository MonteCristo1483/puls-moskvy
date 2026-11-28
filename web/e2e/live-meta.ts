import type { Page } from "@playwright/test";

// Моки `live/meta.json` для e2e (S9).
//
// В репозитории лежит `public/live/meta.json` с фиксированным `generated_at`
// (27.11 19:22 МСК). Правило S9 — «нет живых данных, нет слоя» — через сутки
// после этой даты законно скроет слой работ, и тесты упали бы по календарю, а
// не по коду. Поэтому дату данных в тестах задаём относительно «сейчас»:
// проверки не зависят от того, сколько времени прошло с коммита репозитория.
//
// Мок отвечает валидным по форме JSON (`generated_at`, `fetched_at`,
// `sources`), чтобы слой фактов прошёл тот же разбор, что и с настоящим файлом.
const META_URL = "**/live/meta.json";

type MockMeta = {
  generated_at: string;
  fetched_at: string;
  sources: {
    works: { dataset: number; rows: number; fetched_at: string };
    permits: { dataset: number; rows: number; fetched_at: string };
  };
  stale: false;
  version: number;
};

/** Валидная по форме meta.json с датой `hoursAgo` часов назад. */
function metaHoursAgo(hoursAgo: number): MockMeta {
  const stamp = new Date(
    Date.now() - Math.round(hoursAgo * 60 * 60 * 1000),
  ).toISOString();
  return {
    generated_at: stamp,
    fetched_at: stamp,
    sources: {
      works: { dataset: 2855, rows: 4109, fetched_at: stamp },
      permits: { dataset: 64028, rows: 4019, fetched_at: stamp },
    },
    stale: false,
    version: 1,
  };
}

async function mockMeta(page: Page, meta: MockMeta): Promise<string> {
  await page.route(META_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(meta),
    }),
  );
  return meta.generated_at;
}

/**
 * Свежие факты: `generated_at` = сейчас минус 30 минут. Возвращает дату,
 * которую увидит UI, — тесты форматируют её в МСК и не хардкодят число.
 */
export async function mockFreshMeta(page: Page): Promise<string> {
  return mockMeta(page, metaHoursAgo(0.5));
}

/**
 * Устаревшие факты: `generated_at` = сейчас минус `hours` часов (по умолчанию
 * 30 — больше порога в 24 ч). Возвращает подставленную дату.
 */
export async function mockStaleMeta(
  page: Page,
  hours = 30,
): Promise<string> {
  return mockMeta(page, metaHoursAgo(hours));
}

/** Фактов нет вовсе: файл отвечает 404. */
export async function mockMissingMeta(page: Page): Promise<void> {
  await page.route(META_URL, (route) =>
    route.fulfill({ status: 404, body: "not found" }),
  );
}

/** «27.11 19:22» — дата данных в МСК (та же формула, что в `live-facts.ts`). */
export function mskClock(iso: string): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Date.parse(iso)));
  const pick = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("day")}.${pick("month")} ${pick("hour")}:${pick("minute")}`;
}
