// S8: «рядом» — пять категорий POI и фильтр «до 500 м».
//
// Модуль нарочно без DOM и без импортов приложения: вся логика строк и
// фильтра проверяется числами, а не глазами. Он же — единственное место,
// где живёт радиус и перевод расстояния в минуты ходьбы.
//
// Категории и типы POI повторяют `map/poi.ts` (`BONUS_KEYS`, `POI_TO_BONUS`).
// Дублирование осознанное: `map/poi.ts` тянет maplibre-gl и DOM, а этот
// модуль должен оставаться чистым. При добавлении типа POI править оба файла.

/** Радиус «рядом»: до 500 м. */
export const NEARBY_RADIUS_M = 500;

/** Скорость ходьбы из config/scoring.json — 5 км/ч. */
export const NEARBY_WALK_SPEED_KMH = 5;

/** Порядок категорий: он же порядок строк при равных расстояниях. */
export const NEARBY_CATEGORY_KEYS = [
  "transport",
  "schools",
  "parks",
  "kindergartens",
  "shops",
] as const;

/** Типы POI района → категория. Транспорт = метро + платформы. */
export const NEARBY_POI_TYPES: Record<string, readonly string[]> = {
  transport: ["subway_entrance", "rail_platform"],
  schools: ["school"],
  parks: ["park"],
  kindergartens: ["kindergarten"],
  shops: ["shop"],
};

/** Подписи категорий — единственный источник: шторка и store берут их отсюда. */
export const NEARBY_LABELS: Record<string, string> = {
  transport: "Транспорт",
  schools: "Школы",
  parks: "Парки",
  kindergartens: "Детские сады",
  shops: "Магазины",
};

export type LonLat = [number, number];

/** Строка блока «Рядом». distanceM = null — данных по категории нет. */
export type NearbyRow = {
  key: string;
  label: string;
  distanceM: number | null;
  minutes: number | null;
  withinRadius: boolean;
};

/** Запись бонуса из разбивки дома (`breakdown.bonuses[key]`). */
export type NearbyBonusEntry =
  | { distance_m?: number | null; minutes?: number | null }
  | null
  | undefined;

export type NearbyLabels = Record<string, string>;

/** Минимальная форма POI-фичи: только то, что нужно расстоянию. */
export type NearbyPoiFeature = {
  properties?: { type?: string | null } | null;
  geometry?: { type?: string | null; coordinates?: unknown } | null;
};

/** Расстояние по земной поверхности, метры. */
export function haversineMeters(a: LonLat, b: LonLat): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Минуты пешком по расстоянию (5 км/ч); ближе 83 м — всё равно «1 мин». */
export function walkingMinutes(distanceM: number): number {
  const metersPerMinute = (NEARBY_WALK_SPEED_KMH * 1000) / 60;
  return Math.max(1, Math.round(distanceM / metersPerMinute));
}

const CATEGORY_ORDER: Record<string, number> = Object.fromEntries(
  NEARBY_CATEGORY_KEYS.map((key, index) => [key, index]),
);

function categoryIndex(key: string): number {
  return CATEGORY_ORDER[key] ?? NEARBY_CATEGORY_KEYS.length;
}

function finiteDistance(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * Строки «Рядом» из разбивки дома: все пять категорий, даже если записи нет.
 * Молча выброшенная категория читается как «школы рядом нет» — это
 * утверждение, которого мы не делаем, поэтому нет данных = `distanceM: null`.
 *
 * Порядок: по расстоянию (null — в конце), при равенстве — по порядку
 * категорий transport → schools → parks → kindergartens → shops.
 */
export function nearbyRows(
  bonuses: Record<string, NearbyBonusEntry> | null | undefined,
  labels: NearbyLabels,
  radius = NEARBY_RADIUS_M,
): NearbyRow[] {
  const rows = NEARBY_CATEGORY_KEYS.map((key): NearbyRow => {
    const entry = bonuses?.[key] ?? null;
    const distanceM = finiteDistance(entry?.distance_m);
    const bonusMinutes =
      typeof entry?.minutes === "number" && Number.isFinite(entry.minutes) && entry.minutes >= 0
        ? Math.max(1, Math.round(entry.minutes))
        : null;
    return {
      key,
      label: labels[key] ?? key,
      distanceM,
      minutes: bonusMinutes ?? (distanceM === null ? null : walkingMinutes(distanceM)),
      withinRadius: distanceM !== null && distanceM <= radius,
    };
  });
  return rows.sort(
    (a, b) =>
      (a.distanceM ?? Number.POSITIVE_INFINITY) -
        (b.distanceM ?? Number.POSITIVE_INFINITY) ||
      categoryIndex(a.key) - categoryIndex(b.key),
  );
}

/**
 * Строки «Рядом» по сырым POI района: для каждой категории — ближайший объект
 * по прямой (haversine). Тем же правилом считает приёмка S8, поэтому цифры
 * в шторке и в тесте обязаны сойтись.
 */
export function nearbyFromPois(
  point: LonLat,
  pois: readonly NearbyPoiFeature[] | null | undefined,
  labels: NearbyLabels,
  radius = NEARBY_RADIUS_M,
): NearbyRow[] {
  const nearest: Record<string, NearbyBonusEntry> = {};
  for (const key of NEARBY_CATEGORY_KEYS) {
    const types = NEARBY_POI_TYPES[key] ?? [];
    let best: number | null = null;
    for (const poi of pois ?? []) {
      if (poi.geometry?.type !== "Point") continue;
      const type = poi.properties?.type;
      if (typeof type !== "string" || !types.includes(type)) continue;
      const coordinates = poi.geometry.coordinates;
      if (
        !Array.isArray(coordinates) ||
        coordinates.length < 2 ||
        typeof coordinates[0] !== "number" ||
        typeof coordinates[1] !== "number"
      ) {
        continue;
      }
      const distance = haversineMeters(point, [coordinates[0], coordinates[1]]);
      if (best === null || distance < best) best = distance;
    }
    nearest[key] = best === null ? null : { distance_m: best };
  }
  return nearbyRows(nearest, labels, radius);
}

/**
 * Фильтр «до 500 м»: скрывает строки дальше радиуса, строки без данных
 * оставляет — «нет данных» не то же самое, что «далеко».
 */
export function filterWithinRadius(
  rows: readonly NearbyRow[],
  radius: number,
): { visible: NearbyRow[]; hidden: number } {
  const visible = rows.filter(
    (row) => row.distanceM === null || row.distanceM <= radius,
  );
  return { visible, hidden: rows.length - visible.length };
}
