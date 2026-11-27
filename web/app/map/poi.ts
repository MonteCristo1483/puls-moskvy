import * as maplibregl from "maplibre-gl";
import { ICON_PATHS } from "../icons";
import type { IconKey } from "../icons";
import type { Visibility } from "../layers-panel";
import type { Theme } from "../theme";
import { MAP_THEMES } from "./palette";
import type { Palette } from "./palette";

export type PoiProps = { type: string; subtype: string | null; name: string | null };
export type RedzoneProps = { kind: string; class: string | null };

// Порядок важен для стабильного типа percentiles в карточке.
const PENALTY_KINDS = ["road", "railway", "construction", "industrial"] as const;

export const POI_LABELS: Record<string, string> = {
  school: "Школа",
  kindergarten: "Сад",
  park: "Парк",
  subway_entrance: "Метро",
  rail_platform: "Электричка",
  shop: "Магазин",
};

function poiColor(type: string, p: Palette): string {
  return type === "subway_entrance" || type === "rail_platform" ? p.poiMetro : p.poiGreen;
}

// POI type -> ключ бонуса в breakdown
export const POI_TO_BONUS: Record<string, string> = {
  school: "schools",
  kindergarten: "kindergartens",
  park: "parks",
  subway_entrance: "transport",
  rail_platform: "transport",
  shop: "shops",
};

export const BONUS_KEYS = ["transport", "schools", "parks", "kindergartens", "shops"];

// Бонус -> ключ слоя-чекбокса: маршрут категории рисуется только когда
// включён её слой (FX-1: роут исчезает вместе со слоем категории).
export const BONUS_TO_LAYER: Record<string, keyof Visibility> = {
  transport: "metro",
  schools: "schools",
  parks: "parks",
  kindergartens: "kindergartens",
  shops: "shops",
};

export const PENALTY_LABELS: Record<string, string> = {
  road: "Магистраль",
  railway: "Ж/д",
  construction: "Стройка",
  industrial: "Промзона",
};

export const PENALTY_TO_KIND: Record<string, string> = {
  road: "road",
  railway: "railway",
  construction: "construction",
  industrial: "industrial",
};

function pillBase(extra: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] shadow ${extra}`;
  return el;
}

// POI на карте — иконка в «перевернутой капле» (как на макетах /design).
// Подпись («Школа · 7 мин») — только у ближайшего к выбранному дому POI.
export const POI_TO_ICON: Record<string, IconKey> = {
  school: "school",
  kindergarten: "kindergarten",
  park: "park",
  subway_entrance: "subway_entrance",
  rail_platform: "rail_platform",
  shop: "shop",
};

// POI рисуются symbol-слоями: иконки регистрируем картинками через addImage,
// подписи — тоже картинками (в проекте принципиально нет глиф-PBF, см. ниже).
// Отдельного sprite-сервера нет, поэтому капля и пилюля рисуются на canvas.
const PIN_PATH =
  "M12 1.5C7.3 1.5 3.5 5.3 3.5 10c0 5.6 8.5 12.6 8.5 12.6S20.5 15.6 20.5 10c0-4.7-3.8-8.5-8.5-8.5z";
export const POI_PIXEL_RATIO = 2;
// Все оверлеи (зоны, POI, деревья) — один векторный PMTiles-источник.
export const OVERLAYS_SOURCE = "overlays";
export const POI_LABEL_SOURCE = "poiLabels";
export const POI_LABEL_LAYER = "poi-labels";
// Для выбранного дома хватает его района и ближайших соседей.
export const POI_NEAR_DISTRICTS = 4;
const POI_LABEL_MIN_ZOOM = 14;
// Зоны видны с обзора z9: LOD по классам (trunk/primary с z8, secondary с z12,
// полигоны с z13) уже заложен в тайлы overlays.pmtiles.
export const REDZONE_MIN_ZOOM = 9;
// Заливка полигонов (промзоны/стройки) — с 13: раньше это крупные пятна.
export const REDZONE_FILL_MIN_ZOOM = 13;
// Линейные слои зон: ореол + ядро и дороги/ж/д.
export const REDZONE_LINE_LAYERS = [
  "redzones-glow",
  "redzones-core",
  "redzones-road",
  "redzones-rail",
];
// Порядок слоёв = порядок отрисовки: метро важнее всего на обзоре.
export const POI_LAYER_DEFS: {
  id: string;
  types: string[];
  flag: keyof Visibility;
  minzoom: number;
}[] = [
  { id: "poi-metro", types: ["subway_entrance", "rail_platform"], flag: "metro", minzoom: 11 },
  { id: "poi-parks", types: ["park"], flag: "parks", minzoom: 13 },
  { id: "poi-schools", types: ["school"], flag: "schools", minzoom: 14 },
  { id: "poi-kindergartens", types: ["kindergarten"], flag: "kindergartens", minzoom: 14 },
  { id: "poi-shops", types: ["shop"], flag: "shops", minzoom: 15 },
];

export const poiIconName = (theme: Theme, icon: IconKey) => `poi-${theme}-${icon}`;
export const poiLabelImageName = (theme: Theme, text: string) => `poi-label-${theme}-${text}`;

// Капля 24×24 CSS px: тот же путь, что был в SVG-маркере (паритет внешнего вида).
export function makePoiIconImage(type: string, theme: Theme): ImageData {
  const p = MAP_THEMES[theme];
  const color = poiColor(type, p);
  const icon = POI_TO_ICON[type] ?? "shop";
  const canvas = document.createElement("canvas");
  canvas.width = 24 * POI_PIXEL_RATIO;
  canvas.height = 24 * POI_PIXEL_RATIO;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d недоступен");
  ctx.scale(POI_PIXEL_RATIO, POI_PIXEL_RATIO);
  const pin = new Path2D(PIN_PATH);
  ctx.fillStyle = color;
  ctx.fill(pin);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.4;
  ctx.stroke(pin);
  ctx.beginPath();
  ctx.arc(12, 10, 5.2, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  // Иконка рисуется в 24×24 — сжимаем в белый круг капли.
  ctx.save();
  ctx.translate(12, 10);
  ctx.scale(0.4, 0.4);
  ctx.translate(-12, -12);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(new Path2D(ICON_PATHS[icon]));
  ctx.restore();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// Пилюля подписи («Школа · 7 мин»). Рисунок вместо text-field: в стиле нет
// глиф-сервера (PBF-шрифты не грузим), а имена POI слишком длинные для
// постоянных подписей на z15–16.6 — паритет с прежней DOM-пилюлей важнее.
export function makePoiLabelImage(theme: Theme, text: string): ImageData {
  const dark = theme === "dark";
  const font =
    "600 11px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("canvas 2d недоступен");
  measure.font = font;
  const textWidth = Math.ceil(measure.measureText(text).width);
  const width = textWidth + 16; // px-2 с двух сторон
  const height = 17; // 11px текст + py-0.5
  const canvas = document.createElement("canvas");
  canvas.width = width * POI_PIXEL_RATIO;
  canvas.height = height * POI_PIXEL_RATIO;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d недоступен");
  ctx.scale(POI_PIXEL_RATIO, POI_PIXEL_RATIO);
  ctx.shadowColor = "rgba(15, 23, 42, 0.18)";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = dark ? "rgba(30, 41, 59, 0.92)" : "rgba(255, 255, 255, 0.92)";
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, height / 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = dark ? "#e2e8f0" : "#334155";
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 8, height / 2 + 0.5);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// icon-image по типу POI одной темой: набор картинок фиксирован (6 типов).
export function poiIconExpression(theme: Theme): unknown {
  const expression: unknown[] = ["match", ["get", "type"]];
  for (const [type, icon] of Object.entries(POI_TO_ICON)) {
    expression.push(type, poiIconName(theme, icon));
  }
  expression.push(poiIconName(theme, "shop"));
  return expression;
}

// Слои POI: по одному на категорию — так проще фильтры по зуму и чекбоксы.
// icon-allow-overlap выключен до z14: ниже тысячи наложенных капель не нужны.
export function poiLayers(theme: Theme): maplibregl.LayerSpecification[] {
  const iconLayer = (def: (typeof POI_LAYER_DEFS)[number]) =>
    ({
      id: def.id,
      type: "symbol",
      source: OVERLAYS_SOURCE,
      "source-layer": "poi",
      minzoom: def.minzoom,
      filter: ["match", ["get", "type"], def.types, true, false],
      layout: {
        "icon-image": poiIconExpression(theme),
        "icon-anchor": "bottom",
        "icon-allow-overlap": ["step", ["zoom"], false, POI_LABEL_MIN_ZOOM, true],
        "icon-padding": 2,
      },
    }) as unknown as maplibregl.LayerSpecification;
  return [
    ...POI_LAYER_DEFS.map(iconLayer),
    {
      id: POI_LABEL_LAYER,
      type: "symbol",
      source: POI_LABEL_SOURCE,
      minzoom: POI_LABEL_MIN_ZOOM,
      layout: {
        "icon-image": ["get", "icon"],
        "icon-anchor": "bottom-left",
        "icon-offset": [16, -3],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    } as unknown as maplibregl.LayerSpecification,
  ];
}

export function makeRedPinEl(text: string, pill: string, iconColor: string): HTMLDivElement {
  const el = pillBase(`${pill} red-pin`);
  el.style.zIndex = "2";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M8 1.5 15 14H1L8 1.5Z");
  path.setAttribute("stroke", iconColor);
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  const label = document.createElement("span");
  label.textContent = text;
  el.append(svg, label);
  return el;
}
