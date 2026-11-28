import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// S8: блок «Рядом» — пять категорий POI с расстоянием в метрах и фильтр
// «до 500 м».
//
// Приёмка из docs/ROADMAP.md: «на 3 адресах топ-5 расстояний совпадает с
// ручным замером ±20 м». Ручной замер в QGIS — это расстояние по прямой,
// поэтому проверка независимая: тест сам читает сырой `poi.geojson` района,
// сам считает haversine своей функцией (код приложения не импортируется) и
// сверяет с тем, что показывает шторка.
//
// Три дома — из трёх разных районов `public/data/districts/*/buildings-index.json`.
// Для них заранее проверено, что ближайший объект каждой из пяти категорий
// лежит внутри своего района: иначе «poi.geojson того же района» занизил бы
// выборку, и проверка мерила бы не то.

type LonLat = [number, number];

type PoiFeature = {
  properties?: { type?: string | null } | null;
  geometry?: { type?: string | null; coordinates?: unknown } | null;
};

type BuildingIndexRow = (number | string | null)[];

const WEB_ROOT = process.cwd();

/** Порядок и подписи — как в `BONUS_KEYS` / `BONUS_LABELS` приложения. */
const CATEGORY_ORDER = [
  "transport",
  "schools",
  "parks",
  "kindergartens",
  "shops",
] as const;

const LABELS: Record<string, string> = {
  transport: "Транспорт",
  schools: "Школы",
  parks: "Парки",
  kindergartens: "Детские сады",
  shops: "Магазины",
};

/** Транспорт = метро + платформы (как `NEARBY_POI_TYPES`). */
const POI_TYPES: Record<string, string[]> = {
  transport: ["subway_entrance", "rail_platform"],
  schools: ["school"],
  parks: ["park"],
  kindergartens: ["kindergarten"],
  shops: ["shop"],
};

/** Три реальных дома из трёх районов; адрес — для читаемого вывода. */
const HOUSES = [
  { district: 1250526, id: 84742766, address: "1-й Рижский переулок, 2 к4" },
  { district: 1250619, id: 270808918, address: "1-я Останкинская улица, 1А" },
  { district: 1255987, id: 852627546, address: "1-й Зачатьевский переулок, 3 с3" },
] as const;

/** Допуск приёмки, метры. */
const TOLERANCE_M = 20;

/** Расстояние по земной поверхности — своя функция, не из приложения. */
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

function readDistrict(districtId: number): {
  buildings: BuildingIndexRow[];
  pois: PoiFeature[];
} {
  const dir = join(WEB_ROOT, "public", "data", "districts", String(districtId));
  const buildings = JSON.parse(
    readFileSync(join(dir, "buildings-index.json"), "utf8"),
  ) as BuildingIndexRow[];
  const pois = JSON.parse(readFileSync(join(dir, "poi.geojson"), "utf8")) as {
    features: PoiFeature[];
  };
  return { buildings, pois: pois.features };
}

type DistrictEntry = { id: number; bbox: [number, number, number, number] };

const MANIFEST = JSON.parse(
  readFileSync(
    join(WEB_ROOT, "public", "data", "districts", "manifest.json"),
    "utf8",
  ),
) as { districts: DistrictEntry[] };

/** Дом у границы района: ближайший POI может лежать в соседнем районе. */
const POI_NEAR_DISTRICTS = 4;

const poisCache = new Map<number, PoiFeature[]>();

/** Грубое расстояние от точки до bbox района, метры (0 внутри). */
function distanceToBbox(point: LonLat, bbox: DistrictEntry["bbox"]): number {
  const [west, south, east, north] = bbox;
  const dx = point[0] < west ? west - point[0] : point[0] > east ? point[0] - east : 0;
  const dy = point[1] < south ? south - point[1] : point[1] > north ? point[1] - north : 0;
  return Math.hypot(dx * 62_500, dy * 111_320);
}

/**
 * POI района дома и ближайших районов — тот же охват, что у движка карты
 * (`POI_NEAR_DISTRICTS`). Три дома выбраны так, что ближайший объект каждой
 * категории лежит в своём районе, поэтому районная проверка — полная;
 * равенство ниже это подтверждает числами.
 */
function windowPois(districtId: number, point: LonLat): PoiFeature[] {
  const ids = [...MANIFEST.districts]
    .sort(
      (a, b) =>
        distanceToBbox(point, a.bbox) - distanceToBbox(point, b.bbox),
    )
    .slice(0, POI_NEAR_DISTRICTS)
    .map((district) => district.id);
  if (!ids.includes(districtId)) ids.unshift(districtId);
  return ids.flatMap((id) => {
    let features = poisCache.get(id);
    if (!features) {
      features = readDistrict(id).pois;
      poisCache.set(id, features);
    }
    return features;
  });
}

/** Ближайшее расстояние категории по прямой; null — таких объектов нет. */
function nearestDistance(
  pois: PoiFeature[],
  point: LonLat,
  types: string[],
): number | null {
  let best: number | null = null;
  for (const poi of pois) {
    if (poi.geometry?.type !== "Point") continue;
    const type = poi.properties?.type;
    if (typeof type !== "string" || !types.includes(type)) continue;
    const coordinates = poi.geometry.coordinates;
    if (
      !Array.isArray(coordinates) ||
      typeof coordinates[0] !== "number" ||
      typeof coordinates[1] !== "number"
    ) {
      continue;
    }
    const distance = haversine(point, [coordinates[0], coordinates[1]]);
    if (best === null || distance < best) best = distance;
  }
  return best;
}

type ShownRow = { key: string; distanceM: number | null };

/**
 * Открыть дом публичной ссылкой `?building=<id>` (та же, что в «Поделиться»):
 * это детерминированнее клика по точке — камеру, тайлы и выбор делает сам
 * движок, а тесту не нужно угадывать пиксель.
 */
async function openNearby(page: Page, house: (typeof HOUSES)[number]): Promise<ShownRow[]> {
  await page.goto(`./?building=${house.id}`);
  await expect(page).toHaveURL(new RegExp(`building=${house.id}`));
  await expect(page.locator("#building-sheet")).toHaveAttribute(
    "data-sheet",
    "open",
    { timeout: 60_000 },
  );
  const block = page.locator('[data-nearby="1"]');
  await expect(block).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-nearby-key]")).toHaveCount(
    CATEGORY_ORDER.length,
    { timeout: 60_000 },
  );
  return readRows(page);
}

async function readRows(page: Page): Promise<ShownRow[]> {
  const rows = page.locator("[data-nearby-key]");
  const count = await rows.count();
  const result: ShownRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const key = (await row.getAttribute("data-nearby-key")) ?? "";
    const raw = await row.getAttribute("data-nearby-distance");
    result.push({
      key,
      distanceM: raw === null || raw === "" ? null : Number(raw),
    });
  }
  return result;
}

test("S8: расстояния «Рядом» совпадают с независимым haversine по poi.geojson", async ({
  page,
}) => {
  test.setTimeout(300_000);

  for (const house of HOUSES) {
    const { buildings, pois } = readDistrict(house.district);
    const building = buildings.find((row) => Number(row[0]) === house.id);
    expect(building, `дом ${house.id} есть в buildings-index района`).toBeTruthy();
    const point: LonLat = [Number(building?.[1]), Number(building?.[2])];

    const shown = await openNearby(page, house);
    // Все пять категорий на месте, даже если по какой-то нет данных.
    expect(shown.map((row) => row.key).sort()).toEqual(
      [...CATEGORY_ORDER].sort(),
    );
    const window = windowPois(house.district, point);

    const facts: string[] = [];
    for (const key of CATEGORY_ORDER) {
      const row = shown.find((item) => item.key === key);
      expect(row, `строка «${LABELS[key]}» есть`).toBeTruthy();
      const actual = row?.distanceM ?? null;
      const expected = nearestDistance(pois, point, POI_TYPES[key]);
      const expectedWindow = nearestDistance(window, point, POI_TYPES[key]);

      // Ближайший объект категории — в своём районе: иначе районная проверка
      // была бы слабее реального охвата карточки, и дом надо менять.
      if (expected !== null && expectedWindow !== null) {
        expect(
          Math.abs(expected - expectedWindow),
          `${house.address}: ${LABELS[key]} — в районе ${expected.toFixed(1)} м, ` +
            `а с соседними районами ${expectedWindow.toFixed(1)} м; дом больше ` +
            `не годится для районной проверки`,
        ).toBeLessThanOrEqual(1);
      }

      if (actual === null) {
        // «Нет данных» допустимо только если объектов этого типа в районе нет.
        expect(
          expected,
          `${house.address}: интерфейс показал «${LABELS[key]}: нет данных», ` +
            `но в poi.geojson района объект есть (${expected?.toFixed(0)} м)`,
        ).toBeNull();
        facts.push(`${LABELS[key]} — нет данных`);
        continue;
      }

      expect(
        expected,
        `${house.address}: интерфейс показал ${actual} м, а объектов типа ` +
          `«${POI_TYPES[key].join("/")}» в районе нет`,
      ).not.toBeNull();
      const delta = Math.abs(actual - (expected ?? 0));
      expect(
        delta,
        `${house.address}: ${LABELS[key]} — интерфейс ${actual} м, ` +
          `независимый расчёт ${expected?.toFixed(1)} м, расхождение ${delta.toFixed(1)} м`,
      ).toBeLessThanOrEqual(TOLERANCE_M);
      // Подпись категории видна человеку, а не только в data-атрибуте.
      await expect(page.locator(`[data-nearby-key="${key}"]`)).toContainText(
        LABELS[key],
      );
      await expect(page.locator(`[data-nearby-key="${key}"]`)).toContainText(
        `${actual} м`,
      );
      facts.push(`${LABELS[key]} — ${actual} м (Δ ${delta.toFixed(1)} м)`);
    }
    console.log(`S8: ${house.address} — ${facts.join(", ")}`);
  }
});

test("S8: фильтр «до 500 м» скрывает дальние строки и считает скрытые", async ({
  page,
}) => {
  test.setTimeout(300_000);

  for (const house of HOUSES) {
    const shown = await openNearby(page, house);
    const filter = page.locator("[data-nearby-filter]");
    const block = page.locator('[data-nearby="1"]');

    // По умолчанию фильтр выключен: человек видит все пять категорий.
    await expect(filter).toHaveAttribute("data-nearby-filter", "off");
    await expect(page.locator("[data-nearby-key]")).toHaveCount(5);

    const far = shown.filter(
      (row) => row.distanceM !== null && row.distanceM > 500,
    );
    expect(
      far.length,
      `${house.address}: нужен хотя бы один объект дальше 500 м`,
    ).toBeGreaterThan(0);

    // Дальние категории помечены, но не спрятаны.
    for (const row of far) {
      const line = page.locator(`[data-nearby-key="${row.key}"]`);
      await expect(line).toBeVisible();
      await expect(line).toContainText("дальше 500 м");
    }

    await filter.click();
    await expect(filter).toHaveAttribute("data-nearby-filter", "on");

    // Дальние строки исчезли, остальные на месте.
    for (const row of far) {
      await expect(page.locator(`[data-nearby-key="${row.key}"]`)).toHaveCount(0);
    }
    const visible = await readRows(page);
    expect(visible).toHaveLength(5 - far.length);
    expect(visible.map((row) => row.key)).toEqual(
      shown.filter((row) => !far.includes(row)).map((row) => row.key),
    );
    // Счётчик скрытых совпадает с числом строк дальше 500 м.
    await expect(block).toContainText(`скрыто ${far.length}`);

    // Выключили — дальние строки вернулись, счётчик исчез.
    await filter.click();
    await expect(filter).toHaveAttribute("data-nearby-filter", "off");
    const restored = await readRows(page);
    expect(restored).toHaveLength(5);
    for (const row of far) {
      await expect(page.locator(`[data-nearby-key="${row.key}"]`)).toBeVisible();
    }
    await expect(block).not.toContainText("скрыто");

    console.log(
      `S8: ${house.address} — фильтр скрыл ${far.length} ` +
        `(${far.map((row) => `${LABELS[row.key]} ${row.distanceM} м`).join(", ")})`,
    );
  }
});
