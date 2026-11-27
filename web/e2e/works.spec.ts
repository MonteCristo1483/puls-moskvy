import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// S7: слой «Стройки и работы» и карточка объекта (набор 2855 data.mos.ru).
//
// Тест 10 случайных карточек берёт объекты прямо из `public/live/works.geojson`
// детерминированным перемешиванием (mulberry32 на фиксированном зерне), а
// ожидаемую дату данных форматирует из `public/live/meta.json` в МСК — так
// проверка не зависит от «сегодня» и не ходит в сеть.

type RawFeature = {
  properties?: { global_id?: number | string | null };
};

type LiveMeta = { generated_at?: string };

const WEB_ROOT = process.cwd();
const works = JSON.parse(
  readFileSync(join(WEB_ROOT, "public/live/works.geojson"), "utf8"),
) as { features: RawFeature[] };
const meta = JSON.parse(
  readFileSync(join(WEB_ROOT, "public/live/meta.json"), "utf8"),
) as LiveMeta;

/** «27.11 19:22» — та же дата данных в МСК, что показывает карточка. */
function mskClock(iso: string | undefined): string {
  if (!iso) throw new Error("в meta.json нет generated_at");
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Date.parse(iso)));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("day")}.${pick("month")} ${pick("hour")}:${pick("minute")}`;
}

/** Детерминированное перемешивание: 10 разных объектов на каждом прогоне — те же. */
function pickWorkIds(count: number): string[] {
  let seed = 20261127;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const indices = works.features.map((_, index) => index);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(random() * (indices.length - i));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, count).map((index) => {
    const id = works.features[index]?.properties?.global_id;
    if (id === null || id === undefined) throw new Error(`объект #${index} без global_id`);
    return String(id);
  });
}

type RenderedFeature = {
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown } | null;
};

type BrowserMap = {
  getLayer(id: string): unknown;
  getSource(id: string): unknown;
  getCanvas(): { getBoundingClientRect(): { width: number; height: number } };
  jumpTo(options: { center: [number, number]; zoom: number }): void;
  project(position: [number, number]): { x: number; y: number };
  queryRenderedFeatures(options: { layers: string[] }): RenderedFeature[];
  queryRenderedFeatures(
    point: [number, number],
    options: { layers: string[] },
  ): RenderedFeature[];
};

const WORKS_LAYERS = ["works-fill", "works-line", "works-point"];

/** После чипа: слои на карте и хотя бы одна отрисованная фича. */
async function waitForRenderedWorks(page: Page) {
  await page.waitForFunction(
    (layers: string[]) => {
      const map = (window as unknown as { __map?: BrowserMap }).__map;
      if (!map) return false;
      const present = layers.filter((id) => map.getLayer(id));
      if (present.length < layers.length) return false;
      return present.some((id) => map.queryRenderedFeatures({ layers: [id] }).length > 0);
    },
    WORKS_LAYERS,
    { timeout: 45_000 },
  );
}

/** Карта загрузила стиль и тайлы: после этого `jumpTo` не отменится загрузкой. */
async function waitForMapReady(page: Page) {
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __map?: { loaded(): boolean } }).__map;
      return Boolean(map?.loaded());
    },
    null,
    { timeout: 30_000 },
  );
}

/** Что на карте, если слой не отрисовался: печатается только на падении. */
async function worksDiagnostics(page: Page) {
  return page.evaluate(() => {
    const map = (window as unknown as { __map?: any }).__map;
    if (!map) return { map: false };
    const layers = ["works-fill", "works-line", "works-point"];
    const counts: Record<string, number> = {};
    for (const id of layers) {
      counts[id] = map.getLayer(id)
        ? map.queryRenderedFeatures({ layers: [id] }).length
        : -1;
    }
    const center = map.getCenter();
    return {
      map: true,
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      styleLoaded: map.isStyleLoaded(),
      source: Boolean(map.getSource("works")),
      sourceLoaded: map.isSourceLoaded("works"),
      layers: layers.map((id) => [id, Boolean(map.getLayer(id))]),
      counts,
    };
  });
}

/** Поставить карту на плотный по работам центр и дождаться её готовности. */
async function focusOnWorks(page: Page) {
  await waitForMapReady(page);
  await page.evaluate(() => {
    const map = (window as unknown as { __map?: BrowserMap }).__map;
    map?.jumpTo({ center: [37.554, 55.756], zoom: 13 });
  });
  await page.waitForTimeout(500);
  try {
    await waitForRenderedWorks(page);
  } catch (error) {
    console.log(`S7 diag: ${JSON.stringify(await worksDiagnostics(page))}`);
    throw error;
  }
}

test("S7: 10 случайных карточек — у каждого факта источник и дата", async ({ page }) => {
  test.setTimeout(300_000);
  const ids = pickWorkIds(10);
  const clock = mskClock(meta.generated_at);
  const seen: string[] = [];

  for (const id of ids) {
    await page.goto(`./?work=${id}`);
    const card = page.locator("[data-work-card]");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toHaveAttribute("data-work-id", id);
    // Ссылка на первоисточник и дата данных в МСК — в шапке карточки.
    await expect(card.locator("[data-work-source]")).toHaveAttribute(
      "href",
      "https://data.mos.ru/opendata/2855",
    );
    await expect(card.locator("[data-work-source]")).toContainText("data.mos.ru, набор 2855");
    await expect(card.locator("[data-work-date]")).toContainText(`данные на ${clock} МСК`);
    // Провенанс у каждого факта: тот же источник и та же дата.
    const facts = card.locator("[data-work-fact]");
    expect(await facts.count()).toBeGreaterThanOrEqual(6);
    const texts = await facts.allTextContents();
    for (const text of texts) {
      expect(text).toContain("data.mos.ru, набор 2855");
      expect(text).toContain(`данные на ${clock} МСК`);
    }
    seen.push(id);
  }

  expect(seen).toHaveLength(10);
  console.log(`S7: 10/10 карточек с источником и датой: ${seen.join(", ")}`);
});

test("S7: чип «Стройки и работы» выключен по умолчанию, включает слой карты", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("./");
  const chip = page.getByRole("button", { name: "Стройки и работы" });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-pressed", "false");

  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");

  // Ближе к городу: на z13 в кадре заведомо есть и линии, и точки, и полигоны.
  await focusOnWorks(page);

  const counts = await page.evaluate(() => {
    const map = (window as unknown as { __map?: BrowserMap }).__map;
    const result: Record<string, number> = {};
    for (const id of ["works-fill", "works-line", "works-point"]) {
      result[id] = map ? map.queryRenderedFeatures({ layers: [id] }).length : 0;
    }
    return result;
  });
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  console.log(`S7: отрисовано фич: ${total} (fill ${counts["works-fill"]}, line ${counts["works-line"]}, point ${counts["works-point"]})`);
  expect(total).toBeGreaterThan(0);
});

test("S7: клик по объекту открывает карточку и пишет ?work=<global_id>", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("./");
  const chip = page.getByRole("button", { name: "Стройки и работы" });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");

  await focusOnWorks(page);

  const viewport = page.viewportSize();
  if (!viewport) throw new Error("нет viewport");
  // Ищем отрисованную фичу и её точку в экранных координатах: полигон/точку
  // берём раньше линии — по тонкой линии клик по пикселю менее надёжен.
  const hit = await page.evaluate(
    ({ width, height }) => {
      const map = (window as unknown as { __map?: BrowserMap }).__map;
      if (!map) return null;
      const layers = ["works-fill", "works-line", "works-point"].filter((id) =>
        map.getLayer(id),
      );
      const features = map.queryRenderedFeatures({ layers });

      function firstPosition(value: unknown): [number, number] | null {
        if (
          Array.isArray(value) &&
          value.length >= 2 &&
          typeof value[0] === "number" &&
          typeof value[1] === "number"
        ) {
          return [value[0], value[1]];
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            const found = firstPosition(item);
            if (found) return found;
          }
        }
        return null;
      }

      const rank = (feature: RenderedFeature) =>
        feature.geometry?.type === "LineString" ||
        feature.geometry?.type === "MultiLineString"
          ? 1
          : 0;
      const ordered = [...features].sort((a, b) => rank(a) - rank(b));

      for (const feature of ordered) {
        const position = firstPosition(feature.geometry?.coordinates);
        if (!position) continue;
        const point = map.project(position);
        const x = Math.round(point.x);
        const y = Math.round(point.y);
        if (x < 340 || x > width - 220 || y < 140 || y > height - 170) continue;
        const check = map.queryRenderedFeatures([x, y], { layers });
        const raw = check[0]?.properties?.global_id;
        if (check.length && raw !== null && raw !== undefined) {
          return { x, y, id: String(raw) };
        }
      }
      return null;
    },
    { width: viewport.width, height: viewport.height },
  );

  expect(hit, "не нашли отрисованный объект работ для клика").not.toBeNull();
  if (!hit) return;

  await page.mouse.click(hit.x, hit.y);
  const card = page.locator("[data-work-card]");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-work-id", hit.id);
  expect(page.url()).toContain(`work=${hit.id}`);
});
