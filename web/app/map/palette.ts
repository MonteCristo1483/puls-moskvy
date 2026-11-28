import type { Theme } from "../theme";

// Палитры карты по темам (мягкие акценты, не неон — SPEC).
export const MAP_THEMES = {
  light: {
    // Обычные дома: 5 ступеней балла (насыщенные стены и выразительные тёплые/цветные крыши).
    vlow: "#c5a39e",
    low: "#cab1a2",
    mid: "#c7c5b6",
    high: "#afc5b9",
    vhigh: "#96bfa9",
    // Выбранный дом: яркий цвет ступени (не приглушать).
    selectedVlow: "#cf8f7c",
    selectedLow: "#d8ab8b",
    selectedMid: "#d8cfae",
    selectedHigh: "#a8c9a7",
    selectedVhigh: "#74bd8f",
    // Крыши жилых домов: выразительные светлые ступени индекса, чётко отделяющиеся от стен и от нежилого фона.
    roofVlow: "#e3beb9",
    roofLow: "#e5cbb9",
    roofMid: "#e3ddca",
    roofHigh: "#c5ddcd",
    roofVhigh: "#a8d6bc",
    roofDim: "#cbd5e2",
    // Нежилые здания: спокойный матовый фон в гамме земли (приглушён уже с z >= 13.5).
    otherOverview: "#b4c3d3",
    other: "#b9c7d7",
    roofOtherOverview: "#bccad9",
    roofOther: "#c0cedd",
    selected: "#38b874",
    // Крыша выбранного дома — цвет его ступени (на 5% светлее), не мятная.
    selectedRoof: "#dfd7b8",
    // В светлой теме выбранный дом без заливки тела на всех зумах (тело красится по яркой ступени балла).
    selectedBody: "#d8cfae",
    dim: "#b8c6d6",
    halo: "#38b874",
    outlineCore: "#289e60",
    redzone: "#e2604a",
    route: "#12b3a6",
    routeCore: "#eafff5",
    poiGreen: "#16a36e",
    poiMetro: "#e11d48",
    iso: "#3b82f6",
    pill: "bg-white/90 text-slate-700",
    redPill: "bg-white/95 text-red-700",
    redIcon: "#b91c1c",
    // Подложка: светлая дневная диорама (земля светлее зданий по тону, улицы светлее земли).
    land: "#c3d2e2",
    landUse: "#cbd8e6",
    park: "#579b68",
    wood: "#428b58",
    water: "#35b8d0",
    waterLine: "#248fa9",
    roadMinor: "#8a99ab",
    roadCasing: "#6d7f94",
    roadMajor: "#53657d",
    roadMajorCasing: "#2f435f",
    roadMark: "#e8edf1",
    label: "#172134",
    labelHalo: "#ffffff",
    labelWater: "#0c4a6e",
    labelWaterHalo: "#ffffff",
    tree: "#4a9960",
    treeDark: "#2f6f43",
    shadow: "#1a2838",
  },
  dark: {
    // Обычные дома: 5 ступеней, смешанных с #3a4760 на 35%.
    vlow: "#46536a",
    low: "#4b5972",
    mid: "#3a4a64",
    high: "#3d556a",
    vhigh: "#486a65",
    // Выбранный дом: неприглушённые ступени (ярче обычных).
    selectedVlow: "#4c5a70",
    selectedLow: "#54637c",
    selectedMid: "#3a4b66",
    selectedHigh: "#3f5c70",
    selectedVhigh: "#4f7d68",
    // Крыши обычных домов в тёмной теме.
    roofVlow: "#655b75",
    roofLow: "#657087",
    roofMid: "#4f627d",
    roofHigh: "#44716e",
    roofVhigh: "#4a8066",
    roofDim: "#212936",
    // Нежилые здания в тёмной теме: спокойный низкоконтрастный макетный фон ближе к подложке земли.
    otherOverview: "#1d2632",
    other: "#1b232e",
    roofOtherOverview: "#232d3b",
    roofOther: "#202936",
    selected: "#5ec98f",
    selectedRoof: "#586a84",
    // Тёмная тема: благородный сланцевый фасад выбранного дома (ярче обычных домов и dim).
    selectedBody: "#50627c",
    dim: "#1f2733",
    halo: "#5ec98f",
    outlineCore: "#58c288",
    redzone: "#ff8a7a",
    route: "#5fe0d0",
    routeCore: "#f2fffb",
    poiGreen: "#7fb98a",
    poiMetro: "#ef8fa4",
    iso: "#38bdf8",
    pill: "bg-slate-800/90 text-slate-200",
    redPill: "bg-slate-800/95 text-red-300",
    redIcon: "#f87171",
    // Подложка (тёмный город)
    land: "#141b24",
    landUse: "#19212c",
    park: "#1d3a2b",
    wood: "#1a3326",
    water: "#0d3f63",
    waterLine: "#1a5f8a",
    roadMinor: "#2a3542",
    roadCasing: "#3b4756",
    roadMajor: "#4c5a6b",
    roadMajorCasing: "#3b4756",
    roadMark: "#3d4a5c",
    label: "#e2e8f0",
    labelHalo: "#0b1220",
    labelWater: "#82c4e8",
    labelWaterHalo: "#0b1220",
    tree: "#2f6b4a",
    treeDark: "#1e4a33",
    shadow: "#000000",
  },
} as const;

export type Palette = { [K in keyof (typeof MAP_THEMES)["light"]]: string };

// Свет сцены: тёплый день / холодная ночь. MapLibre light для fill-extrusion.
type ThemeLight = {
  anchor: "viewport";
  color: string;
  intensity: number;
  position: [number, number, number];
};

export const MAP_LIGHT: Record<Theme, ThemeLight> = {
  light: {
    anchor: "viewport",
    // Тёплый направленный свет сбоку (азимут ~245°, полярный ~46°):
    // передние и левые фасады светлые, правые — в тени, что согласуется
    // со сдвигом контактных теней на земле [+x, +y] (вправо-вниз).
    color: "#fff6ea",
    intensity: 0.5,
    position: [1.5, 245, 46],
  },
  dark: {
    anchor: "viewport",
    color: "#bcd7ff",
    intensity: 0.32,
    position: [1.2, 245, 36],
  },
};

// FX-2: пороги цвета — квантили реального распределения индекса.
// Жёсткий step 5/7 после скоринга v4 давал ~56% зданий одним бежевым
// (бэклог FX №2). Линейный градиент в RGB не подошёл: смешение пастелей
// даёт выцветшие промежуточные тона. Поэтому — 5 ступеней (квинтили),
// каждая по ~20% зданий, соседние оттенки близки по тону, но насыщенные.
// Цвет — презентация: формула индекса (scoring.json) не затрагивается.
// null = данных мало, фолбэк на старый step 5/7.
export type ColorStops = { t1: number; t2: number; t3: number; t4: number; mid: number };

export const DEFAULT_COLOR_STOPS: ColorStops = {
  t1: 6.1,
  t2: 6.8,
  t3: 7.4,
  t4: 7.9,
  mid: 7.1,
};

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const mix = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(ar, br)}${mix(ag, bg)}${mix(ab, bb)}`;
}

// ── Цвета слоёв поверх карты (WebGL/canvas, не DOM): держим рядом с
// палитрами тем, чтобы новые слои не заводили hex в компонентах. ─────────

/**
 * Тени кадра растворены в один MultiPolygon, поэтому альфа не складывается
 * на перекрытиях: 0.19 в светлой теме — ровная «тень на земле», подложка
 * остаётся читаемой; в тёмной нужен чуть больший контраст.
 */
export const SHADOW_PAINT: Record<Theme, { color: string; opacity: number }> = {
  light: { color: "#0f172a", opacity: 0.19 },
  dark: { color: "#000000", opacity: 0.32 },
};

/** Стрелки пыли над стройками: ядро и ореол иконки. */
/**
 * Слой «Стройки и работы» (S7): линии/полигоны/точки набора 2855. Цвет —
 * картографический (WebGL не понимает CSS-переменные), поэтому живёт в
 * палитре тем, как и цвета остальных слоёв. Янтарный — «работы/раскопки»,
 * не красный: красные зоны уже заняли красный.
 */
export const WORKS_PAINT: Record<
  Theme,
  {
    line: string;
    fill: string;
    fillOpacity: number;
    point: string;
    pointStroke: string;
  }
> = {
  light: {
    line: "#b45309",
    fill: "#c2410c",
    fillOpacity: 0.16,
    point: "#b45309",
    pointStroke: "#ffffff",
  },
  dark: {
    line: "#fbbf24",
    fill: "#fb923c",
    fillOpacity: 0.2,
    point: "#fcd34d",
    pointStroke: "#0b1220",
  },
};

/**
 * Кольцо балла в карточке дома: цвет — презентация данных, не тема, поэтому
 * живёт в палитре, а не в токенах интерфейса.
 */
export const SCORE_COLORS = {
  none: "#c9ced3",
  vlow: "#d98f86",
  mid: "#c9bf9e",
  ok: "#7fb069",
} as const;
