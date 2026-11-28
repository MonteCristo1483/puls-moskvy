// S8: данные для блока «Рядом» — загрузка POI и сборка строк по выбранному дому.
//
// Почему расстояние считается здесь, а не берётся из разбивки: в тайлы домов
// попадает только компактная v2-форма `{v,i,f,fl}` без `bonuses` — расстояний
// в ней нет. Источник — `poi.geojson` района дома и соседних районов, а
// расстояние — по прямой (haversine). Это то же правило, что у приёмки S8:
// ручной замер в QGIS тоже прямая.
//
// Всё сетевое и кэши живут в модуле, а не в компоненте: пересоздание
// `map.tsx` (StrictMode, возврат на страницу) не повторяет загрузку, а
// повторный выбор дома берёт готовые строки. Наружу — `useNearbyRows` для
// оркестратора и `loadNearbyRows` для проверок.
import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { NEARBY_LABELS, nearbyFromPois } from "./nearby";
import type { LonLat, NearbyPoiFeature, NearbyRow } from "./nearby";
import { MANIFEST_URL } from "./map/tiles";

type DistrictEntry = { id: number; bbox: [number, number, number, number] };

// Строка `buildings-index.json` района — [id, lon, lat, address, …].
type BuildingIndexRow = (number | string | null)[];

/**
 * Дом у границы района не должен «терять» ближайший POI за границей: смотрим
 * столько же районов, сколько движок держит в кэше POI (`POI_NEAR_DISTRICTS`
 * в map/poi.ts), и берём ближайшие по bbox.
 */
const NEARBY_POI_DISTRICTS = 4;

/** Сколько ждать, пока движок запишет район выбранного дома. */
const DISTRICT_ATTEMPTS = 20;
const DISTRICT_WAIT_MS = 50;

// ── Кэши модуля ────────────────────────────────────────────────────────────
// Промисы, а не значения: параллельные вызовы (быстрый выбор двух домов)
// делят одну загрузку.
let manifestRequest: Promise<DistrictEntry[] | null> | null = null;
const poiRequests = new Map<number, Promise<NearbyPoiFeature[] | null>>();
const pointsRequests = new Map<number, Promise<Map<number, LonLat> | null>>();
const rowsRequests = new Map<string, Promise<NearbyRow[] | null>>();

/** JSON по относительному пути; null вместо исключения — блок просто не покажем. */
async function fetchJsonOrNull<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

/** Грубое расстояние от точки до bbox района, метры (0 внутри). */
function distanceToBboxMeters(point: LonLat, bbox: DistrictEntry["bbox"]): number {
  const [west, south, east, north] = bbox;
  const dx = point[0] < west ? west - point[0] : point[0] > east ? point[0] - east : 0;
  const dy = point[1] < south ? south - point[1] : point[1] > north ? point[1] - north : 0;
  return Math.hypot(dx * 62_500, dy * 111_320);
}

function loadManifest(): Promise<DistrictEntry[] | null> {
  manifestRequest ??= fetchJsonOrNull<{
    districts?: DistrictEntry[];
  }>(MANIFEST_URL).then((data) => data?.districts ?? null);
  return manifestRequest;
}

function loadDistrictPois(districtId: number): Promise<NearbyPoiFeature[] | null> {
  let request = poiRequests.get(districtId);
  if (!request) {
    request = fetchJsonOrNull<{ features?: NearbyPoiFeature[] }>(
      `data/districts/${districtId}/poi.geojson`,
    ).then((data) => data?.features ?? null);
    poiRequests.set(districtId, request);
  }
  return request;
}

/** id → координаты дома по району: индексы небольшие, читаем один раз. */
function loadBuildingPoints(
  districtId: number,
): Promise<Map<number, LonLat> | null> {
  let request = pointsRequests.get(districtId);
  if (!request) {
    request = fetchJsonOrNull<BuildingIndexRow[]>(
      `data/districts/${districtId}/buildings-index.json`,
    ).then((rows) => {
      if (!rows) return null;
      const points = new Map<number, LonLat>();
      for (const row of rows) {
        const id = Number(row[0]);
        const lon = Number(row[1]);
        const lat = Number(row[2]);
        if (Number.isFinite(id) && Number.isFinite(lon) && Number.isFinite(lat)) {
          points.set(id, [lon, lat]);
        }
      }
      return points;
    });
    pointsRequests.set(districtId, request);
  }
  return request;
}

/**
 * POI района дома + ближайших районов: у границы ближайшая школа или метро
 * часто «за углом», но уже в соседнем районе — без этого карточка завышала бы
 * расстояние на сотни метров.
 */
async function loadNearbyPois(
  districtId: number,
  point: LonLat,
): Promise<NearbyPoiFeature[] | null> {
  const districts = await loadManifest();
  const districtIds = districts
    ? [...districts]
        .sort(
          (a, b) =>
            distanceToBboxMeters(point, a.bbox) -
            distanceToBboxMeters(point, b.bbox),
        )
        .slice(0, NEARBY_POI_DISTRICTS)
        .map((district) => district.id)
    : [];
  if (!districtIds.includes(districtId)) districtIds.unshift(districtId);
  const lists = await Promise.all(districtIds.map((id) => loadDistrictPois(id)));
  const merged = lists.flatMap((list) => list ?? []);
  return merged.length ? merged : loadDistrictPois(districtId);
}

/**
 * Строки «Рядом» для дома района: пять категорий, расстояния по прямой.
 * null — дом не найден в индексе района или POI не загрузились.
 */
export function loadNearbyRows(
  buildingId: number,
  districtId: number,
): Promise<NearbyRow[] | null> {
  const key = `${districtId}:${buildingId}`;
  let request = rowsRequests.get(key);
  if (!request) {
    request = (async (): Promise<NearbyRow[] | null> => {
      const points = await loadBuildingPoints(districtId);
      const buildingPoint = points?.get(buildingId) ?? null;
      if (!buildingPoint) return null;
      const pois = await loadNearbyPois(districtId, buildingPoint);
      if (!pois) return null;
      return nearbyFromPois(buildingPoint, pois, NEARBY_LABELS);
    })();
    rowsRequests.set(key, request);
    // Сетевую ошибку не кэшируем: следующий выбор дома попробует снова.
    request.then((rows) => {
      if (rows === null) rowsRequests.delete(key);
    });
  }
  return request;
}

/** Район дома пишет движок при выборе; ждём его короткими попытками. */
async function waitForDistrict(
  buildingId: number,
  districtByBuilding: RefObject<Record<number, number>>,
  isCancelled: () => boolean,
): Promise<number | undefined> {
  let districtId = districtByBuilding.current[buildingId];
  for (
    let attempt = 0;
    attempt < DISTRICT_ATTEMPTS && districtId === undefined && !isCancelled();
    attempt += 1
  ) {
    await delay(DISTRICT_WAIT_MS);
    districtId = districtByBuilding.current[buildingId];
  }
  return districtId;
}

/** Строки «Рядом» выбранного дома; null — ещё не посчитаны или данных нет. */
export function useNearbyRows(
  buildingId: number | null,
  districtByBuilding: RefObject<Record<number, number>>,
): NearbyRow[] | null {
  // Строки помнят свой дом: пока считаются новые, отдаём null, а не цифры
  // предыдущего выбора. Цифры одного дома под адресом другого — хуже, чем
  // пустой блок.
  const [loaded, setLoaded] = useState<{
    id: number;
    rows: NearbyRow[] | null;
  } | null>(null);

  useEffect(() => {
    if (buildingId === null) return;
    let cancelled = false;

    const load = async () => {
      const districtId = await waitForDistrict(
        buildingId,
        districtByBuilding,
        () => cancelled,
      );
      if (districtId === undefined) return;
      const rows = await loadNearbyRows(buildingId, districtId);
      if (!cancelled) setLoaded({ id: buildingId, rows });
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [buildingId, districtByBuilding]);

  return loaded !== null && loaded.id === buildingId ? loaded.rows : null;
}
