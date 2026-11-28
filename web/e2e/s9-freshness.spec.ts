import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockFreshMeta, mockMissingMeta, mockStaleMeta, mskClock } from "./live-meta";

// S9: «нет данных — нет слоя». Свежесть фактов задаётся моком `live/meta.json`,
// поэтому тест проверяет правило, а не календарь репозитория:
//   • устаревшие данные (>24 ч) → нет чипа, нет слоя/источника на карте, deep
//     link `?work=` не открывает карточку, бейдж говорит «устарел», в консоли
//     ровно одна запись `[S9]`;
//   • свежие данные → чип и слой на месте, бейдж показывает дату без «устарел»;
//   • meta.json нет → чипа нет, бейдж «нет данных».

type BrowserMap = {
  getLayer(id: string): unknown;
  getSource(id: string): unknown;
  loaded(): boolean;
  jumpTo(options: { center: [number, number]; zoom: number }): void;
  queryRenderedFeatures(options: { layers: string[] }): unknown[];
};

type RawFeature = { properties?: { global_id?: number | string | null } };

const WORKS_LAYERS = ["works-fill", "works-line", "works-point"];

/** Реальный объект из набора — для deep link в проверке устаревания. */
const works = JSON.parse(
  readFileSync(join(process.cwd(), "public/live/works.geojson"), "utf8"),
) as { features: RawFeature[] };
const REAL_ID = (() => {
  for (const feature of works.features) {
    const id = feature.properties?.global_id;
    if (id !== null && id !== undefined && String(id).trim()) return String(id);
  }
  throw new Error("в works.geojson нет ни одного global_id");
})();

/** Карта загрузила стиль: после этого `jumpTo` не отменится загрузкой. */
async function waitForMapReady(page: Page) {
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __map?: BrowserMap }).__map;
      return Boolean(map?.loaded());
    },
    null,
    { timeout: 30_000 },
  );
}

/** После чипа: все слои работ на карте и хотя бы одна отрисованная фича. */
async function waitForRenderedWorks(page: Page) {
  await page.waitForFunction(
    (layers: string[]) => {
      const map = (window as unknown as { __map?: BrowserMap }).__map;
      if (!map) return false;
      const present = layers.filter((id) => map.getLayer(id));
      if (present.length < layers.length) return false;
      return present.some(
        (id) => map.queryRenderedFeatures({ layers: [id] }).length > 0,
      );
    },
    WORKS_LAYERS,
    { timeout: 45_000 },
  );
}

test("S9: устаревшие данные — чипа, слоя и карточки нет, бейдж «устарел»", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mockStaleMeta(page, 30);
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });

  // Deep link на реальный объект: при устаревших данных он не должен открыть
  // карточку, о которой нечего честно сказать.
  await page.goto(`./?work=${REAL_ID}`);

  const badge = page.locator("[data-facts-badge]");
  await expect(badge).toHaveAttribute("data-facts-status", "missing");
  await expect(badge).toContainText("устарел");

  await expect(
    page.getByRole("button", { name: "Стройки и работы" }),
  ).toHaveCount(0);
  await expect(page.locator("[data-work-card]")).toHaveCount(0);

  // Слой успел смонтироваться на «loading» и должен быть снят вместе с
  // источником, когда стало известно, что данные устарели.
  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ layers }) => {
            const map = (window as unknown as { __map?: BrowserMap }).__map;
            if (!map) return "map-not-ready";
            return {
              source: Boolean(map.getSource("works")),
              layers: layers.filter((id) => map.getLayer(id)),
            };
          },
          { layers: WORKS_LAYERS },
        ),
      { timeout: 30_000 },
    )
    .toEqual({ source: false, layers: [] });

  // Одна запись на переход, с названием слоя и датой данных.
  await expect
    .poll(() => warnings.filter((text) => text.includes("[S9]")).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  await page.waitForTimeout(300);
  const s9 = warnings.filter((text) => text.includes("[S9]"));
  expect(s9, `записей [S9]: ${JSON.stringify(s9)}`).toHaveLength(1);
  expect(s9[0]).toContain("Стройки и работы");
  expect(s9[0]).toContain("старше 24 ч");
  expect(s9[0]).toContain("generated_at");
});

test("S9: свежие данные — чип и слой на месте, бейдж без «устарел»", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const generated = await mockFreshMeta(page);
  await page.goto("./");

  const chip = page.getByRole("button", { name: "Стройки и работы" });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");

  const badge = page.locator("[data-facts-badge]");
  await expect(badge).toHaveAttribute("data-facts-status", "ok");
  await expect(badge).toContainText(`Данные на ${mskClock(generated)}`);
  await expect(badge).not.toContainText("устарел");
  await expect(badge).toHaveAttribute("data-facts-time", generated);

  // Свежие данные — слой действительно рисуется (как проверяет works.spec).
  await waitForMapReady(page);
  await page.evaluate(() => {
    const map = (window as unknown as { __map?: BrowserMap }).__map;
    map?.jumpTo({ center: [37.554, 55.756], zoom: 13 });
  });
  await page.waitForTimeout(500);
  await waitForRenderedWorks(page);

  const counts = await page.evaluate((layers: string[]) => {
    const map = (window as unknown as { __map?: BrowserMap }).__map;
    const result: Record<string, number> = {};
    for (const id of layers) {
      result[id] = map ? map.queryRenderedFeatures({ layers: [id] }).length : 0;
    }
    return result;
  }, WORKS_LAYERS);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  console.log(`S9: свежие данные, отрисовано фич: ${total} (${JSON.stringify(counts)})`);
  expect(total).toBeGreaterThan(0);
});

test("S9: meta.json нет — чипа нет, бейдж «нет данных»", async ({ page }) => {
  test.setTimeout(60_000);
  await mockMissingMeta(page);
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });

  await page.goto("./");

  await expect(
    page.getByRole("button", { name: "Стройки и работы" }),
  ).toHaveCount(0);
  const badge = page.locator("[data-facts-badge]");
  await expect(badge).toHaveAttribute("data-facts-status", "missing");
  await expect(badge).toContainText("нет данных");

  await expect
    .poll(
      () =>
        warnings.some(
          (text) => text.includes("[S9]") && text.includes("meta.json не найден"),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
});
