"use client";

// Слой «Погода и ветер» (S2). Данные — Open-Meteo напрямую из браузера
// (ADR-001), стрелки — GeoJSON symbol-слой MapLibre с иконкой из canvas,
// плашка времени и источника. Всё живёт в одном компоненте, map.tsx только
// вставляет его в разметку; карту берём из window.__map (её создаёт map.tsx).
import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import type { Feature, FeatureCollection, Point } from "geojson";
import type { Theme } from "./theme";
import {
  fetchWeather,
  looksOffline,
  WEATHER_MOVE_THRESHOLD_DEG,
  WEATHER_REFRESH_MS,
  weatherClock,
  type WeatherSnapshot,
} from "./live-weather";

const SOURCE_ID = "weather-wind";
const LAYER_ID = "weather-wind-arrows";
const ARROW_PIXEL_RATIO = 2;
const ARROW_BASE_PX = 44;
// Потолок и пол числа стрелок: больше 24 — заметная нагрузка на GPU и шум.
const MAX_ARROWS = 24;
const MIN_ARROWS = 12;
// Пока карта не готова, погоду всё равно показываем — по центру Москвы.
const FALLBACK_CENTER: [number, number] = [37.6173, 55.7558]; // [lon, lat]

type WindProps = { icon: string; rotate: number; speed: number };

const TIER_COLORS: Record<Theme, readonly [string, string, string, string]> = {
  light: ["#64748b", "#0f766e", "#b45309", "#be123c"],
  dark: ["#a3b3c7", "#5eead4", "#fcd34d", "#fb7185"],
};

const TIER_HALO: Record<Theme, string> = {
  light: "rgba(255,255,255,0.92)",
  dark: "rgba(6,12,20,0.8)",
};

/** Скорость (м/с) → ступень цвета: тихо, слабый, заметный, сильный. */
function tierForSpeed(speed: number): number {
  if (speed < 1) return 0;
  if (speed < 3.5) return 1;
  if (speed < 7) return 2;
  return 3;
}

function imageName(theme: Theme, tier: number): string {
  return `weather-arrow-${theme}-${tier}`;
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  length: number,
  halfWidth: number,
  color: string,
  lineWidth: number,
) {
  const top = cy - length / 2;
  const bottom = cy + length / 2;
  const headLength = length * 0.42;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Древко (чуть не доводим до кончика — его рисует остриё).
  ctx.beginPath();
  ctx.moveTo(cx, bottom);
  ctx.lineTo(cx, top + headLength * 0.55);
  ctx.stroke();
  // Остриё.
  ctx.beginPath();
  ctx.moveTo(cx - halfWidth, top + headLength);
  ctx.lineTo(cx, top);
  ctx.lineTo(cx + halfWidth, top + headLength);
  ctx.stroke();
}

/**
 * Иконка стрелки: canvas → ImageData, без внешних ассетов. Стрелка смотрит
 * вверх (на север), поворот задаёт слой через icon-rotate.
 */
function makeArrowImage(theme: Theme, tier: number): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = ARROW_BASE_PX * ARROW_PIXEL_RATIO;
  canvas.height = ARROW_BASE_PX * ARROW_PIXEL_RATIO;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(ARROW_PIXEL_RATIO, ARROW_PIXEL_RATIO);
  const center = ARROW_BASE_PX / 2;
  // Подложка контрастна и к карте, и к 3D-домам в обеих темах.
  drawArrow(ctx, center, center, 30, 10.5, TIER_HALO[theme], 8);
  drawArrow(ctx, center, center, 30, 10.5, TIER_COLORS[theme][tier], 3.2);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function ensureArrowImages(map: maplibregl.Map, theme: Theme) {
  for (let tier = 0; tier < 4; tier += 1) {
    const name = imageName(theme, tier);
    if (map.hasImage(name)) continue;
    const image = makeArrowImage(theme, tier);
    if (!image) continue;
    map.addImage(name, image, { pixelRatio: ARROW_PIXEL_RATIO });
  }
}

function symbolLayerId(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  for (const layer of layers) {
    if (layer.type === "symbol" && layer.id !== LAYER_ID) return layer.id;
  }
  return undefined;
}

function arrowLayerSpec(): maplibregl.LayerSpecification {
  return {
    id: LAYER_ID,
    type: "symbol",
    source: SOURCE_ID,
    layout: {
      "icon-image": ["get", "icon"] as never,
      // Размер по скорости: тихо — мелкие, порывисто — крупнее.
      "icon-size": [
        "interpolate",
        ["linear"],
        ["get", "speed"],
        0,
        0.5,
        4,
        0.7,
        8,
        0.9,
        14,
        1.05,
      ] as never,
      // Стрелка нарисована на север; метеонаправление — «откуда», поэтому
      // +180°, чтобы остриё показывало, куда дует.
      "icon-rotate": ["get", "rotate"] as never,
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-padding": 0,
    },
    paint: { "icon-opacity": 0.92 },
  };
}

type GridLayout = {
  cols: number;
  rows: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Регулярная сетка стрелок в экранных координатах: отступы слева (панель
 * слоёв) и сверху (поиск) — чтобы слой не спорил с UI. Шаг подбирается так,
 * чтобы стрелок было 12–24 и они не жгли fps.
 */
function gridLayout(width: number, height: number): GridLayout {
  const narrow = width < 640;
  const left = narrow ? 152 : 208;
  const top = narrow ? 128 : 118;
  const usableWidth = Math.max(60, width - left - 26);
  const usableHeight = Math.max(60, height - top - (narrow ? 84 : 74));
  let step = Math.min(usableWidth, usableHeight) / 4;
  let cols = 1;
  let rows = 1;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    cols = Math.max(1, Math.round(usableWidth / step));
    rows = Math.max(1, Math.round(usableHeight / step));
    const total = cols * rows;
    if (total > MAX_ARROWS) step *= 1.15;
    else if (total < MIN_ARROWS && step > 72) step *= 0.88;
    else break;
  }
  return { cols, rows, left, top, width: usableWidth, height: usableHeight };
}

function windFeatures(
  map: maplibregl.Map,
  snapshot: WeatherSnapshot,
  theme: Theme,
): Array<Feature<Point, WindProps>> {
  const container = map.getContainer();
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (width < 80 || height < 80) return [];

  const layout = gridLayout(width, height);
  const icon = imageName(theme, tierForSpeed(snapshot.windSpeedMs));
  const rotate = (snapshot.windDirectionDeg + 180) % 360;
  const features: Array<Feature<Point, WindProps>> = [];
  for (let row = 0; row < layout.rows; row += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      const x = layout.left + ((col + 0.5) * layout.width) / layout.cols;
      const y = layout.top + ((row + 0.5) * layout.height) / layout.rows;
      const point = map.unproject([x, y]);
      features.push({
        type: "Feature",
        properties: { icon, rotate, speed: snapshot.windSpeedMs },
        geometry: { type: "Point", coordinates: [point.lng, point.lat] },
      });
    }
  }
  return features;
}

function writeFeatures(
  map: maplibregl.Map,
  snapshot: WeatherSnapshot | null,
  theme: Theme,
) {
  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  const collection: FeatureCollection<Point, WindProps> = {
    type: "FeatureCollection",
    features: snapshot ? windFeatures(map, snapshot, theme) : [],
  };
  source.setData(collection as never);
}

/**
 * Стрелки должны быть выше подложки и 3D-домов, но ниже подписей улиц и POI.
 * map.tsx добавляет свои слои уже после нас (на `load`), поэтому положение
 * проверяем при каждой перерисовке, а не только при создании слоя.
 */
function ensureArrowOrder(map: maplibregl.Map) {
  const layers = map.getStyle()?.layers ?? [];
  const own = layers.findIndex((layer) => layer.id === LAYER_ID);
  if (own === -1) return;
  const beforeId = symbolLayerId(map);
  const target = beforeId
    ? layers.findIndex((layer) => layer.id === beforeId)
    : layers.length;
  if (target === -1) return;
  // Уже стоим непосредственно перед первым symbol-слоем (или в самом верху)?
  if (own === target - 1) return;
  map.moveLayer(LAYER_ID, beforeId);
}

function formatNumber(value: number): string {
  return value.toFixed(1).replace(".", ",").replace("-", "−");
}

export default function WeatherLayer({
  visible,
  theme,
}: {
  visible: boolean;
  theme: Theme;
}) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const snapshotRef = useRef<WeatherSnapshot | null>(null);
  const lastCenterRef = useRef<[number, number] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [snapshot, setSnapshot] = useState<WeatherSnapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  // Эффекты детей выполняются раньше эффекта родителя, поэтому карту не
  // «ждём по порядку», а ищем в window.__map (map.tsx выставляет её сразу
  // после создания).
  useEffect(() => {
    const readMap = () =>
      (window as unknown as { __map?: maplibregl.Map }).__map ?? null;
    const existing = readMap();
    if (existing) {
      mapRef.current = existing;
      setMapReady(true);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const map = readMap();
      if (map) {
        mapRef.current = map;
        setMapReady(true);
        window.clearInterval(timer);
        return;
      }
      if (Date.now() - startedAt > 20_000) window.clearInterval(timer);
    }, 120);
    return () => window.clearInterval(timer);
  }, []);

  // Данные: первый запрос, обновление раз в 15 минут и повторный запрос,
  // когда центр карты сместился больше чем на ~0.05°.
  useEffect(() => {
    if (!visible) return;
    const load = (force: boolean) => {
      const map = mapRef.current;
      const center = map
        ? { lon: map.getCenter().lng, lat: map.getCenter().lat }
        : { lon: FALLBACK_CENTER[0], lat: FALLBACK_CENTER[1] };
      const previous = lastCenterRef.current;
      const moved =
        previous === null ||
        Math.abs(previous[0] - center.lon) >= WEATHER_MOVE_THRESHOLD_DEG ||
        Math.abs(previous[1] - center.lat) >= WEATHER_MOVE_THRESHOLD_DEG;
      if (!force && !moved) return;
      lastCenterRef.current = [center.lon, center.lat];

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      void fetchWeather(center.lat, center.lon, {
        signal: controller.signal,
        force,
      })
        .then((data) => {
          if (controller.signal.aborted) return;
          snapshotRef.current = data;
          setSnapshot(data);
          setStatus("ok");
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          // Данные не стираем: плашка покажет последнее известное время.
          setStatus("error");
        });
    };

    load(true);
    const timer = window.setInterval(() => load(true), WEATHER_REFRESH_MS);
    const map = mapRef.current;
    const onMoveEnd = () => load(false);
    map?.on("moveend", onMoveEnd);
    return () => {
      window.clearInterval(timer);
      map?.off("moveend", onMoveEnd);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [visible, mapReady]);

  // Слой стрелок: источник и symbol-слой с иконкой из canvas. Ставим ниже
  // первого symbol-слоя стиля, чтобы подписи POI и улиц остались сверху.
  useEffect(() => {
    if (!visible || !mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    let cancelStyleWait: (() => void) | null = null;
    // Отложенные перерисовки: map.tsx добавляет свои слои после нас.
    const retimers: number[] = [];

    const paint = () => {
      if (!map.isStyleLoaded()) {
        if (cancelStyleWait) return;
        const handler = () => {
          cancelStyleWait = null;
          paint();
        };
        cancelStyleWait = () => map.off("style.load", handler);
        map.once("style.load", handler);
        return;
      }
      try {
        ensureArrowImages(map, theme);
        const created = !map.getLayer(LAYER_ID);
        if (!map.getSource(SOURCE_ID)) {
          map.addSource(SOURCE_ID, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          } as never);
        }
        if (created) {
          map.addLayer(arrowLayerSpec() as never, symbolLayerId(map));
        }
        writeFeatures(map, snapshotRef.current, theme);
        try {
          ensureArrowOrder(map);
        } catch {
          // Порядок слоёв — косметика; данные стрелок уже записаны.
        }
        if (created) {
          // Слои зданий и POI map.tsx добавляет на `load` уже после нас —
          // через пару секунд возвращаем стрелки на место.
          for (const delay of [800, 2500]) {
            retimers.push(window.setTimeout(paint, delay));
          }
        }
      } catch {
        // Стиль перезагружается или карта уже удалена — слой не критичен.
      }
    };

    paint();
    map.on("moveend", paint);
    return () => {
      map.off("moveend", paint);
      cancelStyleWait?.();
      for (const timer of retimers) window.clearTimeout(timer);
      retimers.length = 0;
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // Карта уже удалена вместе со стилем.
      }
    };
  }, [visible, theme, mapReady, snapshot]);

  if (!visible) return null;

  const stale = status === "error";
  const clock = snapshot ? weatherClock(snapshot.time) : null;
  const valueLine = snapshot
    ? `${snapshot.temperatureC > 0 ? "+" : ""}${formatNumber(
        snapshot.temperatureC,
      )} °C · ветер ${formatNumber(snapshot.windSpeedMs)} м/с${
        snapshot.precipitationMm >= 0.05
          ? ` · ${formatNumber(snapshot.precipitationMm)} мм`
          : ""
      }`
    : status === "loading"
      ? "Погода · загрузка…"
      : "Погода недоступна";
  const sourceLine = snapshot
    ? `Данные на ${clock} · Open-Meteo${
        stale ? (looksOffline() ? " · нет сети" : " · данные устарели") : ""
      }`
    : status === "loading"
      ? "Open-Meteo"
      : "нет сети · Open-Meteo";

  return (
    <div
      data-weather-pill="1"
      data-weather-status={status}
      data-weather-temp={snapshot ? snapshot.temperatureC.toFixed(2) : undefined}
      data-weather-wind={snapshot ? snapshot.windSpeedMs.toFixed(2) : undefined}
      data-weather-time={snapshot ? snapshot.time : undefined}
      role="status"
      title="Погода и ветер: Open-Meteo, данные CC BY 4.0. Стрелки показывают, куда дует ветер; обновление раз в 15 минут."
      className="absolute bottom-2 left-3 z-20 flex select-none flex-col items-start gap-0.5 rounded-2xl bg-white/85 px-2.5 py-1.5 text-slate-700 shadow-sm backdrop-blur transition-colors dark:bg-slate-900/80 dark:text-slate-200"
    >
      <span className="text-[13px] font-semibold leading-none">
        {valueLine}
      </span>
      <span
        className={`text-[10.5px] leading-none ${
          stale
            ? "font-medium text-amber-700 dark:text-amber-400"
            : "text-slate-500 dark:text-slate-400"
        }`}
      >
        {sourceLine}
      </span>
    </div>
  );
}
