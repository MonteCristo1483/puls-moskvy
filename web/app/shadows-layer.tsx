"use client";

// Слой «Тени и пыль» (S3).
//
// Тени: проекция контура дома вдоль солнечного луча на землю — объединение
// контура и его сдвинутой копии (polygon-clipping), fill-слой ПОД зданиями.
// Пересчитываем только то, что попало в текущий кадр: дома берём из уже
// загруженных тайлов `buildings` через querySourceFeatures, отсекаем по
// границам viewport. Шаг — moveend/resize с debounce; время — выбранное на
// таймлайне (`?t=HH:MM`, разбор в map.tsx/timeline.tsx) или текущее московское.
//
// Пыль: вектор ветра из live-weather (тот же кэш, что у слоя погоды — запрос
// не дублируется) над полигонами строек/пустырей из overlays.pmtiles
// (source-layer redzones, kind=construction). Если полигонов в кадре нет —
// стрелок нет, и это честно написано в плашке.
import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import type { Feature, FeatureCollection, MultiPolygon, Point } from "geojson";
import { Pill } from "./design";
import type { Theme } from "./theme";
import { fetchWeather, weatherAt, type WeatherSnapshot, type WeatherValues } from "./live-weather";
import { DUST_COLORS, SHADOW_PAINT } from "./map/palette";
import {
  formatClock,
  moscowClockMinutes,
  moscowInstantAt,
  sunPosition,
  type SunPosition,
} from "./solar";
import {
  buildingShadowMulti,
  cleanRing,
  dissolveShadows,
  dustSpots,
  MIN_SHADOW_ALTITUDE_DEG,
  type LonLat,
  type Ring,
  type ShadowMultiPolygon,
} from "./shadows";

const SHADOW_SOURCE_ID = "shadows-ground";
const SHADOW_LAYER_ID = "shadows-ground-fill";
const DUST_SOURCE_ID = "shadows-dust";
const DUST_LAYER_ID = "shadows-dust-arrows";

const SHADOW_MIN_ZOOM = 13;
const COMPUTE_MIN_ZOOM = 12.8;
// Потолок домов на кадр: больше — уже не видно, а платить временем придётся.
// Дома сортируются по площади контура, поэтому срез — это самые мелкие
// постройки (сараи, гаражи), чья пятидесятиметровая тень не читается.
const MAX_BUILDINGS = 600;
const MOVE_DEBOUNCE_MS = 140;

const DUST_PIXEL_RATIO = 2;
const DUST_ICON_PX = 40;

type ShadowStats = {
  status: "loading" | "ok" | "night" | "low" | "zoom";
  timeMinutes: number;
  altitude: number | null;
  azimuth: number | null;
  buildings: number;
  ms: number | null;
  /** Время растворения теней кадра (union), мс. */
  unionMs: number | null;
  /** Номер успешного пересчёта: e2e ловит по нему новый замер. */
  run: number;
  dust: number;
  windSpeed: number | null;
};

/**
 * D0: плашка теней по умолчанию уходит с первого экрана, но остаётся в DOM
 * (это ещё и измерительный прибор тестов) и возвращается по `?shadows=1`.
 * Флаг читаем из `location.search`: сайт живёт в подпапке Pages (basePath
 * /puls-moskvy), поэтому query — единственное надёжное место для параметра.
 */
export function readShadowsPillFlag(search: string): boolean {
  return new URLSearchParams(search).get("shadows") === "1";
}

type FootprintGroup = {
  rings: Ring[];
  ringKeys: Record<string, true>;
  height: number;
  center: LonLat;
  area: number;
};

function outerRings(geometry: { type: string; coordinates?: unknown }): Ring[] {
  const rings: Ring[] = [];
  if (geometry.type === "Polygon") {
    const coordinates = geometry.coordinates as LonLat[][] | undefined;
    if (coordinates?.length) rings.push(coordinates[0]);
  } else if (geometry.type === "MultiPolygon") {
    const coordinates = geometry.coordinates as LonLat[][][] | undefined;
    for (const polygon of coordinates ?? []) {
      if (polygon.length) rings.push(polygon[0]);
    }
  }
  return rings;
}

function numberProp(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ringBounds(ring: Ring): {
  west: number;
  east: number;
  south: number;
  north: number;
} | null {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (!Number.isFinite(west) || west > east) return null;
  return { west, east, south, north };
}

/** Canvas-иконка стрелки пыли: остриё на север, поворот задаёт слой. */
function makeDustArrowImage(theme: Theme): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = DUST_ICON_PX * DUST_PIXEL_RATIO;
  canvas.height = DUST_ICON_PX * DUST_PIXEL_RATIO;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(DUST_PIXEL_RATIO, DUST_PIXEL_RATIO);
  const cx = DUST_ICON_PX / 2;
  const cy = DUST_ICON_PX / 2;

  const draw = (color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const top = cy - 11;
    const bottom = cy + 11;
    ctx.beginPath();
    ctx.moveTo(cx, bottom);
    ctx.lineTo(cx, top + 7);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 6.5, top + 8);
    ctx.lineTo(cx, top);
    ctx.lineTo(cx + 6.5, top + 8);
    ctx.stroke();
  };

  draw(DUST_COLORS[theme].halo, 7.5);
  draw(DUST_COLORS[theme].core, 3.4);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function dustImageName(theme: Theme): string {
  return `shadows-dust-arrow-${theme}`;
}

function ensureDustImage(map: maplibregl.Map, theme: Theme): string {
  const name = dustImageName(theme);
  if (!map.hasImage(name)) {
    const image = makeDustArrowImage(theme);
    if (image) map.addImage(name, image, { pixelRatio: DUST_PIXEL_RATIO });
  }
  return name;
}

function firstSymbolLayerId(map: maplibregl.Map): string | undefined {
  for (const layer of map.getStyle()?.layers ?? []) {
    if (layer.type === "symbol" && layer.id !== DUST_LAYER_ID) return layer.id;
  }
  return undefined;
}

function shadowLayerSpec(theme: Theme): maplibregl.LayerSpecification {
  return {
    id: SHADOW_LAYER_ID,
    type: "fill",
    source: SHADOW_SOURCE_ID,
    minzoom: SHADOW_MIN_ZOOM,
    paint: {
      "fill-color": SHADOW_PAINT[theme].color,
      "fill-opacity": SHADOW_PAINT[theme].opacity,
      "fill-antialias": true,
    },
  };
}

function dustLayerSpec(icon: string): maplibregl.LayerSpecification {
  return {
    id: DUST_LAYER_ID,
    type: "symbol",
    source: DUST_SOURCE_ID,
    layout: {
      "icon-image": icon as never,
      "icon-size": [
        "interpolate",
        ["linear"],
        ["get", "speed"],
        0,
        0.62,
        4,
        0.8,
        8,
        0.98,
        14,
        1.15,
      ] as never,
      "icon-rotate": ["get", "rotate"] as never,
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-padding": 0,
    },
    paint: { "icon-opacity": 0.95 },
  };
}

function escapedKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

export default function ShadowsLayer({
  visible,
  theme,
  minutes,
}: {
  visible: boolean;
  theme: Theme;
  /** Выбранный час таймлайна, минуты от полуночи; null — живой режим. */
  minutes: number | null;
}) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const themeRef = useRef<Theme>(theme);
  const weatherRef = useRef<WeatherSnapshot | null>(null);
  const runRef = useRef(0);
  const [mapReady, setMapReady] = useState(false);
  const [stats, setStats] = useState<ShadowStats>({
    status: "loading",
    timeMinutes: minutes ?? moscowClockMinutes(Date.now()),
    altitude: null,
    azimuth: null,
    buildings: 0,
    ms: null,
    unionMs: null,
    run: 0,
    dust: 0,
    windSpeed: null,
  });

  // D0: по умолчанию плашка скрыта визуально (opacity 0), `?shadows=1`
  // показывает её как раньше. Флаг читаем в эффекте: на сервере window нет,
  // а начальный рендер должен совпасть с SSR-разметкой.
  const [pillShown, setPillShown] = useState(false);

  themeRef.current = theme;

  useEffect(() => {
    setPillShown(readShadowsPillFlag(window.location.search));
  }, []);

  // Карту создаёт map.tsx; ждём её в window.__map (как weather-layer).
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

  useEffect(() => {
    if (!visible || !mapReady) return;
    const instance = mapRef.current;
    if (!instance) return;
    const map: maplibregl.Map = instance;

    let disposed = false;
    let retryTimer: number | null = null;
    let debounceTimer: number | null = null;
    let sourceTimer: number | null = null;
    let attempts = 0;
    let lastMinute = -1;
    // Сколько раз догрузились тайлы домов: входит в подпись пересчёта, иначе
    // после moveend (тайлы ещё в пути) тени остались бы неполными.
    let buildingsLoads = 0;
    let lastSignature = "";
    let weatherAbort: AbortController | null = null;
    // Время таймлайна приходит свойством: второй разбор `?t=` не нужен.
    // URL читает map.tsx (readTimelineParam → parseClockParam) и передаёт минуты.
    const fixedMinutes = minutes;

    /** Время, на которое считаем тени: `?t=HH:MM` или «сейчас» (МСК). */
    function targetTime(): { date: Date; minutes: number } {
      const now = Date.now();
      if (fixedMinutes !== null) {
        return { date: moscowInstantAt(fixedMinutes, now), minutes: fixedMinutes };
      }
      const minutes = Math.floor(moscowClockMinutes(now));
      return { date: new Date(now), minutes };
    }

    // Кэш растворённых теней: ключ = время + bbox кадра + число теней.
    // Живёт в замыкании эффекта (сбрасывается при смене темы — редкость).
    const shadowCache: Record<string, ShadowMultiPolygon> = {};
    const shadowCacheOrder: string[] = [];
    const rememberShadow = (key: string, value: ShadowMultiPolygon) => {
      shadowCache[key] = value;
      shadowCacheOrder.push(key);
      while (shadowCacheOrder.length > 4) {
        const old = shadowCacheOrder.shift();
        if (old !== undefined) delete shadowCache[old];
      }
    };

    function scheduleRetry() {
      if (retryTimer !== null || attempts >= 120) return;
      attempts += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        compute();
      }, 250);
    }

    /** Слой на месте: источник + fill под зданиями (тени на земле). */
    function ensureLayer() {
      if (!map.getSource(SHADOW_SOURCE_ID)) {
        map.addSource(SHADOW_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        } as never);
      }
      if (!map.getLayer(SHADOW_LAYER_ID)) {
        const beforeId = map.getLayer("buildings")
          ? "buildings"
          : map.getLayer("buildings-shadow-1")
            ? "buildings-shadow-1"
            : undefined;
        map.addLayer(shadowLayerSpec(themeRef.current) as never, beforeId);
      } else {
        // Тема могла смениться — цвет дешевле обновить, чем пересоздавать.
        const paint = SHADOW_PAINT[themeRef.current];
        map.setPaintProperty(SHADOW_LAYER_ID, "fill-color", paint.color);
        map.setPaintProperty(SHADOW_LAYER_ID, "fill-opacity", paint.opacity);
      }
      // map.tsx добавляет свои слои после нас — держим тень под домами.
      const beforeId = map.getLayer("buildings") ? "buildings" : undefined;
      if (beforeId) {
        const layers = map.getStyle()?.layers ?? [];
        const own = layers.findIndex((layer) => layer.id === SHADOW_LAYER_ID);
        const target = layers.findIndex((layer) => layer.id === beforeId);
        if (own !== -1 && target !== -1 && own !== target - 1) {
          map.moveLayer(SHADOW_LAYER_ID, beforeId);
        }
      }
    }

    /** Дома текущего кадра: только те, чей центр внутри viewport. */
    function collectFootprints(
      bounds: maplibregl.LngLatBounds,
    ): FootprintGroup[] {
      const southWest = bounds.getSouthWest();
      const northEast = bounds.getNorthEast();
      const inView = (lon: number, lat: number) =>
        lon >= southWest.lng &&
        lon <= northEast.lng &&
        lat >= southWest.lat &&
        lat <= northEast.lat;

      const byKey: Record<string, FootprintGroup> = {};
      let features: maplibregl.GeoJSONFeature[] = [];
      try {
        features = map.querySourceFeatures("buildings", {
          sourceLayer: "buildings",
        });
      } catch {
        return [];
      }

      for (const feature of features) {
        const geometry = feature.geometry as unknown as {
          type: string;
          coordinates?: unknown;
        };
        const height = numberProp(feature.properties?.height) ?? 9;
        const featureId = feature.properties?.id;
        const ringList = outerRings(geometry);
        for (const ring of ringList) {
          const box = ringBounds(ring);
          if (!box) continue;
          const center: LonLat = [
            (box.west + box.east) / 2,
            (box.south + box.north) / 2,
          ];
          if (!inView(center[0], center[1])) continue;
          const ringKey = `${box.west.toFixed(6)}:${box.south.toFixed(6)}:${box.east.toFixed(6)}:${box.north.toFixed(6)}`;
          const key =
            featureId !== undefined && featureId !== null
              ? `id:${escapedKey(String(featureId))}`
              : `bbox:${ringKey}`;
          let group = byKey[key];
          if (!group) {
            group = {
              rings: [],
              ringKeys: {},
              height,
              center,
              area: 0,
            };
            byKey[key] = group;
          }
          if (group.ringKeys[ringKey]) continue;
          group.ringKeys[ringKey] = true;
          group.rings.push(ring);
          if (height > group.height) group.height = height;
          const boxArea =
            Math.abs(box.east - box.west) * Math.abs(box.north - box.south);
          group.area += boxArea;
        }
      }

      const groups = Object.keys(byKey).map((key) => byKey[key]);
      groups.sort((a, b) => b.area - a.area);
      if (groups.length > MAX_BUILDINGS) groups.length = MAX_BUILDINGS;
      return groups;
    }

    function writeDust(spots: Array<{ lon: number; lat: number }>, wind: WeatherValues | null) {
      if (!map.getSource(DUST_SOURCE_ID)) {
        map.addSource(DUST_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        } as never);
      }
      const icon = ensureDustImage(map, themeRef.current);
      if (!map.getLayer(DUST_LAYER_ID)) {
        map.addLayer(dustLayerSpec(icon) as never, firstSymbolLayerId(map));
      } else {
        map.setLayoutProperty(DUST_LAYER_ID, "icon-image", icon);
      }
      const rotate = wind ? (wind.windDirectionDeg + 180) % 360 : 0;
      const features: Array<Feature<Point, { rotate: number; speed: number }>> =
        wind
          ? spots.map((spot) => ({
              type: "Feature" as const,
              properties: { rotate, speed: wind.windSpeedMs },
              geometry: {
                type: "Point" as const,
                coordinates: [spot.lon, spot.lat],
              },
            }))
          : [];
      const collection: FeatureCollection<Point, { rotate: number; speed: number }> = {
        type: "FeatureCollection",
        features,
      };
      (map.getSource(DUST_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
        collection as never,
      );
    }

    /** Полигоны строек/пустырей в кадре (overlays.pmtiles, z13+). */
    function collectConstruction(): ShadowMultiPolygon[] {
      let features: maplibregl.GeoJSONFeature[] = [];
      try {
        features = map.querySourceFeatures("overlays", {
          sourceLayer: "redzones",
        });
      } catch {
        return [];
      }
      const bounds = map.getBounds();
      const southWest = bounds.getSouthWest();
      const northEast = bounds.getNorthEast();
      const polygons: ShadowMultiPolygon[] = [];
      for (const feature of features) {
        if (feature.properties?.kind !== "construction") continue;
        const geometry = feature.geometry as unknown as {
          type: string;
          coordinates?: unknown;
        };
        const rings = outerRings(geometry);
        for (const ring of rings) {
          const cleaned = cleanRing(ring);
          if (!cleaned) continue;
          const box = ringBounds(cleaned);
          if (!box) continue;
          const centerLon = (box.west + box.east) / 2;
          const centerLat = (box.south + box.north) / 2;
          if (
            centerLon < southWest.lng ||
            centerLon > northEast.lng ||
            centerLat < southWest.lat ||
            centerLat > northEast.lat
          ) {
            continue;
          }
          polygons.push([[cleaned]]);
        }
      }
      return polygons;
    }

    function compute() {
      if (disposed) return;
      try {
        if (!map.isStyleLoaded() && !map.getLayer(SHADOW_LAYER_ID)) {
          scheduleRetry();
          return;
        }
        const { date, minutes } = targetTime();
        const center = map.getCenter();
        const sun: SunPosition = sunPosition(date, center.lat, center.lng);
        const zoom = map.getZoom();

        // Один и тот же кадр, время и набор тайлов — второй раз не считаем:
        // иначе sourcedata/часы зациклили бы пересчёт.
        const signature = `${zoom.toFixed(2)}|${center.lng.toFixed(4)}|${center.lat.toFixed(4)}|${minutes}|${buildingsLoads}`;
        if (signature === lastSignature) return;

        if (zoom < COMPUTE_MIN_ZOOM) {
          (map.getSource(SHADOW_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
            { type: "FeatureCollection", features: [] } as never,
          );
          lastMinute = minutes;
          lastSignature = signature;
          setStats({
            status: "zoom",
            timeMinutes: minutes,
            altitude: sun.altitudeDeg,
            azimuth: sun.azimuthDeg,
            buildings: 0,
            ms: null,
            unionMs: null,
            run: runRef.current,
            dust: 0,
            windSpeed: null,
          });
          attempts = 0;
          return;
        }

        const startedAt = performance.now();
        ensureLayer();

        // ── Тени ────────────────────────────────────────────────────────
        // Собираем тени всех домов кадра и растворяем их в ОДИН MultiPolygon:
        // иначе перекрытия соседних домов складывают альфу и подложка
        // превращается в тёмные пятна. Растворение кэшируем по (время + bbox
        // кадра + число теней) — догрузка тайлов и тик часов не считают union
        // заново на том же кадре.
        let count = 0;
        const polygons: ShadowMultiPolygon[] = [];
        if (sun.altitudeDeg > 0) {
          for (const group of collectFootprints(map.getBounds())) {
            const shadow = buildingShadowMulti(
              group.rings.map((ring) => [ring]),
              group.height,
              sun,
              center.lat,
            );
            if (!shadow) continue;
            for (const polygon of shadow) polygons.push([polygon]);
            count += 1;
          }
        }
        const bounds = map.getBounds();
        const cacheKey = [
          minutes,
          bounds.getWest().toFixed(3),
          bounds.getSouth().toFixed(3),
          bounds.getEast().toFixed(3),
          bounds.getNorth().toFixed(3),
          polygons.length,
        ].join("|");
        const unionStartedAt = performance.now();
        // Растворение кадра: перекрытия соседних домов не должны складывать
        // альфу. Результат кэшируется по (время + bbox кадра + число теней).
        let dissolved = shadowCache[cacheKey];
        const cachedUnion = dissolved !== undefined;
        if (!dissolved) {
          dissolved = dissolveShadows(polygons);
          rememberShadow(cacheKey, dissolved);
        }
        const unionMs = cachedUnion ? 0 : performance.now() - unionStartedAt;

        const collection: FeatureCollection<
          MultiPolygon,
          Record<string, never>
        > = {
          type: "FeatureCollection",
          features:
            dissolved.length > 0
              ? [
                  {
                    type: "Feature",
                    properties: {},
                    geometry: {
                      type: "MultiPolygon",
                      coordinates: dissolved,
                    },
                  },
                ]
              : [],
        };
        (map.getSource(SHADOW_SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
          collection as never,
        );
        const elapsed = performance.now() - startedAt;
        lastMinute = minutes;
        lastSignature = signature;

        // ── Пыль: ветер уже кэширован слоем погоды (live-weather). ──────
        const polygonSpots = dustSpots(collectConstruction(), center.lat);
        const cached = weatherRef.current;
        // Ветер — на выбранный час: иначе тени на 08:00 считались бы по ветру
        // «сейчас», и стрелки пыли спорили бы с плашкой.
        const wind: WeatherValues | null = cached
          ? (weatherAt(cached, fixedMinutes) ?? cached)
          : null;
        if (wind) writeDust(polygonSpots, wind);
        const lowSun =
          sun.altitudeDeg > 0 && sun.altitudeDeg <= MIN_SHADOW_ALTITUDE_DEG;
        runRef.current += 1;
        setStats({
          status:
            sun.altitudeDeg <= 0 ? "night" : lowSun ? "low" : "ok",
          timeMinutes: minutes,
          altitude: sun.altitudeDeg,
          azimuth: sun.azimuthDeg,
          buildings: count,
          ms: elapsed,
          unionMs,
          run: runRef.current,
          dust: polygonSpots.length,
          windSpeed: wind?.windSpeedMs ?? null,
        });
        if (cached) {
          attempts = 0;
          return;
        }
        weatherAbort?.abort();
        const controller = new AbortController();
        weatherAbort = controller;
        void fetchWeather(center.lat, center.lng, { signal: controller.signal })
          .then((snapshot) => {
            if (disposed) return;
            weatherRef.current = snapshot;
            const hourWind = weatherAt(snapshot, fixedMinutes) ?? snapshot;
            writeDust(polygonSpots, hourWind);
            setStats((current) => ({
              ...current,
              dust: polygonSpots.length,
              windSpeed: hourWind.windSpeedMs,
            }));
          })
          .catch(() => {
            // Без ветра тени остаются: пыль просто не рисуем.
          });
        attempts = 0;
      } catch {
        scheduleRetry();
      }
    }

    function onMove() {
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        compute();
      }, MOVE_DEBOUNCE_MS);
    }

    // moveend наступает раньше, чем догрузились тайлы домов: тени успели бы
    // посчитаться по неполному набору. Пересчитываем ещё раз, когда источник
    // buildings догрузился (подпись включает счётчик загрузок).
    function onSourceData(event: maplibregl.MapSourceDataEvent) {
      if (event.sourceId !== "buildings" || !event.isSourceLoaded) return;
      buildingsLoads += 1;
      if (sourceTimer !== null) window.clearTimeout(sourceTimer);
      sourceTimer = window.setTimeout(() => {
        sourceTimer = null;
        compute();
      }, 320);
    }

    function onClock() {
      if (fixedMinutes !== null) return;
      const minute = Math.floor(moscowClockMinutes(Date.now()));
      if (minute === lastMinute) return;
      compute();
    }

    compute();
    map.on("moveend", onMove);
    map.on("resize", onMove);
    map.on("sourcedata", onSourceData);
    map.once("load", compute);
    const clockTimer = window.setInterval(onClock, 20_000);

    return () => {
      disposed = true;
      weatherAbort?.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      if (sourceTimer !== null) window.clearTimeout(sourceTimer);
      window.clearInterval(clockTimer);
      map.off("moveend", onMove);
      map.off("resize", onMove);
      map.off("sourcedata", onSourceData);
      map.off("load", compute);
      try {
        if (map.getLayer(DUST_LAYER_ID)) map.removeLayer(DUST_LAYER_ID);
        if (map.getSource(DUST_SOURCE_ID)) map.removeSource(DUST_SOURCE_ID);
        if (map.getLayer(SHADOW_LAYER_ID)) map.removeLayer(SHADOW_LAYER_ID);
        if (map.getSource(SHADOW_SOURCE_ID)) map.removeSource(SHADOW_SOURCE_ID);
      } catch {
        // Карта уже удалена вместе со стилем.
      }
    };
  }, [visible, mapReady, theme, minutes]);

  if (!visible) return null;

  const timeLabel = formatClock(stats.timeMinutes);
  const altitudeText =
    stats.altitude === null ? "—" : `${Math.round(stats.altitude)}°`;
  const azimuthText =
    stats.azimuth === null ? "—" : `${Math.round(stats.azimuth)}°`;
  const windText =
    stats.windSpeed === null
      ? null
      : `${stats.windSpeed.toFixed(1).replace(".", ",")} м/с`;

  let statusLine: string;
  if (stats.status === "night") {
    statusLine = "солнце за горизонтом — теней нет";
  } else if (stats.status === "low") {
    statusLine = `солнце ${altitudeText} — тени не строим (ниже 1,5°)`;
  } else if (stats.status === "zoom") {
    statusLine = "тени с z13 — приблизьте карту";
  } else if (stats.status === "loading" || stats.ms === null) {
    statusLine = "считаю тени…";
  } else {
    statusLine = `солнце ${altitudeText} · азимут ${azimuthText} · ${stats.buildings} теней`;
  }

  const dustLine =
    stats.dust === 0
      ? windText
        ? "пыль: строек в кадре нет"
        : null
      : windText
        ? `пыль: ${stats.dust} строек · ветер ${windText}`
        : `пыль: ${stats.dust} строек · ветер недоступен`;

  return (
    <Pill
      data-shadows-pill="1"
      // D0: геометрию не трогаем (тесты меряют габариты и перекрытия) —
      // прячем только визуально, оставляя элемент в потоке и в DOM.
      data-shadows-hidden={pillShown ? "0" : "1"}
      aria-hidden={pillShown ? undefined : true}
      style={pillShown ? undefined : { opacity: 0, pointerEvents: "none" }}
      data-shadows-status={stats.status}
      data-shadows-time={timeLabel}
      data-shadows-count={stats.buildings}
      data-shadows-ms={stats.ms === null ? undefined : stats.ms.toFixed(1)}
      data-shadows-union-ms={
        stats.unionMs === null ? undefined : stats.unionMs.toFixed(1)
      }
      data-shadows-run={stats.run}
      data-shadows-sun-altitude={
        stats.altitude === null ? undefined : stats.altitude.toFixed(2)
      }
      data-shadows-sun-azimuth={
        stats.azimuth === null ? undefined : stats.azimuth.toFixed(2)
      }
      data-shadows-dust={stats.dust}
      data-shadows-wind={
        stats.windSpeed === null ? undefined : stats.windSpeed.toFixed(2)
      }
      role="status"
      title="Тени: проекция контура дома вдоль солнечного луча (не «настоящие» 3D-тени). Азимут от севера, высота солнца над горизонтом. Пыль: ветер Open-Meteo над полигонами строек из OSM."
      className="absolute bottom-[3.4rem] left-3 z-20"
    >
      <span className="text-13 font-semibold leading-none">
        Тени на {timeLabel}
      </span>
      <span className="text-105 leading-none text-ink-2">{statusLine}</span>
      {dustLine && (
        <span className="text-105 leading-none text-ink-2">{dustLine}</span>
      )}
    </Pill>
  );
}
