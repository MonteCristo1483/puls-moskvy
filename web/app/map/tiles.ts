import type { Position } from "geojson";
import { Protocol } from "pmtiles";
import type { BuildingBreakdown } from "../building-sheet";

// Пути относительные — статический экспорт живёт в подпапке
// basePath (/puls-moskvy на GitHub Pages).
export const BUILDINGS_URL = "data/buildings.pmtiles";
export const BASEMAP_URL = "data/basemap.pmtiles";
// Красные зоны, POI и деревья — единые тайлы на всю Москву (z8–16).
export const OVERLAYS_URL = "data/overlays.pmtiles";
export const MANIFEST_URL = "data/districts/manifest.json";
export const INDEX_URL = "data/index.json.gz";

// Протокол pmtiles регистрируем один раз за жизнь вкладки. Не на уровне
// модуля: static export пререндерится в Node, где нет window и MapLibre.
let pmtilesProtocol: Protocol | null = null;

// RAM-кэш готовых тайлов: MapLibre может попросить один и тот же тайл
// повторно (overzoom, возврат в просмотренную область, смена темы), а
// фоновый префетчер — заранее. Храним промисы, чтобы параллельные запросы
// одного тайла не дублировали сеть. Порядок вставки в Map = порядок LRU.
const MAX_RAM_TILES = 1800;
export const pmtilesRamCache = new globalThis.Map<string, Promise<ArrayBuffer>>();

// Новый экспорт сжимает индекс, маршруты и изохроны как gzip-файлы,
// а не HTTP Content-Encoding. Используем встроенный браузерный декодер.
export async function fetchGzipJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} по ${url}`);
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Браузер не поддерживает gzip-декодирование");
  }
  const compressed = await res.arrayBuffer();
  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).json()) as T;
}

export function getPmtilesProtocol(): Protocol {
  if (!pmtilesProtocol) pmtilesProtocol = new Protocol();
  return pmtilesProtocol;
}

// Копия тайла в отдельный ArrayBuffer. pmtiles отдаёт Uint8Array поверх
// буфера архива/декодера: такой буфер нельзя надолго оставлять в кэше и
// нельзя отдавать в MapLibre напрямую — тот передаёт данные в Web Worker
// через transfer и отсоединяет (detach) буфер.
function cloneTileBytes(data: unknown): ArrayBuffer {
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy.buffer;
  }
  if (data instanceof ArrayBuffer) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data));
    return copy.buffer;
  }
  // Пустой тайл (нет данных на этих координатах) — валидный ответ протокола.
  return new ArrayBuffer(0);
}

// Единственная точка загрузки тайла: RAM-кэш → Protocol.tile → RAM-кэш.
// Возвращённый промис резолвится в «живой» (не отсоединённый) ArrayBuffer.
export function fetchPmtilesTile(tileUrl: string): Promise<ArrayBuffer> {
  const cached = pmtilesRamCache.get(tileUrl);
  if (cached) {
    // LRU: освежаем позицию ключа, чтобы он не вылетел первым.
    pmtilesRamCache.delete(tileUrl);
    pmtilesRamCache.set(tileUrl, cached);
    return cached;
  }
  const pending = getPmtilesProtocol()
    .tile({ url: tileUrl, type: "arrayBuffer" } as never, new AbortController())
    .then((res) => cloneTileBytes((res as { data?: unknown }).data));
  pmtilesRamCache.set(tileUrl, pending);
  while (pmtilesRamCache.size > MAX_RAM_TILES) {
    const oldest = pmtilesRamCache.keys().next();
    if (oldest.done) break;
    pmtilesRamCache.delete(oldest.value);
  }
  // Сетевую ошибку не кэшируем: следующий запрос повторит загрузку.
  pending.catch(() => {
    if (pmtilesRamCache.get(tileUrl) === pending) pmtilesRamCache.delete(tileUrl);
  });
  return pending;
}

export type DistrictEntry = {
  id: number;
  name: string;
  bbox: [number, number, number, number];
};

export type DistrictManifest = {
  v: number;
  index: { role: string; path: string };
  districts: DistrictEntry[];
};

export type CompactSearchIndex = {
  v: number;
  ids: number[];
  lon: number[];
  lat: number[];
  addr: (string | null)[];
};
// Пешие маршруты (Valhalla) — файл на здание, грузится при выборе.
export type BuildingRoutes = {
  categories: Record<
    string,
    { minutes: number; distance_m: number; geometry: { type: "LineString"; coordinates: Position[] } }
  >;
  // Шаг B1: разбивка индекса теперь лежит рядом с маршрутами, а не в тайлах.
  breakdown?: BuildingBreakdown;
};
export type FlatRoutes = Record<string, { minutes: number; coordinates: Position[] }>;
export const ROUTES_URL = (districtId: number, shard: number) =>
  `data/routes/${districtId}/${shard}.json.gz`;
export const ISOCHRONE_URL = (districtId: number, shard: number) =>
  `data/isochrones/${districtId}/${shard}.json.gz`;
// Изохроны 5/10/15 минут — шард выбранного района.
export type IsoGeometry = { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
export type IsochroneData = Record<string, IsoGeometry>;

export type BuildingProps = {
  id: number;
  index?: number;
  address?: string;
  year?: number | null;
  is_home?: boolean | number | string;
  breakdown?: BuildingBreakdown | string;
};

// Метаданные из компактного индекса и выбранного vector feature.
export type BuildingMeta = {
  id: number;
  center: [number, number] | null;
  address: string | null;
  index: number | null;
  year: number | null;
  isHome?: boolean;
};
