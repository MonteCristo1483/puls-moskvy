import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import * as maplibregl from "maplibre-gl";
import type { Theme } from "../theme";
import { buildQuadRing, footprintAreaM2, outsetPolygonRing } from "./geometry";
import type { HeroFacadeEdge } from "./geometry";
import { DEFAULT_COLOR_STOPS, MAP_THEMES, mixHex } from "./palette";
import type { ColorStops, Palette } from "./palette";

// Мягкая многослойная тень под домами (3 слоя со сдвигом [3,3]..[6,6], плавно с z >= 14.8):
// убирает эффект «парящих» коробок на z15–16 без z-fighting и двойных кромок.
export const BUILDING_SHADOW_LAYERS = [
  { id: "buildings-shadow-1", translate: [3, 3] as [number, number], opacity: { light: 0.1, dark: 0.16 } },
  { id: "buildings-shadow-2", translate: [4.5, 4.5] as [number, number], opacity: { light: 0.08, dark: 0.12 } },
  { id: "buildings-shadow-3", translate: [6, 6] as [number, number], opacity: { light: 0.05, dark: 0.08 } },
] as const;

export const buildingShadowOpacityExpr = (maxOpacity: number) =>
  [
    "interpolate",
    ["linear"],
    ["zoom"],
    BUILDING_SHADOW_MIN_ZOOM,
    0,
    15.0,
    Number((maxOpacity * 0.35).toFixed(4)),
    16.0,
    maxOpacity,
  ] as never;

export const NON_HOME_DIM_MIN_ZOOM = 13.5;
// Дома видны с z13 плоскими: тайлы z13 уже приходят вместе с подложкой,
// поэтому полоса роста 13→15 начинается раньше, чем подъезжает z14.
// Раньше слои включались на z14 до прихода тайлов — было видно
// «пусто → заминка → сразу полная высота». Механизм роста не менялся.
export const BUILDING_MIN_ZOOM = 13;
const BUILDING_GROW_MAX_ZOOM = 15;
// Тени (3 плоских fill по всем домам) — плавно проявляются с z14.8 к z16.
export const BUILDING_SHADOW_MIN_ZOOM = 14.8;
// Декоративные деревья — с z14.5: тайлы overlays нарезаны до z14 (trees уже
// внутри z14), дальше MapLibre надстраивает их overzoom'ом без сети.
export const TREE_MIN_ZOOM = 14.5;
// Подписи улиц/воды/парков — с z12.6 (см. rebuildLabels). Ниже этого зума
// декорации подложки не видны, значит их кандидатов можно не собирать:
// именно сбор (querySourceFeatures по всей подложке) ронял обзор z10–11.
export const DECOR_MIN_ZOOM = 12.6;

export const buildingExtrusionHeightExpr = () =>
  [
    "interpolate",
    ["linear"],
    ["zoom"],
    BUILDING_MIN_ZOOM,
    0,
    BUILDING_GROW_MAX_ZOOM,
    [
      "case",
      ["to-boolean", ["feature-state", "selected"]],
      0,
      ["coalesce", ["get", "height"], 9],
    ],
  ] as never;

export const buildingRoofBaseExpr = () =>
  [
    "interpolate",
    ["linear"],
    ["zoom"],
    BUILDING_MIN_ZOOM,
    0,
    BUILDING_GROW_MAX_ZOOM,
    [
      "case",
      ["to-boolean", ["feature-state", "selected"]],
      0,
      ["coalesce", ["get", "height"], 9],
    ],
  ] as never;

export const buildingRoofHeightExpr = () =>
  [
    "interpolate",
    ["linear"],
    ["zoom"],
    BUILDING_MIN_ZOOM,
    0,
    BUILDING_GROW_MAX_ZOOM,
    [
      "case",
      ["to-boolean", ["feature-state", "selected"]],
      0,
      ["+", ["coalesce", ["get", "height"], 9], 0.5],
    ],
  ] as never;

const isNonHomeBuildingExpr = () => [
  "any",
  ["==", ["get", "is_home"], false],
  ["!", ["has", "index"]],
];

const stepColorsExpr = (p: Palette, s: ColorStops | null, lighten = 0) => {
  const stops = s ?? DEFAULT_COLOR_STOPS;
  const tone = (c: string) => (lighten > 0 ? mixHex(c, "#ffffff", lighten) : c);
  return [
    "step",
    ["coalesce", ["get", "index"], stops.mid],
    tone(p.vlow),
    stops.t1,
    tone(p.low),
    stops.t2,
    tone(p.mid),
    stops.t3,
    tone(p.high),
    stops.t4,
    tone(p.vhigh),
  ];
};

export const selectedStepColorsExpr = (p: Palette, s: ColorStops | null, lighten = 0) => {
  const stops = s ?? DEFAULT_COLOR_STOPS;
  const tone = (c: string) => (lighten > 0 ? mixHex(c, "#ffffff", lighten) : c);
  return [
    "step",
    ["coalesce", ["get", "index"], stops.mid],
    tone(p.selectedVlow),
    stops.t1,
    tone(p.selectedLow),
    stops.t2,
    tone(p.selectedMid),
    stops.t3,
    tone(p.selectedHigh),
    stops.t4,
    tone(p.selectedVhigh),
  ];
};

const roofStepColorsExpr = (p: Palette, s: ColorStops | null) => {
  const stops = s ?? DEFAULT_COLOR_STOPS;
  return [
    "step",
    ["coalesce", ["get", "index"], stops.mid],
    p.roofVlow,
    stops.t1,
    p.roofLow,
    stops.t2,
    p.roofMid,
    stops.t3,
    p.roofHigh,
    stops.t4,
    p.roofVhigh,
  ];
};

const buildingColorAtZoomExpr = (
  p: Palette,
  s: ColorStops | null,
  selectedColor: string | null,
  otherColor: string,
) => {
  const stepExpr = stepColorsExpr(p, s, 0);
  const selectedStepExpr = selectedStepColorsExpr(p, s, 0);
  return [
    "case",
    ["to-boolean", ["feature-state", "selected"]],
    selectedColor ?? selectedStepExpr,
    isNonHomeBuildingExpr(),
    otherColor,
    stepExpr,
  ];
};

export const buildingColorExpr = (
  p: Palette,
  s: ColorStops | null,
  selectedColor: string | null = null,
) =>
  [
    "step",
    ["zoom"],
    buildingColorAtZoomExpr(p, s, selectedColor, p.otherOverview),
    NON_HOME_DIM_MIN_ZOOM,
    buildingColorAtZoomExpr(p, s, selectedColor, p.other),
  ] as never;

// Крыши жилых домов — 5 ступеней V4b2a; нежилых — холодный нейтральный тон
// (с дополнительным приглушением на z >= 15.5); у выбранного — яркая ступень.
const buildingRoofColorAtZoomExpr = (
  p: Palette,
  s: ColorStops | null,
  roofOtherColor: string,
) => {
  const roofStepExpr = roofStepColorsExpr(p, s);
  const selectedRoofStepExpr = selectedStepColorsExpr(p, s, 0.05);
  return [
    "case",
    ["to-boolean", ["feature-state", "selected"]],
    selectedRoofStepExpr,
    isNonHomeBuildingExpr(),
    roofOtherColor,
    roofStepExpr,
  ];
};

export const buildingRoofColorExpr = (p: Palette, s: ColorStops | null) =>
  [
    "step",
    ["zoom"],
    buildingRoofColorAtZoomExpr(p, s, p.roofOtherOverview),
    NON_HOME_DIM_MIN_ZOOM,
    buildingRoofColorAtZoomExpr(p, s, p.roofOther),
  ] as never;

export function buildRoofEdgeFeatures(
  features: maplibregl.GeoJSONFeature[],
  zoom: number,
): Feature[] {
  // ~1.5 px в метрах на текущем зуме (на широте Москвы 55.756°).
  const metersPerPx = (156543.03 * Math.cos((55.756 * Math.PI) / 180)) / Math.pow(2, zoom);
  const outsetMeters = Math.max(0.26, Math.min(1.8, metersPerPx * 1.15));
  const out: Feature[] = [];
  const seen = new Set<string>();

  const pushPolygon = (
    outerRing: Position[],
    id: string | number | undefined,
    height: number,
  ) => {
    if (!outerRing || outerRing.length < 4) return;
    const p0 = outerRing[0];
    const key = `${outerRing.length}:${p0[0]?.toFixed(5)},${p0[1]?.toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const expandedRing = outsetPolygonRing(outerRing, outsetMeters);
    if (!expandedRing) return;
    out.push({
      type: "Feature",
      id,
      properties: { id, height },
      geometry: {
        type: "Polygon",
        coordinates: [expandedRing],
      },
    });
  };

  for (const f of features) {
    const geom = f.geometry;
    const id = f.id ?? f.properties?.id;
    const height = Number(f.properties?.height ?? 9);
    if (geom.type === "Polygon") {
      pushPolygon(geom.coordinates[0], id, height);
    } else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates) {
        pushPolygon(poly[0], id, height);
      }
    }
  }
  return out;
}

// ── V4b4: Hero-окна выбранного дома (настоящие 3D-квады fill-extrusion по фасадам) ──
const HERO_WIN_MIN_EDGE_M = 3.0;
const HERO_WIN_CORNER_MARGIN_M = 0.2;
const HERO_WIN_STEP_MIN_M = 2.4;
const HERO_WIN_STEP_MAX_M = 3.0;
const HERO_WIN_STEP_DEFAULT_M = 2.68;
const HERO_FLOOR_FIRST_M = 1.0;
const HERO_FLOOR_STEP_M = 3.0;
const HERO_MAX_FLOORS = 30;
const HERO_MAX_TOTAL_POLYGONS = 2000;
const HERO_MAX_WINDOW_CELLS = 1200;
const HERO_HALO_SCALE = 1.2;

export const HERO_WINDOW_LAYER_ID = "buildings-selected-windows";
export const HERO_HALO_LAYER_ID = "buildings-selected-windows-halo";
export const HERO_WINDOWS_SOURCE_ID = "selectedWindows";

// V4b5: санитарный порог площади. Если после сборки частей контур вышел
// меньше ~150 м² у дома в 5+ этажей — это почти наверняка обрезок тайла:
// окна на нём не строим (лучше без окон, чем окна на невидимой грани).
const HERO_MIN_FOOTPRINT_AREA_M2 = 150;
const HERO_MIN_FLOORS_FOR_AREA_CHECK = 5;

function resolveSelectedBodyColor(
  theme: Theme,
  indexVal: number | null | undefined,
  s: ColorStops | null,
): string {
  const p = MAP_THEMES[theme];
  if (theme === "dark") return p.selectedBody;
  const stops = s ?? DEFAULT_COLOR_STOPS;
  const idx =
    typeof indexVal === "number" && Number.isFinite(indexVal) ? indexVal : stops.mid;
  if (idx < stops.t1) return p.selectedVlow;
  if (idx < stops.t2) return p.selectedLow;
  if (idx < stops.t3) return p.selectedMid;
  if (idx < stops.t4) return p.selectedHigh;
  return p.selectedVhigh;
}

export function buildSelectedWindowFeatures(
  features: maplibregl.GeoJSONFeature[],
  colorStops: ColorStops | null,
  includeHalo: boolean,
): FeatureCollection {
  const edges: HeroFacadeEdge[] = [];
  const bodyOccluders: Feature[] = [];
  const seenRings = new Set<string>();

  const collectRingEdges = (
    ring: Position[],
    isHole: boolean,
    floors: number,
    buildingHeight: number,
    buildingId: number,
  ) => {
    const pts: [number, number][] = [];
    for (const pt of ring) {
      const lon = pt[0];
      const lat = pt[1];
      if (typeof lon !== "number" || typeof lat !== "number") continue;
      const prev = pts[pts.length - 1];
      if (!prev || Math.hypot(lon - prev[0], lat - prev[1]) > 1e-7) {
        pts.push([lon, lat]);
      }
    }
    if (pts.length > 1) {
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-7) {
        pts.pop();
      }
    }
    const n = pts.length;
    if (n < 3) return;

    const ringKey = `${isHole ? "H" : "O"}:${n}:${pts[0][0].toFixed(5)},${pts[0][1].toFixed(5)}`;
    if (seenRings.has(ringKey)) return;
    seenRings.add(ringKey);

    const lon0 = pts[0][0];
    const lat0 = pts[0][1];
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 110574;
    const local: [number, number][] = pts.map(([lon, lat]) => [
      (lon - lon0) * kx,
      (lat - lat0) * ky,
    ]);

    let signedArea2 = 0;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = local[i];
      const [x2, y2] = local[(i + 1) % n];
      signedArea2 += x1 * y2 - x2 * y1;
    }
    if (Math.abs(signedArea2) * 0.5 < 1.5) return;

    // Нормаль наружу от стены здания: для внешнего контура — наружу полигона,
    // для внутреннего двора (hole) — внутрь двора (наружу от стены дома).
    const baseSign = signedArea2 >= 0 ? -1 : 1;
    const sign = isHole ? -baseSign : baseSign;

    for (let i = 0; i < n; i++) {
      const [x1, y1] = local[i];
      const [x2, y2] = local[(i + 1) % n];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < HERO_WIN_MIN_EDGE_M) continue;
      edges.push({
        lon0,
        lat0,
        kx,
        ky,
        x1,
        y1,
        tx: dx / len,
        ty: dy / len,
        nx: (-sign * dy) / len,
        ny: (sign * dx) / len,
        len,
        floors,
        buildingHeight,
        buildingId,
      });
    }
  };

  for (const f of features) {
    const rawId = f.id ?? f.properties?.id ?? 1;
    const buildingId =
      typeof rawId === "number" && Number.isFinite(rawId) ? rawId : Number(rawId) || 1;
    const buildingHeight = Math.max(0, Number(f.properties?.height ?? 9));
    const indexVal =
      typeof f.properties?.index === "number" ? f.properties.index : Number(f.properties?.index);
    const bodyColorLight = resolveSelectedBodyColor("light", indexVal, colorStops);
    const bodyColorDark = resolveSelectedBodyColor("dark", indexVal, colorStops);

    const insetGeometry = (geom: Geometry): Geometry => {
      if (geom.type === "Polygon") {
        const outer = outsetPolygonRing(geom.coordinates[0], -0.12) ?? geom.coordinates[0];
        return { type: "Polygon", coordinates: [outer, ...geom.coordinates.slice(1)] };
      }
      if (geom.type === "MultiPolygon") {
        return {
          type: "MultiPolygon",
          coordinates: geom.coordinates.map((poly) => {
            const outer = outsetPolygonRing(poly[0], -0.12) ?? poly[0];
            return [outer, ...poly.slice(1)];
          }),
        };
      }
      return geom;
    };

    bodyOccluders.push({
      type: "Feature",
      properties: {
        kind: "body",
        base: 0,
        height: buildingHeight,
        colorLight: bodyColorLight,
        colorDark: bodyColorDark,
      },
      geometry: insetGeometry(f.geometry),
    });

    const floors = Math.min(
      HERO_MAX_FLOORS,
      Math.max(0, Math.floor((buildingHeight - HERO_FLOOR_FIRST_M) / HERO_FLOOR_STEP_M)),
    );
    if (floors <= 0) continue;

    const footprintArea = footprintAreaM2(f.geometry);
    if (
      footprintArea < HERO_MIN_FOOTPRINT_AREA_M2 &&
      floors >= HERO_MIN_FLOORS_FOR_AREA_CHECK
    ) {
      console.warn(
        `Hero-окна: контур дома ${buildingId} подозрительно мал ` +
          `(${footprintArea.toFixed(0)} м² при ${floors} этажах) — окна не строим.`,
      );
      continue;
    }

    const geom = f.geometry;
    if (geom.type === "Polygon") {
      for (let rIdx = 0; rIdx < geom.coordinates.length; rIdx++) {
        collectRingEdges(geom.coordinates[rIdx], rIdx > 0, floors, buildingHeight, buildingId);
      }
    } else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates) {
        for (let rIdx = 0; rIdx < poly.length; rIdx++) {
          collectRingEdges(poly[rIdx], rIdx > 0, floors, buildingHeight, buildingId);
        }
      }
    }
  }

  if (!edges.length) {
    return { type: "FeatureCollection", features: [] };
  }

  const colsForStep = (len: number, targetStep: number, minStep: number): number => {
    const usable = Math.max(0, len - 2 * HERO_WIN_CORNER_MARGIN_M);
    if (usable < HERO_WIN_MIN_EDGE_M - 2 * HERO_WIN_CORNER_MARGIN_M) return 0;
    const maxCols = Math.max(1, Math.floor(usable / minStep));
    const est = Math.max(1, Math.round(usable / targetStep));
    return Math.min(maxCols, est);
  };

  let targetStep = HERO_WIN_STEP_DEFAULT_M;
  let minStep = HERO_WIN_STEP_MIN_M;
  let maxStep = HERO_WIN_STEP_MAX_M;

  const countTotalCells = (step: number, mStep: number) =>
    edges.reduce((acc, e) => acc + colsForStep(e.len, step, mStep) * e.floors, 0);

  let totalCells = countTotalCells(targetStep, minStep);
  if (totalCells > HERO_MAX_WINDOW_CELLS) {
    const scale = totalCells / HERO_MAX_WINDOW_CELLS;
    targetStep *= scale;
    minStep *= scale;
    maxStep *= scale;
    while (countTotalCells(targetStep, minStep) > HERO_MAX_WINDOW_CELLS) {
      targetStep *= 1.08;
      minStep *= 1.08;
      maxStep *= 1.08;
    }
  }

  let seed = ((edges[0].buildingId * 2654435761) >>> 0) || 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  type RawWinSpec = {
    edge: HeroFacadeEdge;
    sCenter: number;
    winWidth: number;
    winHeight: number;
    winBase: number;
    winTop: number;
    score: number;
    toneT: number;
    aptToneT: number;
  };

  const specs: RawWinSpec[] = [];
  const widthChoices = [1.26, 1.38, 1.48, 1.56] as const;

  for (const edge of edges) {
    const cols = colsForStep(edge.len, targetStep, minStep);
    if (cols <= 0) continue;
    const usable = edge.len - 2 * HERO_WIN_CORNER_MARGIN_M;
    const actualStep = Math.min(maxStep, Math.max(minStep, usable / cols));
    const totalSpan = cols * actualStep;
    const startOffset = (edge.len - totalSpan) * 0.5;

    // Разбиваем колонки фасада на квартиры по 2–3 соседних окна (кластерный рисунок).
    const colAptGroup: number[] = [];
    const colWidths: number[] = [];
    let aptId = 0;
    let inApt = 0;
    let aptLen = rnd() < 0.52 ? 2 : 3;
    for (let c = 0; c < cols; c++) {
      if (inApt >= aptLen) {
        aptId++;
        inApt = 0;
        aptLen = rnd() < 0.52 ? 2 : 3;
      }
      inApt++;
      colAptGroup.push(aptId);
      const rawW = widthChoices[(c + Math.floor(rnd() * 2)) % widthChoices.length];
      colWidths.push(Math.min(1.6, Math.max(1.2, Math.min(rawW, actualStep - 0.55))));
    }
    const numApts = aptId + 1;
    const aptVertBias = Array.from({ length: numApts }, () => (rnd() - 0.5) * 0.22);

    for (let r = 0; r < edge.floors; r++) {
      const winHeight = r === 0 ? 1.68 : 1.74;
      const winBase = HERO_FLOOR_FIRST_M + r * HERO_FLOOR_STEP_M + 0.16;
      const winTop = Math.min(edge.buildingHeight - 0.15, winBase + winHeight);
      if (winTop - winBase < 0.8) continue;

      const aptFloorScore: number[] = [];
      const aptFloorTone: number[] = [];
      for (let a = 0; a < numApts; a++) {
        aptFloorScore.push(rnd() * 0.88 + aptVertBias[a]);
        aptFloorTone.push(rnd());
      }

      for (let c = 0; c < cols; c++) {
        const sCenter = startOffset + (c + 0.5) * actualStep;
        const g = colAptGroup[c];
        // Сильная кластеризация по квартире (2–3 соседних окна горят или гаснут вместе).
        const score = aptFloorScore[g] + (rnd() - 0.5) * 0.14;
        specs.push({
          edge,
          sCenter,
          winWidth: colWidths[c],
          winHeight: winTop - winBase,
          winBase,
          winTop,
          score,
          toneT: rnd(),
          aptToneT: aptFloorTone[g],
        });
      }
    }
  }

  if (!specs.length) {
    return { type: "FeatureCollection", features: [] };
  }

  // Ночью строго 45–55% горящих окон (цель 50%).
  const targetLitRatio = 0.5;
  const sortedScores = specs.map((s) => s.score).sort((a, b) => a - b);
  const thresholdIdx = Math.min(
    sortedScores.length - 1,
    Math.max(0, Math.floor(sortedScores.length * (1 - targetLitRatio))),
  );
  const litThreshold = sortedScores[thresholdIdx];

  const outFeatures: Feature[] = [...bodyOccluders];

  for (const sp of specs) {
    const isLit = sp.score >= litThreshold;
    const blendT = Math.min(1, Math.max(0, sp.aptToneT * 0.65 + sp.toneT * 0.35));

    const winColorLight = mixHex("#d4b795", "#e3c7a5", blendT);
    const winColorDark = isLit
      ? mixHex("#ffc978", "#ffd79a", blendT)
      : mixHex("#16263c", "#1b2e4a", sp.toneT);

    const halfW = sp.winWidth * 0.5;
    const s0 = Math.max(HERO_WIN_CORNER_MARGIN_M, sp.sCenter - halfW);
    const s1 = Math.min(sp.edge.len - HERO_WIN_CORNER_MARGIN_M, sp.sCenter + halfW);
    if (s1 - s0 < 0.4) continue;

    outFeatures.push({
      type: "Feature",
      properties: {
        kind: "window",
        base: Number(sp.winBase.toFixed(2)),
        height: Number(sp.winTop.toFixed(2)),
        colorLight: winColorLight,
        colorDark: winColorDark,
        lit: isLit,
      },
      geometry: {
        type: "Polygon",
        coordinates: [buildQuadRing(sp.edge, s0, s1, 0.025, 0.085)],
      },
    });

    if (includeHalo && isLit && outFeatures.length < HERO_MAX_TOTAL_POLYGONS) {
      const haloHalfW = sp.winWidth * HERO_HALO_SCALE * 0.5;
      const hs0 = Math.max(HERO_WIN_CORNER_MARGIN_M * 0.75, sp.sCenter - haloHalfW);
      const hs1 = Math.min(
        sp.edge.len - HERO_WIN_CORNER_MARGIN_M * 0.75,
        sp.sCenter + haloHalfW,
      );
      const zMid = (sp.winBase + sp.winTop) * 0.5;
      const haloHalfH = sp.winHeight * HERO_HALO_SCALE * 0.5;
      const haloBase = Math.max(HERO_FLOOR_FIRST_M * 0.9, zMid - haloHalfH);
      const haloTop = Math.min(sp.edge.buildingHeight - 0.06, zMid + haloHalfH);

      outFeatures.push({
        type: "Feature",
        properties: {
          kind: "halo",
          base: Number(haloBase.toFixed(2)),
          height: Number(haloTop.toFixed(2)),
          colorLight: winColorLight,
          colorDark: winColorDark,
          lit: true,
        },
        geometry: {
          type: "Polygon",
          coordinates: [buildQuadRing(sp.edge, hs0, hs1, 0.015, 0.075)],
        },
      });
    }
  }

  return {
    type: "FeatureCollection",
    features: outFeatures,
  };
}

// ── Окна на фасадах: pattern-текстуры, сгенерированные в runtime ─────────
// V4b3: спокойные фасады без оконной сетки-решётки:
// - Обычные дома днём: чистая плоская база цвета ступени (только вертикальный градиент MapLibre).
// - Обычные дома ночью: тёмно-синяя база ступени + только редкие горящие окна (5–8%)
//   тёплым янтарём (#ffc978…#ffd79a), мелкие (2–5 px), без негорящей решётки и швов.
// - Выбранный дом: в светлой теме — кремовые окна светлее фасада без тёмной сетки,
//   в тёмной теме — тёплые янтарные окна без синей решётки негорящих рам.
const FACADE_SIZE = 384;
const FACADE_FLAT_SIZE = 16;
export const FACADE_COARSE_MIN_ZOOM = 15.4;
const FACADE_MID_MIN_ZOOM = 16.0;
const FACADE_FINE_MIN_ZOOM = 17;
export const FACADE_SELECT_ZOOM = 16.6;
// V4b6: неоновое свечение у основания выбранного дома (только тёмная тема).
// Три обводки по footprint на земле + яркая кромка + подсветка низа стен.
// Ширина и прозрачность интерполируются по зуму, чтобы свечение не «худело»
// при приближении: на 15.4 — ×0.8, на 18 — ×1.3.
export const GLOW_GROUND_COLOR = "#2ee6a0";
export const GLOW_EDGE_COLOR = "#7dffcf";
export const GLOW_RINGS = [
  { id: "glow-ground-1", width: 14, blur: 8, opacity: 0.34 },
  { id: "glow-ground-2", width: 34, blur: 20, opacity: 0.2 },
  { id: "glow-ground-3", width: 72, blur: 40, opacity: 0.1 },
] as const;
export const GLOW_BASE_LAYER_ID = "glow-base-walls";
export const GLOW_EDGE_LAYER_ID = "glow-ground-edge";

export function glowZoomScale(base: number): unknown[] {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    FACADE_COARSE_MIN_ZOOM,
    base * 0.8,
    FACADE_SELECT_ZOOM,
    base,
    18,
    base * 1.3,
  ];
}

// В светлой теме свечение едва заметно (максимум ~0.08 суммарно).
export function glowRingOpacity(base: number, theme: Theme): unknown[] {
  const o = theme === "dark" ? base : base * 0.18;
  return glowZoomScale(o);
}

export const FACADE_STEPS = ["vlow", "low", "mid", "high", "vhigh"] as const;
const FACADE_SELECTED_STEPS = [
  "selected-vlow",
  "selected-low",
  "selected-mid",
  "selected-high",
  "selected-vhigh",
] as const;
export type FacadeStep = (typeof FACADE_STEPS)[number];
export type FacadeSelectedStep = (typeof FACADE_SELECTED_STEPS)[number];
export type FacadeVariant =
  | FacadeStep
  | "dim"
  | "other"
  | "other-overview"
  | "selected"
  | FacadeSelectedStep;
export type FacadeLod = "flat" | "subtle" | "coarse" | "fine";

export function facadeLodForZoom(zoom: number): FacadeLod {
  if (zoom < FACADE_COARSE_MIN_ZOOM) return "flat";
  if (zoom < FACADE_MID_MIN_ZOOM) return "subtle";
  if (zoom < FACADE_FINE_MIN_ZOOM) return "coarse";
  return "fine";
}

export function facadePixelRatio(lod: FacadeLod): number {
  if (lod === "flat") return 1;
  if (lod === "subtle") return 1.35;
  if (lod === "coarse") return 1.35;
  return 1.75;
}

// Дневное стекло выбранного дома — тёплый крем (#f6e7cc…#ffe9c9),
// ночное горящее — тёплый янтарь (#ffc978…#ffd79a).
const DAY_CREAM_GLASS = ["#f6e7cc", "#f9e8ce", "#fce9cc", "#ffe9c9"] as const;
const NIGHT_AMBER_GLASS = ["#ffc978", "#ffce82", "#ffd38e", "#ffd79a"] as const;

type WindowKind = "narrow" | "single" | "wide" | "balcony";
type FacadeCol = { x: number; kind: WindowKind; jitterX: number; aptGroup: number };

export function makeFacadeImage(
  base: string,
  theme: Theme,
  variant: FacadeVariant,
  lod: FacadeLod,
): ImageData {
  const isSelected = variant === "selected" || variant.startsWith("selected-");
  const isNonHome = variant === "other" || variant === "other-overview";
  // Обычные дома в светлой теме на всех зумах, нежилые здания в обеих темах
  // и любые дома при zoom < 15.4 ("flat") — чистая плоская база без швов и окон.
  const isFlatBase = lod === "flat" || isNonHome || (theme === "light" && !isSelected);
  const size = isFlatBase ? FACADE_FLAT_SIZE : FACADE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d недоступен");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  if (isFlatBase) return ctx.getImageData(0, 0, size, size);

  // Детерминированный генератор — свой рисунок огней для каждого варианта.
  let seed =
    (theme === "dark" ? 19 : 7) +
    (lod === "subtle" ? 37 : lod === "coarse" ? 73 : 127) +
    variant.charCodeAt(0) * 197 +
    (variant.length > 2 ? variant.charCodeAt(1) * 89 : 0) +
    (variant.length > 3 ? variant.charCodeAt(variant.length - 1) * 41 : 0);
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const isFine = lod === "fine";
  const isSubtle = lod === "subtle";

  // ── Ветка 1: Обычные дома ночью (база + только редкие тёплые огни 5–8%) ──
  // Никаких швов и негорящих окон: только мелкие разбросанные огни (2–5 px),
  // не более ~12 на дом в кадре.
  if (!isSelected) {
    const rowH = isFine ? 18 : 16;
    const rows = Math.floor(size / rowH);
    const numCols = 16;
    const colStep = size / numCols;

    type NightDot = {
      wx: number;
      wy: number;
      ww: number;
      wh: number;
      score: number;
      toneIdx: number;
    };
    const dots: NightDot[] = [];
    const colBias = Array.from({ length: numCols }, () => (rnd() - 0.5) * 0.24);

    for (let r = 0; r < rows; r++) {
      const rowBoost = rnd() < 0.25 ? 0.18 : rnd() < 0.6 ? 0 : -0.15;
      for (let c = 0; c < numCols; c++) {
        const jx = Math.round((rnd() - 0.5) * 4);
        const jy = Math.round((rnd() - 0.5) * 2);
        const vr = rnd();
        const ww = isSubtle
          ? 3
          : isFine
            ? vr > 0.5
              ? 4
              : 3
            : vr > 0.45
              ? 4
              : 3;
        const wh = isSubtle
          ? 3
          : isFine
            ? vr > 0.45
              ? 5
              : 4
            : 4;
        const wx = Math.max(2, Math.min(size - ww - 2, Math.round(c * colStep + colStep * 0.35 + jx)));
        const wy = Math.max(2, Math.min(size - wh - 2, r * rowH + 4 + jy));
        const score = rnd() * 0.72 + rowBoost + colBias[c];
        dots.push({
          wx,
          wy,
          ww,
          wh,
          score,
          toneIdx: Math.floor(rnd() * 4),
        });
      }
    }

    // Строго 5–8% горящих окон: subtle 5.5% (единичные огни), остальные 7.0%.
    const targetLitRatio = isSubtle ? 0.055 : 0.07;
    const sorted = dots.map((d) => d.score).sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor(sorted.length * (1 - targetLitRatio))),
    );
    const litThreshold = sorted[idx];
    const maxScore = sorted[sorted.length - 1];
    const span = Math.max(0.001, maxScore - litThreshold);

    for (const dot of dots) {
      if (dot.score < litThreshold) continue;
      const u = Math.min(1, Math.max(0, (dot.score - litThreshold) / span));
      const amber = NIGHT_AMBER_GLASS[dot.toneIdx];
      // На 15.4–16.0 (subtle) контраст строго ≤ 6%; на 16+ — тёплые янтарные огни.
      const litT = isSubtle
        ? 0.038 + u * 0.021 // max 0.059 (≤ 6%)
        : u > 0.45
          ? 0.82 + (u - 0.45) * 0.28
          : 0.58 + u * 0.48;
      ctx.fillStyle = mixHex(base, amber, Math.min(0.96, litT));
      ctx.fillRect(dot.wx, dot.wy, dot.ww, dot.wh);

      if (!isSubtle && u > 0.4) {
        ctx.fillStyle = mixHex(base, "#ffd79a", Math.min(0.98, litT + 0.1));
        ctx.fillRect(dot.wx, dot.wy, dot.ww, 1);
      }
    }

    return ctx.getImageData(0, 0, size, size);
  }

  // ── Ветка 2: Выбранный дом (день — кремовые окна без тёмной сетки; ночь — тёплые окна) ──
  // Никаких тёмных швов и внешних рамок вокруг каждого окна, чтобы фасад
  // не превращался в решётку или вафлю.
  const rowH = isFine ? 16 : 13;
  const rows = Math.floor(size / rowH);
  const sectionWidths = [96, 94, 98, 96];
  const rot = variant.charCodeAt(variant.length - 1) % sectionWidths.length;
  const orderedSections = [
    ...sectionWidths.slice(rot),
    ...sectionWidths.slice(0, rot),
  ];

  const cols: FacadeCol[] = [];
  let secStart = 0;
  let aptCounter = 0;

  for (let si = 0; si < orderedSections.length; si++) {
    const secW = orderedSections[si];
    const kinds: WindowKind[] =
      (si + rot) % 2 === 0
        ? ["single", "wide", "single", "balcony", "single"]
        : ["narrow", "single", "balcony", "single", "wide"];
    const count = kinds.length;
    const margin = 7;
    const usable = secW - margin * 2;
    const step = usable / count;

    let inApt = 0;
    let aptSize = 2 + Math.floor(rnd() * 2);
    for (let ci = 0; ci < count; ci++) {
      if (inApt >= aptSize) {
        aptCounter++;
        inApt = 0;
        aptSize = 2 + Math.floor(rnd() * 2);
      }
      inApt++;
      const jitterX = rnd() < 0.3 ? -1 : rnd() < 0.7 ? 0 : 1;
      const center = secStart + margin + Math.round(ci * step + step * 0.25);
      cols.push({
        x: center,
        kind: kinds[ci],
        jitterX,
        aptGroup: aptCounter,
      });
    }
    aptCounter++;
    secStart += secW;
  }

  type WinCell = {
    wx: number;
    wy: number;
    ww: number;
    wh: number;
    score: number;
    toneIdx: number;
    varR: number;
  };
  const cells: WinCell[] = [];
  const colBias = cols.map(() => (rnd() - 0.5) * 0.22);

  for (let r = 0; r < rows; r++) {
    const aptBoosts: number[] = [];
    for (let a = 0; a <= aptCounter; a++) {
      const ar = rnd();
      aptBoosts[a] = ar < 0.36 ? 0.42 : ar < 0.7 ? 0.16 : -0.22;
    }

    for (let c = 0; c < cols.length; c++) {
      const col = cols[c];
      if (col.kind === "narrow" && (r + c * 3) % 11 === 0 && rnd() < 0.5) {
        continue;
      }
      const ww = isFine
        ? col.kind === "wide" || col.kind === "balcony"
          ? 5
          : 4
        : col.kind === "wide" || col.kind === "balcony"
          ? 4
          : 3;
      const wh = isFine ? 6 : 4;
      const wx = Math.max(2, Math.min(size - ww - 2, col.x + col.jitterX));
      const wy = r * rowH + (isFine ? 4 : 3);
      const score =
        rnd() * 0.65 +
        (aptBoosts[col.aptGroup] ?? 0) +
        colBias[c] +
        (col.kind === "narrow" ? -0.08 : 0);

      cells.push({
        wx,
        wy,
        ww,
        wh,
        score,
        toneIdx: Math.floor(rnd() * 4),
        varR: rnd(),
      });
    }
  }

  if (theme === "light") {
    // Светлая тема, выбранный дом: кремовые окна светлее фасада,
    // без тёмной сетки, без тёмных швов и без тёмных подоконников.
    for (const cell of cells) {
      const { wx, wy, ww, wh, toneIdx, varR } = cell;
      const cream = DAY_CREAM_GLASS[toneIdx];
      const glassT = isSubtle ? 0.14 + varR * 0.06 : 0.30 + varR * 0.12;
      ctx.fillStyle = mixHex(base, cream, glassT);
      ctx.fillRect(wx, wy, ww, wh);
      if (isFine) {
        ctx.fillStyle = mixHex(base, "#ffe9c9", Math.min(0.48, glassT + 0.1));
        ctx.fillRect(wx, wy, ww, 1);
      }
    }
    return ctx.getImageData(0, 0, size, size);
  }

  // Тёмная тема, выбранный дом: ~48% горящих янтарных окон, без синей решётки.
  const targetLitRatio = 0.48;
  const sorted = cells.map((cell) => cell.score).sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(sorted.length * (1 - targetLitRatio))),
  );
  const litThreshold = sorted[idx] ?? Infinity;
  const maxScore = sorted[sorted.length - 1] ?? 1;
  const span = Math.max(0.001, maxScore - litThreshold);

  for (const cell of cells) {
    const { wx, wy, ww, wh, score, toneIdx } = cell;
    if (score < litThreshold) continue;
    const u = Math.min(1, Math.max(0, (score - litThreshold) / span));
    const amber = NIGHT_AMBER_GLASS[toneIdx];
    const litT = isSubtle
      ? 0.04 + u * 0.02
      : u > 0.6
        ? 0.84 + (u - 0.6) * 0.3
        : u > 0.24
          ? 0.58 + (u - 0.24) * 0.55
          : 0.36 + u * 0.75;

    ctx.fillStyle = mixHex(base, amber, Math.min(0.95, litT));
    ctx.fillRect(wx, wy, ww, wh);
    if (!isSubtle) {
      ctx.fillStyle = mixHex(base, "#ffd79a", Math.min(0.98, litT + 0.12));
      ctx.fillRect(wx, wy, ww, 1);
    }
  }

  return ctx.getImageData(0, 0, size, size);
}

export const facadeImageName = (theme: Theme, variant: FacadeVariant, lod: FacadeLod) =>
  `facade-${theme}-${variant}-${lod}`;

const selectedFacadePatternExpr = (
  theme: Theme,
  s: ColorStops | null,
  lod: FacadeLod,
) => {
  if (theme === "dark") return facadeImageName("dark", "selected", lod) as never;
  const stops = s ?? DEFAULT_COLOR_STOPS;
  return [
    "step",
    ["coalesce", ["get", "index"], stops.mid],
    facadeImageName("light", "selected-vlow", lod),
    stops.t1,
    facadeImageName("light", "selected-low", lod),
    stops.t2,
    facadeImageName("light", "selected-mid", lod),
    stops.t3,
    facadeImageName("light", "selected-high", lod),
    stops.t4,
    facadeImageName("light", "selected-vhigh", lod),
  ] as never;
};

// Тот же step, что и у цвета: индексы → ступени для жилых, нейтральный
// контекстный вариант (без окон) — для нежилых.
// fill-extrusion-pattern в MapLibre не поддерживает feature-state, поэтому
// состояние выбора передаём явно через activeSelectedId.
export const facadePatternExpr = (
  theme: Theme,
  s: ColorStops | null,
  lod: FacadeLod,
  activeSelectedId: number | null = null,
  dimNonHome = false,
) => {
  const stops = s ?? DEFAULT_COLOR_STOPS;
  const otherVariant: FacadeVariant = dimNonHome ? "other" : "other-overview";
  const stepExpr = [
    "step",
    ["coalesce", ["get", "index"], stops.mid],
    facadeImageName(theme, "vlow", lod),
    stops.t1,
    facadeImageName(theme, "low", lod),
    stops.t2,
    facadeImageName(theme, "mid", lod),
    stops.t3,
    facadeImageName(theme, "high", lod),
    stops.t4,
    facadeImageName(theme, "vhigh", lod),
  ];
  const homeOrOtherExpr = [
    "case",
    isNonHomeBuildingExpr(),
    facadeImageName(theme, otherVariant, lod),
    stepExpr,
  ];
  if (activeSelectedId === null) {
    return homeOrOtherExpr as never;
  }
  return [
    "case",
    ["==", ["coalesce", ["to-number", ["get", "id"]], ["id"]], activeSelectedId],
    selectedFacadePatternExpr(theme, s, lod),
    homeOrOtherExpr,
  ] as never;
};
