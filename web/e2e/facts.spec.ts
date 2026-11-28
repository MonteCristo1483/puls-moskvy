import { test, expect, type Page } from "@playwright/test";
import { mockFreshMeta, mskClock } from "./live-meta";

// Бейдж городских фактов (S6). Файл `live/meta.json` в сборке может быть
// любым (в CI его нет вовсе), поэтому оба состояния задаются моком сети:
// свежие данные → «Данные на ДД.ММ ЧЧ:ММ» в МСК, файла нет → «нет данных»,
// данные старше 24 ч → «Данные устарели» с датой (S9). Свежесть задаётся
// относительно «сейчас» (`mockFreshMeta`), а не датой файла в репозитории.
const META_URL = "**/live/meta.json";

const META = {
  generated_at: "2026-11-27T06:14:00Z", // форма ответа; дату задаёт мок
  fetched_at: "2026-11-27T06:14:00Z",
  sources: {
    works: { dataset: 2855, rows: 4109, fetched_at: "2026-11-27T06:14:00Z" },
  },
  stale: false,
  version: 1,
};

async function mockMeta(page: Page, body: unknown) {
  await page.route(META_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  );
}

async function missMeta(page: Page) {
  await page.route(META_URL, (route) =>
    route.fulfill({ status: 404, body: "not found" }),
  );
}

/** Пересечение прямоугольников — бейдж не должен наезжать на другой UI. */
function overlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

async function box(page: Page, selector: string) {
  const value = await page.locator(selector).first().boundingBox();
  expect(value, `нет элемента ${selector}`).not.toBeNull();
  return value!;
}

test("Факты: свежий meta.json → дата данных в МСК", async ({ page }) => {
  const generated = await mockFreshMeta(page);
  await page.goto("./");

  const badge = page.locator("[data-facts-badge]");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-facts-status", "ok");
  await expect(badge).toContainText(`Данные на ${mskClock(generated)}`);
  await expect(badge).toHaveAttribute("data-facts-time", generated);
  // Источник и лицензия — в title плашки (атрибуция CC BY 4.0, S10).
  await expect(badge).toHaveAttribute("title", /CC BY 4\.0/);

  // Приёмка: плашка не перекрывает таймлайн и футер.
  const facts = await box(page, "[data-facts-badge]");
  const timeline = await box(page, "[data-timeline]");
  const footer = await page
    .getByText("© OpenStreetMap contributors", { exact: false })
    .first()
    .boundingBox();
  expect(overlap(facts, timeline), "бейдж наезжает на таймлайн").toBe(false);
  expect(footer, "нет футера с атрибуцией").not.toBeNull();
  expect(overlap(facts, footer!), "бейдж наезжает на футер").toBe(false);

  // Кнопки карты MapLibre (+/− и компас) — верхний правый угол; бейдж стоит
  // ниже них и не должен их перекрывать. Если карта не поднялась (нет
  // данных), контрола нет — проверка пропускается.
  const nav = await page.locator(".maplibregl-ctrl-top-right").first().boundingBox();
  if (nav) expect(overlap(facts, nav), "бейдж наезжает на кнопки карты").toBe(false);
});

test("Факты: файла нет → «нет данных» и карта не падает", async ({ page }) => {
  await missMeta(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await page.goto("./");
  const badge = page.locator("[data-facts-badge]");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-facts-status", "missing");
  await expect(badge).toContainText("нет данных");
  await expect(page.getByText("Не удалось загрузить данные карты")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("Факты: данные старше 24 ч → «Данные устарели»", async ({ page }) => {
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  await mockMeta(page, {
    ...META,
    generated_at: old,
    fetched_at: old,
  });

  await page.goto("./");
  const badge = page.locator("[data-facts-badge]");
  // Данные старые, но файл есть — `stale`; `missing` означал бы, что файла
  // нет (это соседний тест выше).
  await expect(badge).toHaveAttribute("data-facts-status", "stale");
  await expect(badge).toContainText(`Данные устарели · ${mskClock(old)}`);
  await expect(badge).toHaveAttribute("data-facts-time", old);
});

test("Факты: плашка не дублируется и не мешает поиску", async ({ page }) => {
  await mockFreshMeta(page);
  await page.goto("./");
  await expect(page.locator("[data-facts-badge]")).toHaveCount(1);
  await expect(page.getByLabel("Поиск дома по адресу")).toBeVisible();
  const facts = await box(page, "[data-facts-badge]");
  const search = await box(page, 'input[aria-label="Поиск дома по адресу"]');
  expect(overlap(facts, search), "бейдж наезжает на поиск").toBe(false);
});
