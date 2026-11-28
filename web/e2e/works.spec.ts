import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockFreshMeta, mskClock } from "./live-meta";

// S7: слой «Стройки и работы» и карточка объекта (набор 2855 data.mos.ru).
//
// Тест 10 случайных карточек берёт объекты прямо из `public/live/works.geojson`
// детерминированным перемешиванием (mulberry32 на фиксированном зерне). Дату
// данных задаёт `mockFreshMeta` (S9): фиксированная дата в `public/live/meta.json`
// через сутки стала бы устаревшей, и слой работ законно исчез бы — тест упал бы
// по календарю, а не по коду.

type RawFeature = {
  properties?: { global_id?: number | string | null };
  geometry?: { type?: string; coordinates?: unknown } | null;
};

type LonLat = [number, number];

/** Первая координата в любой вложенности GeoJSON. */
function firstPosition(value: unknown): LonLat | null {
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

/** Центр геометрии = среднее всех координат (та же формула, что в карточке). */
function centroidOf(geometry: RawFeature["geometry"]): LonLat | null {
  const positions: LonLat[] = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number"
    ) {
      positions.push([value[0], value[1]]);
      return;
    }
    for (const item of value) collect(item);
  };
  collect(geometry?.coordinates);
  if (!positions.length) return null;
  let lng = 0;
  let lat = 0;
  for (const [x, y] of positions) {
    lng += x;
    lat += y;
  }
  return [lng / positions.length, lat / positions.length];
}

/** Расстояние по земной поверхности, метры. */
function haversine(a: LonLat, b: LonLat): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const WEB_ROOT = process.cwd();
const works = JSON.parse(
  readFileSync(join(WEB_ROOT, "public/live/works.geojson"), "utf8"),
) as { features: RawFeature[] };

/** Deep link: объект в центре (Тверская) — рядом есть жилой дом для теста. */
const DEEP_ID = "2786812938";
const deepFeature = works.features.find(
  (feature) => String(feature.properties?.global_id) === DEEP_ID,
);
if (!deepFeature) throw new Error(`в works.geojson нет объекта ${DEEP_ID}`);
/** Центр объекта; функция сразу падает, если геометрии нет — без null дальше. */
const DEEP_CENTROID: LonLat = (() => {
  const point = centroidOf(deepFeature.geometry);
  if (!point) throw new Error(`у объекта ${DEEP_ID} нет геометрии`);
  return point;
})();

/** Жилой дом рядом с объектом: «Тверская улица, 12 с6» (~46 м). */
const HOME = { id: 105773714, lng: 37.608509, lat: 55.763475 };

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
  getCenter(): { lng: number; lat: number };
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

/** Дождаться конца полёта/пересчёта камеры. */
async function waitForMapIdle(page: Page) {
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __map?: { isMoving(): boolean } }).__map;
      return Boolean(map && !map.isMoving());
    },
    null,
    { timeout: 30_000 },
  );
}

/** Проверенная точка клика: под ней карта и отрисованная фича работ. */
type WorksPoint = { x: number; y: number; id: string };

type ScreenArea = { left: number; right: number; top: number; bottom: number };

/** В точке (x, y) карта, а не панель, шторка или плашка поверх неё. */
async function isMapUnderPoint(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ({ px, py }) => {
      const element = document.elementFromPoint(px, py);
      if (!element) return false;
      if (element.classList.contains("maplibregl-canvas")) return true;
      return element.closest(".maplibregl-map") !== null;
    },
    { px: x, py: y },
  );
}

/** Камера едет? Пока едет, проекция точки не совпадает с отрисовкой. */
async function isMapMoving(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const map = (window as unknown as { __map?: { isMoving(): boolean } }).__map;
    return map ? map.isMoving() : true;
  });
}

/**
 * Экранная точка отрисованной работы в заданной области (для клика).
 *
 * Кандидат проверяется трижды и только потом берётся: он в области, под ним
 * карта (`elementFromPoint` не панель/шторка/плашка) и в нём действительно фича
 * работ. Кандидатов перебираем, а не берём первого: проекция одной вершины
 * может попасть под панель, мимо отрисовки или на границу фигуры.
 */
async function findWorksPoint(
  page: Page,
  area: ScreenArea,
  skip: string[] = [],
): Promise<WorksPoint | null> {
  return page.evaluate(
    ({ left, right, top, bottom, skip }) => {
      const map = (window as unknown as { __map?: BrowserMap }).__map;
      if (!map) return null;
      const layers = ["works-fill", "works-line", "works-point"].filter((id) =>
        map.getLayer(id),
      );
      if (!layers.length) return null;
      const features = map.queryRenderedFeatures({ layers });

      function positions(value: unknown): [number, number][] {
        const found: [number, number][] = [];
        const walk = (item: unknown): void => {
          if (!Array.isArray(item)) return;
          if (
            item.length >= 2 &&
            typeof item[0] === "number" &&
            typeof item[1] === "number"
          ) {
            found.push([item[0], item[1]]);
            return;
          }
          for (const child of item) walk(child);
        };
        walk(value);
        return found;
      }

      const lineish = (feature: RenderedFeature) =>
        feature.geometry?.type === "LineString" ||
        feature.geometry?.type === "MultiLineString";
      // Полигон/точку берём раньше линии: по тонкой линии клик менее надёжен.
      const ordered = [...features].sort(
        (a, b) => Number(lineish(a)) - Number(lineish(b)),
      );
      const skipped = new Set(skip);

      for (const feature of ordered) {
        const coordinates = positions(feature.geometry?.coordinates);
        if (!coordinates.length) continue;
        // Внутренняя точка надёжнее границы: у полигона — среднее координат
        // (та же формула, что в карточке), у линии — середина; первая вершина
        // только запасной вариант — на границе попадание шаткое.
        const probes: [number, number][] = [];
        if (!lineish(feature)) {
          let lng = 0;
          let lat = 0;
          for (const [x, y] of coordinates) {
            lng += x;
            lat += y;
          }
          probes.push([lng / coordinates.length, lat / coordinates.length]);
        }
        probes.push(coordinates[Math.floor(coordinates.length / 2)]);
        probes.push(coordinates[0]);

        for (const coordinate of probes) {
          const point = map.project(coordinate);
          const x = Math.round(point.x);
          const y = Math.round(point.y);
          if (x < left || x > right || y < top || y > bottom) continue;
          if (skipped.has(`${x},${y}`)) continue;
          // Панель, шторка или плашка поверх карты перехватят клик — не берём.
          const element = document.elementFromPoint(x, y);
          if (!element) continue;
          if (
            !element.classList.contains("maplibregl-canvas") &&
            element.closest(".maplibregl-map") === null
          ) {
            continue;
          }
          const check = map.queryRenderedFeatures([x, y], { layers });
          const raw = check[0]?.properties?.global_id;
          if (check.length && raw !== null && raw !== undefined) {
            return { x, y, id: String(raw) };
          }
        }
      }
      return null;
    },
    { ...area, skip },
  );
}

/**
 * Та же точка, но подтверждённая дважды с паузой, на стоящей камере и на карте
 * под ней. После выбора дома камера ещё доезжает: точка, найденная в этот
 * момент, через кадр уже мимо — линия работ 1.8 px, промах в пиксель = клик
 * по пустому месту.
 */
async function waitStableWorksPoint(
  page: Page,
  area: ScreenArea,
  skip: string[] = [],
  timeout = 20_000,
): Promise<WorksPoint | null> {
  const deadline = Date.now() + timeout;
  let previous: string | null = null;
  while (Date.now() < deadline) {
    const hit = await findWorksPoint(page, area, skip);
    const key = hit ? `${hit.x},${hit.y},${hit.id}` : null;
    if (
      hit &&
      key === previous &&
      !(await isMapMoving(page)) &&
      (await isMapUnderPoint(page, hit.x, hit.y))
    ) {
      return hit;
    }
    previous = key;
    await page.waitForTimeout(120);
  }
  return null;
}

/**
 * Открыть карточку работ кликом по проверенной точке. Камера после выбора дома
 * доезжает, поэтому точка пересчитывается перед каждой попыткой. Клик не открыл
 * карточку за 2 с — берём следующего кандидата, не больше `attempts` попыток.
 */
async function openWorkCardByClick(
  page: Page,
  area: ScreenArea,
  attempts = 4,
): Promise<WorksPoint | null> {
  const card = page.locator("[data-work-card]");
  const tried: string[] = [];
  let recentered = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await waitForMapIdle(page);
    let hit = await waitStableWorksPoint(page, area, tried);
    if (!hit && !recentered) {
      // Полёт к дому мог увести камеру — возвращаемся к объекту, выбор не трогаем.
      recentered = true;
      await page.evaluate(
        ({ center }) => {
          const map = (window as unknown as { __map?: BrowserMap }).__map;
          map?.jumpTo({ center, zoom: 15.5 });
        },
        { center: DEEP_CENTROID },
      );
      await waitForMapIdle(page);
      await waitForRenderedWorks(page);
      hit = await waitStableWorksPoint(page, area, tried);
    }
    if (!hit) continue;
    tried.push(`${hit.x},${hit.y}`);
    console.log(
      `S7: клик по работе ${hit.id} в (${hit.x},${hit.y}), попытка ${attempt}/${attempts}`,
    );
    await page.mouse.click(hit.x, hit.y);
    try {
      await expect(card).toBeVisible({ timeout: 2_000 });
      return hit;
    } catch {
      // Точка устарела (камера доехала) — пробуем следующего кандидата.
      console.log(`S7: карточка не открылась в (${hit.x},${hit.y}) — следующая точка`);
    }
  }
  return null;
}

/** Центр камеры, [lng, lat]; null — карты ещё нет. */
async function mapCenter(page: Page): Promise<LonLat | null> {
  return page.evaluate(() => {
    const map = (window as unknown as { __map?: BrowserMap }).__map;
    if (!map) return null;
    const center = map.getCenter();
    return [center.lng, center.lat] as [number, number];
  });
}

/**
 * Загрузить индекс поиска домов: он же наполняет движок признаком «жилой»
 * (в тайлах снапшота `is_home` нет). Без индекса клик по дому открывает
 * только уведомление «нежилое здание», а не карточку.
 */
async function loadSearchIndex(page: Page) {
  const input = page.getByLabel("Поиск дома по адресу");
  await input.click();
  await input.fill("Тверская 12");
  await expect(
    page.getByRole("button", { name: /Тверская улица, 12/ }).first(),
  ).toBeVisible({ timeout: 20_000 });
  await input.press("Escape");
  await page.waitForTimeout(300);
}

test("S7: 10 случайных карточек — источник и дата в шапке, без повторов", async ({ page }) => {
  test.setTimeout(300_000);
  const ids = pickWorkIds(10);
  const clock = mskClock(await mockFreshMeta(page));
  const seen: string[] = [];

  for (const id of ids) {
    await page.goto(`./?work=${id}`);
    const card = page.locator("[data-work-card]");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toHaveAttribute("data-work-id", id);
    // Ссылка на первоисточник и дата данных в МСК — один раз в шапке карточки.
    await expect(card.locator("[data-work-source]")).toHaveAttribute(
      "href",
      "https://data.mos.ru/opendata/2855",
    );
    await expect(card.locator("[data-work-source]")).toContainText("data.mos.ru, набор 2855");
    await expect(card.locator("[data-work-date]")).toContainText(`данные на ${clock} МСК`);
    await expect(card.getByRole("link", { name: "data.mos.ru, набор 2855" })).toHaveCount(1);
    // Под полями одинаковый провенанс не повторяется (источник у них общий).
    const facts = card.locator("[data-work-fact]");
    expect(await facts.count()).toBeGreaterThanOrEqual(6);
    for (const text of await facts.allTextContents()) {
      expect(text).not.toContain("data.mos.ru, набор");
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
  await mockFreshMeta(page);
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
  await mockFreshMeta(page);
  await page.goto("./");
  const chip = page.getByRole("button", { name: "Стройки и работы" });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");

  await focusOnWorks(page);

  const viewport = page.viewportSize();
  if (!viewport) throw new Error("нет viewport");
  const hit = await findWorksPoint(page, {
    left: 340,
    right: viewport.width - 220,
    top: 140,
    bottom: viewport.height - 170,
  });

  expect(hit, "не нашли отрисованный объект работ для клика").not.toBeNull();
  if (!hit) return;

  await page.mouse.click(hit.x, hit.y);
  const card = page.locator("[data-work-card]");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-work-id", hit.id);
  expect(page.url()).toContain(`work=${hit.id}`);
});

test("S7: deep link ?work= включает слой и ставит камеру на объект", async ({ page }) => {
  test.setTimeout(120_000);
  await mockFreshMeta(page);
  await page.goto(`./?work=${DEEP_ID}`);
  const card = page.locator("[data-work-card]");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute("data-work-id", DEEP_ID);

  // Слой работ включается ссылкой, а не остаётся выключенным чипом.
  const chip = page.getByRole("button", { name: "Стройки и работы" });
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await waitForMapReady(page);

  // Камера стоит на объекте (центр его геометрии) — иначе человек видит
  // карточку про Вороново, а на карте Пресню.
  await expect
    .poll(
      async () => {
        const center = await mapCenter(page);
        return center ? haversine(center, DEEP_CENTROID) : Number.POSITIVE_INFINITY;
      },
      { timeout: 20_000, intervals: [200, 400, 800] },
    )
    .toBeLessThan(50);

  await waitForRenderedWorks(page);
});

test("S7: одновременно открыта одна карточка — дом или работы", async ({ page }) => {
  test.setTimeout(180_000);
  await mockFreshMeta(page);
  await page.goto(`./?work=${DEEP_ID}`);
  const card = page.locator("[data-work-card]");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await waitForMapReady(page);
  await expect
    .poll(
      async () => {
        const center = await mapCenter(page);
        return center ? haversine(center, DEEP_CENTROID) : Number.POSITIVE_INFINITY;
      },
      { timeout: 20_000, intervals: [200, 400, 800] },
    )
    .toBeLessThan(60);
  await waitForMapIdle(page);

  const sheet = page.locator("#building-sheet");

  // Клик по жилому дому закрывает карточку работ. Индекс поиска наполняет
  // движок признаком «жилой» (в тайлах снапшота `is_home` нет), поэтому
  // сначала фокусируем поиск — как это делает живой пользователь.
  await loadSearchIndex(page);
  const home = await page.evaluate(
    ({ lng, lat }) => {
      const map = (window as unknown as { __map?: BrowserMap }).__map;
      if (!map) return null;
      const point = map.project([lng, lat]);
      return { x: Math.round(point.x), y: Math.round(point.y) };
    },
    { lng: HOME.lng, lat: HOME.lat },
  );
  expect(home, "не спроецировали дом").not.toBeNull();
  if (!home) return;
  await page.mouse.click(home.x, home.y);
  await expect(sheet).toHaveAttribute("data-sheet", "open", { timeout: 20_000 });
  await expect(card).toHaveCount(0);

  // Клик по работе закрывает карточку дома и открывает только работу.
  await waitForMapIdle(page);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("нет viewport");
  const area = { left: 320, right: 820, top: 140, bottom: viewport.height - 170 };
  const workHit = await openWorkCardByClick(page, area, 4);
  expect(
    workHit,
    "не открыли карточку работ кликом по проверенной точке",
  ).not.toBeNull();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(sheet).toHaveAttribute("data-sheet", "closed", { timeout: 20_000 });
});
