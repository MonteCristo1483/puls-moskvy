import { test, expect, type Page } from "@playwright/test";

// Бейдж городских фактов (S6). Файл `live/meta.json` в сборке может быть
// любым (в CI его нет вовсе), поэтому оба состояния задаются моком сети:
// свежие данные → «Данные на ДД.ММ ЧЧ:ММ» в МСК, файла нет или данные старше
// 24 ч → «нет данных».
const META_URL = "**/live/meta.json";

const META = {
  generated_at: "2026-11-27T06:14:00Z", // 09:14 МСК
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
  await mockMeta(page, META);
  await page.goto("./");

  const badge = page.locator("[data-facts-badge]");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-facts-status", "ok");
  await expect(badge).toContainText("Данные на 27.11 09:14");
  await expect(badge).toHaveAttribute("data-facts-time", META.generated_at);
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

test("Факты: данные старше 24 ч → «нет данных»", async ({ page }) => {
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  await mockMeta(page, {
    ...META,
    generated_at: old,
    fetched_at: old,
  });

  await page.goto("./");
  const badge = page.locator("[data-facts-badge]");
  await expect(badge).toHaveAttribute("data-facts-status", "missing");
  await expect(badge).toContainText("нет данных");
});

test("Факты: плашка не дублируется и не мешает поиску", async ({ page }) => {
  await mockMeta(page, META);
  await page.goto("./");
  await expect(page.locator("[data-facts-badge]")).toHaveCount(1);
  await expect(page.getByLabel("Поиск дома по адресу")).toBeVisible();
  const facts = await box(page, "[data-facts-badge]");
  const search = await box(page, 'input[aria-label="Поиск дома по адресу"]');
  expect(overlap(facts, search), "бейдж наезжает на поиск").toBe(false);
});
