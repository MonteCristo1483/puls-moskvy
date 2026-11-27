import type { Geometry, Position } from "geojson";
import * as maplibregl from "maplibre-gl";
import { geometryCenter } from "../geo-utils";
import { TREE_MIN_ZOOM } from "./buildings-3d";
import type { GFeature } from "./geometry";
import type { Palette } from "./palette";
import { OVERLAYS_SOURCE } from "./poi";

// ── Подложка (локальный GeoJSON из OSM) ──────────────────────────────────
// Одна фича = один объект; layer: landuse | green | water | river |
// waterway | road. Свойства намеренно минимальны (class, name).
export type BasemapProps = { layer: string; class: string; name?: string };

const BM_LAYER = (layer: string) => ["==", ["get", "layer"], layer] as never;
// Дороги фильтруются по исходному `highway` (свойство roadclass из BM-1):
// class major/minor слишком грубый для «показывать магистрали на обзоре».
const BM_ROADCLASS = (...classes: string[]) =>
  ["all", BM_LAYER("road"), ["match", ["get", "roadclass"], classes, true, false]] as never;
// Классы из pipeline/build_basemap.py (ROAD_CLASSES).
const BM_MAJOR = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
];
const BM_MINOR = [
  "residential",
  "unclassified",
  "living_street",
  "road",
  "service",
  "pedestrian",
];

// Нижние слои подложки: земля, зелень, вода, дороги. Порядок важен —
// здания и оверлеи проекта добавляются выше.
export function basemapLayers(p: Palette): maplibregl.LayerSpecification[] {
  return [
    {
      id: "bm-land",
      type: "background",
      paint: { "background-color": p.land },
    },
    {
      // BM-LOW: на обзоре (z10–11) плоские серые зоны почти не читаются, а
      // полигонов тысячи — рисуем landuse с z12, как раньше.
      id: "bm-landuse",
      type: "fill",
      source: "basemap",
      "source-layer": "landuse",
      minzoom: 12,
      filter: BM_LAYER("landuse"),
      paint: { "fill-color": p.landUse, "fill-opacity": 0.75 },
    },
    {
      id: "bm-green",
      type: "fill",
      source: "basemap",
      "source-layer": "green",
      filter: BM_LAYER("green"),
      paint: {
        "fill-color": ["match", ["get", "class"], "wood", p.wood, p.park],
        "fill-opacity": 0.9,
      },
    },
    {
      // Деревья — точки в park/wood из тайлов overlays.pmtiles (z14+).
      // В плоскости карты (pitch-alignment/scale: map) и три ступени размера по зуму:
      // z < 14.6 / 14.6–16.2 / >= 16.2 — кроны уходят в перспективу и не режутся краем.
      // z15+ — это overzoom тайла z14 (maxzoom источника), сетевых запросов нет.
      id: "bm-trees",
      type: "circle",
      source: OVERLAYS_SOURCE,
      "source-layer": "trees",
      minzoom: TREE_MIN_ZOOM,
      paint: {
        "circle-pitch-alignment": "map",
        "circle-pitch-scale": "map",
        "circle-color": ["match", ["get", "tone"], 1, p.treeDark, p.tree] as never,
        "circle-radius": [
          "step",
          ["zoom"],
          ["*", 2.6, ["get", "size"]],
          14.6,
          ["*", 4.4, ["get", "size"]],
          16.2,
          ["*", 7.2, ["get", "size"]],
        ] as never,
        "circle-stroke-color": p.treeDark,
        "circle-stroke-width": ["step", ["zoom"], 0.5, 14.6, 0.85, 16.2, 1.2] as never,
        "circle-opacity": 0.95,
        "circle-blur": 0.14,
      },
    },
    {
      id: "bm-water",
      type: "fill",
      source: "basemap",
      "source-layer": "water",
      filter: BM_LAYER("water"),
      paint: {
        "fill-color": p.water,
        "fill-outline-color": p.waterLine,
        // BM-LOW: антиалиасинг кромки на обзоре не виден — ниже z13
        // выключен, с z13 как раньше.
        "fill-antialias": ["step", ["zoom"], false, 13, true],
      },
    },
    {
      // Москва-река в OSM — осевая линия, рисуем широкой лентой.
      id: "bm-river",
      type: "line",
      source: "basemap",
      "source-layer": "river",
      filter: BM_LAYER("river"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.water,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 6, 14, 24, 15, 48, 16, 96, 17, 190],
        // BM-LOW: ниже z13 река тонкая, сглаживание кромки не видно — blur 0,
        // с z13 прежние 1.5.
        "line-blur": ["step", ["zoom"], 0, 13, 1.5],
      },
    },
    {
      id: "bm-waterway",
      type: "line",
      source: "basemap",
      "source-layer": "waterway",
      filter: BM_LAYER("waterway"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.waterLine,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.8, 16, 3],
      },
    },
    // Дороги по зумам. Фильтр MapLibre не умеет `zoom`, поэтому классы
    // разложены по слоям с собственным minzoom: на обзоре — только
    // магистрали (motorway/trunk), дворовые улицы появляются с z14.
    // Ширины — прежние кривые: major для motorway…tertiary, minor для
    // residential…pedestrian. Обводки лежат ниже линий и начинаются не
    // раньше своих классов (иначе на z12 видна «дорога без асфальта»).
    {
      id: "bm-road-casing-primary",
      type: "line",
      source: "basemap",
      "source-layer": "road",
      minzoom: 12,
      filter: BM_ROADCLASS("primary", "primary_link", "secondary", "secondary_link"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.roadMajorCasing,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2.8, 14, 5.5, 16, 9.5, 18, 16],
      },
    },
    {
      id: "bm-road-casing-tertiary",
      type: "line",
      source: "basemap",
      "source-layer": "road",
      minzoom: 13,
      filter: BM_ROADCLASS("tertiary", "tertiary_link"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.roadMajorCasing,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2.8, 14, 5.5, 16, 9.5, 18, 16],
      },
    },
    {
      id: "bm-road-casing-minor",
      type: "line",
      source: "basemap",
      "source-layer": "road",
      minzoom: 14,
      filter: BM_ROADCLASS(...BM_MINOR),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.roadCasing,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.6, 14, 3, 16, 5, 18, 7.5],
      },
    },
    {
      id: "bm-road-minor",
      type: "line",
      source: "basemap",
      "source-layer": "road",
      minzoom: 14,
      filter: BM_ROADCLASS(...BM_MINOR),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.roadMinor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.9, 14, 1.9, 16, 3.4, 18, 6],
      },
    },
    {
      id: "bm-road-tertiary",
      type: "line",
      source: "basemap",
      "source-layer": "road",
      minzoom: 13,
      filter: BM_ROADCLASS("tertiary", "tertiary_link"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.roadMajor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.6, 14, 3.4, 16, 6.2, 18, 11],
      },
    },
    {
      id: "bm-road-secondary",
      type: "line",
      source: "basemap",
      "source-layer": "road",
      minzoom: 12,
      filter: BM_ROADCLASS("secondary", "secondary_link"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.roadMajor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.6, 14, 3.4, 16, 6.2, 18, 11],
      },
    },
    {
      id: "bm-road-primary",
      type: "line",
      source: "basemap",
      "source-layer": "road",
      minzoom: 10,
      filter: BM_ROADCLASS("primary", "primary_link"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.roadMajor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.6, 14, 3.4, 16, 6.2, 18, 11],
      },
    },
    {
      // z < 10: единственный класс дорог в кадре — магистрали, без обводки.
      id: "bm-road-motorway",
      type: "line",
      source: "basemap",
      "source-layer": "road",
      minzoom: 0,
      filter: BM_ROADCLASS("motorway", "motorway_link", "trunk", "trunk_link"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.roadMajor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.6, 14, 3.4, 16, 6.2, 18, 11],
      },
    },
    {
      // Осевая разметка на магистралях: белый пунктир вдоль готовой
      // геометрии дороги, не отдельные объекты.
      id: "bm-road-marking",
      type: "line",
      source: "basemap",
      "source-layer": "road",
      minzoom: 13,
      filter: BM_ROADCLASS(...BM_MAJOR),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.roadMark,
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.6, 16, 1.2, 18, 1.8],
        "line-opacity": 0.7,
        "line-dasharray": [2, 4],
      },
    },
  ];
}

// Цвета подложки, которые меняются при переключении темы.
// Данные те же — перекрашиваем только paint.
export function basemapPaint(p: Palette): Record<string, Record<string, unknown>> {
  return {
    "bm-land": { "background-color": p.land },
    "bm-landuse": { "fill-color": p.landUse },
    "bm-green": { "fill-color": ["match", ["get", "class"], "wood", p.wood, p.park] },
    "bm-trees": {
      "circle-color": ["match", ["get", "tone"], 1, p.treeDark, p.tree],
      "circle-stroke-color": p.treeDark,
    },
    "bm-water": { "fill-color": p.water, "fill-outline-color": p.waterLine },
    "bm-river": { "line-color": p.water },
    "bm-waterway": { "line-color": p.waterLine },
    "bm-road-casing-primary": { "line-color": p.roadMajorCasing },
    "bm-road-casing-tertiary": { "line-color": p.roadMajorCasing },
    "bm-road-casing-minor": { "line-color": p.roadCasing },
    "bm-road-minor": { "line-color": p.roadMinor },
    "bm-road-tertiary": { "line-color": p.roadMajor },
    "bm-road-secondary": { "line-color": p.roadMajor },
    "bm-road-primary": { "line-color": p.roadMajor },
    "bm-road-motorway": { "line-color": p.roadMajor },
    "bm-road-marking": { "line-color": p.roadMark },
    "glow-outer": { "circle-color": p.selected },
    "glow-inner": { "circle-color": p.selected },
    "buildings-shadow-1": { "fill-color": p.shadow },
    "buildings-shadow-2": { "fill-color": p.shadow },
    "buildings-shadow-3": { "fill-color": p.shadow },
  };
}

// Подписи подложки — DOM-маркеры, а не symbol-слой: не нужны глиф-серверы
// и PBF-шрифты (экономия первой загрузки), текст крисп на Retina.
export type LabelCandidate = {
  name: string;
  kind: "street" | "water" | "park";
  importance: number;
  a: Position;
  b: Position;
};

function longestSegment(geom: Geometry): { a: Position; b: Position } | null {
  let lines: Position[][] = [];
  if (geom.type === "LineString") lines = [geom.coordinates];
  else if (geom.type === "MultiLineString") lines = geom.coordinates;
  else return null;
  let best: { a: Position; b: Position; score: number } | null = null;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const dLat = b[1] - a[1];
      const dLon = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
      const score = dLat * dLat + dLon * dLon;
      if (!best || score > best.score) best = { a, b, score };
    }
  }
  return best;
}

/**
 * PERF-3-TILECACHE: bbox геометрии пересекается с окном подписей.
 * Нужна, чтобы из большого тайлового кэша (600 тайлов) в
 * buildLabelCandidates шли только фичи вокруг текущего экрана.
 */
export function geometryInBounds(
  geometry: Geometry,
  west: number,
  south: number,
  east: number,
  north: number,
): boolean {
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.some((g) => geometryInBounds(g, west, south, east, north));
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    const [x, y] = coords;
    if (typeof x === "number" && typeof y === "number") {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      return;
    }
    for (const child of coords) visit(child);
  };
  visit((geometry as { coordinates?: unknown }).coordinates);
  return maxX >= west && minX <= east && maxY >= south && minY <= north;
}

// Декоративные деревья в park и wood больше не генерируются в клиенте:
// точки приходят из тайлов overlays.pmtiles (source-layer "trees", z15+).

export function buildLabelCandidates(features: GFeature<BasemapProps>[]): LabelCandidate[] {
  const byName: Record<string, LabelCandidate> = {};
  const put = (key: string, candidate: LabelCandidate) => {
    const prev = byName[key];
    if (!prev || candidate.importance > prev.importance) byName[key] = candidate;
  };
  for (const f of features) {
    const { layer, class: cls, name } = f.properties;
    if (!name) continue;
    if (layer === "road") {
      if (cls !== "major" && cls !== "minor") continue;
      const seg = longestSegment(f.geometry);
      if (!seg) continue;
      const dLat = seg.b[1] - seg.a[1];
      const dLon = (seg.b[0] - seg.a[0]) * Math.cos((seg.a[1] * Math.PI) / 180);
      const length = Math.hypot(dLat, dLon);
      if (length < 0.00025) continue; // короче ~30 м подпись не нужна
      put(`street:${name}`, {
        name,
        kind: "street",
        importance: (cls === "major" ? 3 : 1) + Math.min(2, length * 100),
        a: seg.a,
        b: seg.b,
      });
    } else if (layer === "river") {
      const seg = longestSegment(f.geometry);
      if (seg) put(`water:${name}`, { name, kind: "water", importance: 2.5, a: seg.a, b: seg.b });
    } else if (layer === "water") {
      const c = geometryCenter(f.geometry);
      if (c) put(`water:${name}`, { name, kind: "water", importance: 1.8, a: c, b: c });
    } else if (layer === "green" && cls === "park") {
      const c = geometryCenter(f.geometry);
      if (c) put(`park:${name}`, { name, kind: "park", importance: 0.6, a: c, b: c });
    }
  }
  return Object.values(byName);
}
