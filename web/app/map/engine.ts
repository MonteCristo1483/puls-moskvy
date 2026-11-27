import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import * as maplibregl from "maplibre-gl";
import { RED_FLAG_PENALTY, isCompactBreakdown } from "../building-sheet";
import type { BuildingBreakdown, SelectedBuilding } from "../building-sheet";
import { geometryCenter, haversineM, nearestPosition } from "../geo-utils";
import type { IconKey } from "../icons";
import type { Visibility } from "../layers-panel";
import type { SearchItem } from "../search-box";
import { MAP_FOG } from "../theme";
import type { Theme } from "../theme";
import { basemapLayers, basemapPaint, buildLabelCandidates, geometryInBounds } from "./basemap";
import type { BasemapProps, LabelCandidate } from "./basemap";
import { BUILDING_MIN_ZOOM, BUILDING_SHADOW_LAYERS, BUILDING_SHADOW_MIN_ZOOM, DECOR_MIN_ZOOM, FACADE_COARSE_MIN_ZOOM, FACADE_SELECT_ZOOM, FACADE_STEPS, GLOW_BASE_LAYER_ID, GLOW_EDGE_COLOR, GLOW_EDGE_LAYER_ID, GLOW_GROUND_COLOR, GLOW_RINGS, HERO_HALO_LAYER_ID, HERO_WINDOWS_SOURCE_ID, HERO_WINDOW_LAYER_ID, NON_HOME_DIM_MIN_ZOOM, buildRoofEdgeFeatures, buildSelectedWindowFeatures, buildingColorExpr, buildingExtrusionHeightExpr, buildingRoofBaseExpr, buildingRoofColorExpr, buildingRoofHeightExpr, buildingShadowOpacityExpr, facadeImageName, facadeLodForZoom, facadePatternExpr, facadePixelRatio, glowRingOpacity, glowZoomScale, makeFacadeImage, selectedStepColorsExpr } from "./buildings-3d";
import type { FacadeLod, FacadeSelectedStep, FacadeStep, FacadeVariant } from "./buildings-3d";
import { curvedLine, firstCoordinateKey, parseBuildingBreakdown } from "./formatting";
import { facadeCameraBearing, footprintAreaM2, geometrySignature, lonLatToTileXY, unionFootprintGeometries } from "./geometry";
import type { GCollection, GFeature } from "./geometry";
import { DEFAULT_COLOR_STOPS, MAP_LIGHT, MAP_THEMES } from "./palette";
import type { ColorStops } from "./palette";
import { BONUS_KEYS, BONUS_TO_LAYER, OVERLAYS_SOURCE, PENALTY_LABELS, PENALTY_TO_KIND, POI_LABELS, POI_LABEL_LAYER, POI_LABEL_SOURCE, POI_LAYER_DEFS, POI_NEAR_DISTRICTS, POI_PIXEL_RATIO, POI_TO_BONUS, POI_TO_ICON, REDZONE_FILL_MIN_ZOOM, REDZONE_LINE_LAYERS, REDZONE_MIN_ZOOM, makePoiIconImage, makePoiLabelImage, makeRedPinEl, poiIconExpression, poiIconName, poiLabelImageName, poiLayers } from "./poi";
import type { PoiProps, RedzoneProps } from "./poi";
import { BASEMAP_URL, BUILDINGS_URL, INDEX_URL, MANIFEST_URL, OVERLAYS_URL, ROUTES_URL, fetchGzipJson, fetchPmtilesTile, getPmtilesProtocol, pmtilesRamCache } from "./tiles";
import type { BuildingMeta, BuildingProps, BuildingRoutes, CompactSearchIndex, DistrictEntry, DistrictManifest, FlatRoutes, IsoGeometry } from "./tiles";

let pmtilesProtocolReady = false;

// Всё состояние компонента карты, которое нужно движку. Поля — ровно те, что
// захватывал useEffect в map.tsx; передаются значения на момент монтирования.
export type MapEngineContext = {
  containerRef: RefObject<HTMLDivElement | null>;
  selected: SelectedBuilding | null;
  visible: Visibility;
  theme: Theme;
  setSearchItems: Dispatch<SetStateAction<SearchItem[]>>;
  setDeepLinkError: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setNonHomeNotice: Dispatch<SetStateAction<{ point: [number, number]; status: "idle" | "loading" | "error" | "far" } | null>>;
  setFatalError: Dispatch<SetStateAction<string | null>>;
  setSplash: Dispatch<SetStateAction<"show" | "fade" | "gone">>;
  deselectRef: RefObject<(() => void) | null>;
  selectRef: RefObject<((id: number) => void) | null>;
  loadSearchIndexRef: RefObject<(() => Promise<void>) | null>;
  findNearestHomeRef: RefObject<((point: [number, number]) => Promise<void>) | null>;
  applyVisibilityRef: RefObject<((v: Visibility) => void) | null>;
  applyThemeRef: RefObject<((t: Theme) => void) | null>;
  selectedRef: RefObject<SelectedBuilding | null>;
  visibleRef: RefObject<Visibility>;
  routesRef: RefObject<FlatRoutes | null>;
  routesCacheRef: RefObject<Record<number, FlatRoutes | null>>;
  routesShardCacheRef: RefObject<Record<string, Promise<Record<string, BuildingRoutes> | null>>>;
  breakdownCacheRef: RefObject<Record<number, BuildingBreakdown | null>>;
  districtByBuildingRef: RefObject<Record<number, number>>;
  isoGeomRef: RefObject<IsoGeometry | null>;
  setIsoSourceRef: RefObject<((geom: IsoGeometry | null) => void) | null>;
  themeRef: RefObject<Theme>;
  updateSelected: (b: SelectedBuilding | null) => void;
  showNotice: (message: string) => void;
};

export function mountMap(ctx: MapEngineContext): (() => void) | undefined {
  const {
    containerRef,
    selected,
    visible,
    theme,
    setSearchItems,
    setDeepLinkError,
    setNotice,
    setNonHomeNotice,
    setFatalError,
    setSplash,
    deselectRef,
    selectRef,
    loadSearchIndexRef,
    findNearestHomeRef,
    applyVisibilityRef,
    applyThemeRef,
    selectedRef,
    visibleRef,
    routesRef,
    routesCacheRef,
    routesShardCacheRef,
    breakdownCacheRef,
    districtByBuildingRef,
    isoGeomRef,
    setIsoSourceRef,
    themeRef,
    updateSelected,
    showNotice,
  } = ctx;
  if (!containerRef.current) return;
  const container = containerRef.current;
  let cancelled = false;
  let map: maplibregl.Map | null = null;
  let basemapDecorTimer: number | null = null;
  let tilePrefetchTimer: number | null = null;
  // Токен поколения префетча: новый прогон/движение камеры отменяет старый.
  let tilePrefetchToken = 0;

  const init = async () => {
    const fetchJson = async (url: string): Promise<unknown> => {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status} по ${url}`);
          return await res.json();
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    };

    let poi!: GCollection<PoiProps>;
    const tileMode = true;
    let districts: DistrictEntry[] = [];
    let buildingMeta: BuildingMeta[] = [];
    let metaById: Record<number, BuildingMeta> = {};
    let buildingCenters: Record<number, [number, number]> = {};
    const colorStops: ColorStops = DEFAULT_COLOR_STOPS;
    let searchIndexData: CompactSearchIndex | null = null;
    let indexPromise: Promise<CompactSearchIndex> | null = null;

    const ensureSearchIndex = (): Promise<CompactSearchIndex> => {
      if (searchIndexData) return Promise.resolve(searchIndexData);
      if (indexPromise) return indexPromise;
      indexPromise = (async () => {
        const index = await fetchGzipJson<CompactSearchIndex>(INDEX_URL);
        const lengths = [
          index.ids?.length,
          index.lon?.length,
          index.lat?.length,
          index.addr?.length,
        ];
        if (
          index.v !== 1 ||
          lengths.some((length) => !Number.isInteger(length)) ||
          new Set(lengths).size !== 1 ||
          index.ids.length === 0
        ) {
          throw new Error("Компактный индекс пуст или повреждён");
        }

        searchIndexData = index;
        buildingMeta = index.ids.map((id, i) => {
          const meta: BuildingMeta = {
            id,
            center: [index.lon[i], index.lat[i]],
            address: index.addr[i] ?? null,
            index: null,
            year: null,
            isHome: true,
          };
          metaById[id] = meta;
          buildingCenters[id] = meta.center as [number, number];
          return meta;
        });
        if (!cancelled) {
          setSearchItems(
            buildingMeta
              .filter((meta): meta is BuildingMeta & { address: string } => Boolean(meta.address))
              .map((meta) => ({
                id: meta.id,
                address: meta.address,
                index: meta.index,
                year: meta.year,
              })),
          );
        }
        return index;
      })().catch((error) => {
        indexPromise = null;
        throw error;
      });
      return indexPromise;
    };

    const loadSearchIndex = (): Promise<void> =>
      ensureSearchIndex()
        .then(() => undefined)
        .catch((error) => {
          console.error("Индекс поиска не загрузился:", error);
          showNotice("Не удалось загрузить поиск. Попробуйте ещё раз.");
        });
    loadSearchIndexRef.current = loadSearchIndex;

    try {
      const [buildingsHead, basemapHead] = await Promise.all([
        fetch(BUILDINGS_URL, { method: "HEAD" }),
        fetch(BASEMAP_URL, { method: "HEAD" }),
      ]);
      if (
        !buildingsHead.ok ||
        !basemapHead.ok ||
        buildingsHead.headers.get("content-length") === "0" ||
        basemapHead.headers.get("content-length") === "0"
      ) {
        throw new Error("Городские PMTiles отсутствуют или пусты");
      }

      const manifest = (await fetchJson(MANIFEST_URL)) as DistrictManifest;
      if (manifest.v !== 1 || !Array.isArray(manifest.districts) || !manifest.districts.length) {
        throw new Error("Манифест районов пуст или повреждён");
      }
      districts = manifest.districts;
      // POI и красные зоны не тянем всем городом: файлы грузятся по видимым
      // районам ПОСЛЕ создания карты (ensure/refreshPoi и refreshRedzones).
    } catch (e) {
      console.error("Не удалось загрузить данные карты:", e);
      setFatalError(
        "Не удалось загрузить городские тайлы или данные районов. Проверьте соединение и обновите страницу.",
      );
      return;
    }
    if (cancelled) return;

    // Протокол PMTiles регистрируем один раз за жизнь вкладки.
    if (!pmtilesProtocolReady) {
      maplibregl.addProtocol("pmtiles", async (params) => {
        // TileJSON/метаданные источника (type: "json") — не тайл: в RAM-кэш
        // их не кладём, отдаём как обычно (один запрос на источник).
        if (params.type === "json" || params.type === "string") {
          const res = await getPmtilesProtocol().tile(
            { url: params.url, type: params.type } as never,
            new AbortController(),
          );
          return { data: res.data as never };
        }
        const data = await fetchPmtilesTile(params.url);
        // Копия обязательна: MapLibre передаёт буфер в Web Worker через
        // transfer и отсоединяет его. В кэше должен остаться живой буфер,
        // поэтому каждый запрос получает свою копию из RAM (~0.01 мс).
        return { data: data.slice(0) };
      });
      pmtilesProtocolReady = true;
    }

    const palette = MAP_THEMES[themeRef.current];

    // POI — кэш в памяти по районам. Нужен только для ближайших POI
    // выбранного дома (пилюли «Метро · X мин»); на карте рисуются тайлы overlays.
    const poiByDistrict: Record<number, GFeature<PoiProps>[]> = {};
    const poiRequests: Record<number, Promise<GFeature<PoiProps>[]>> = {};
    const poiPoints: { f: GFeature<PoiProps>; center: [number, number] }[] = [];

    const loadDistrictPoi = (id: number): Promise<GFeature<PoiProps>[]> => {
      const cached = poiByDistrict[id];
      if (cached) return Promise.resolve(cached);
      const pending = poiRequests[id];
      if (pending) return pending;
      const request = fetchJson(`data/districts/${id}/poi.geojson`)
        .then((data) => {
          const features = (data as GCollection<PoiProps>).features ?? [];
          poiByDistrict[id] = features;
          for (const f of features) {
            const center = geometryCenter(f.geometry);
            if (center) poiPoints.push({ f, center });
          }
          return features;
        })
        .catch((error) => {
          console.error(`POI района ${id} не загрузились:`, error);
          poiByDistrict[id] = [];
          return [] as GFeature<PoiProps>[];
        })
        .finally(() => {
          delete poiRequests[id];
        });
      poiRequests[id] = request;
      return request;
    };

    // Выбранный дом мог оказаться у края кадра: его район (и соседей)
    // догружаем в кэш, чтобы «ближайший POI» не потерялся на границе.
    const ensurePoiNear = async (center: [number, number]) => {
      const pad = 0.018;
      const ids = districts
        .filter(
          ({ bbox }) =>
            center[0] >= bbox[0] - pad &&
            center[0] <= bbox[2] + pad &&
            center[1] >= bbox[1] - pad &&
            center[1] <= bbox[3] + pad,
        )
        .slice(0, POI_NEAR_DISTRICTS)
        .map((district) => district.id)
        .filter((id) => !poiByDistrict[id]);
      if (!ids.length) return;
      await Promise.all(ids.map(loadDistrictPoi));
      if (cancelled || !map) return;
      if (selectionMovePending || map.isMoving()) {
        map.once("moveend", () => {
          if (!cancelled) rebuildOverlays(selectedRef.current, visibleRef.current);
        });
      } else {
        rebuildOverlays(selectedRef.current, visibleRef.current);
      }
    };

    // ── Красные зоны (redzones.geojson) ────────────────────────────────
    // Как и POI: кэш по районам в памяти, в источник попадают только
    // видимые районы (≤ REDZONE_MAX_DISTRICTS за обновление). Все 132 файла
    // на старте давали 35 801 линию по городу и роняли FPS до 9.
    const redzoneByDistrict: Record<number, GFeature<RedzoneProps>[]> = {};
    const redzoneRequests: Record<number, Promise<GFeature<RedzoneProps>[]>> = {};

    const loadDistrictRedzones = (
      id: number,
    ): Promise<GFeature<RedzoneProps>[]> => {
      const cached = redzoneByDistrict[id];
      if (cached) return Promise.resolve(cached);
      const pending = redzoneRequests[id];
      if (pending) return pending;
      const request = fetchJson(`data/districts/${id}/redzones.geojson`)
        .then((data) => {
          const features = (data as GCollection<RedzoneProps>).features ?? [];
          redzoneByDistrict[id] = features;
          return features;
        })
        .catch((error) => {
          console.error(`Красные зоны района ${id} не загрузились:`, error);
          redzoneByDistrict[id] = [];
          return [] as GFeature<RedzoneProps>[];
        })
        .finally(() => {
          delete redzoneRequests[id];
        });
      redzoneRequests[id] = request;
      return request;
    };

    // Только для красных пинов выбранного дома: зоны района дома в памяти.
    const loadedRedzoneFeatures = (buildingId?: number): GFeature<RedzoneProps>[] => {
      const dId =
        buildingId !== undefined
          ? districtByBuildingRef.current[buildingId]
          : undefined;
      return dId !== undefined ? redzoneByDistrict[dId] ?? [] : [];
    };

    // Видимость зон = только тоггл слоя: LOD по зумам заложен в тайлах overlays.
    let redzoneVisibilityKey = "";
    const syncRedzoneVisibility = () => {
      if (!map || !map.getLayer("redzones-glow")) return;
      const show = visibleRef.current.redzones;
      const key = show ? "1" : "0";
      // На каждый вызов не дёргаем стиль: лишние setLayoutProperty
      // = лишний пересчёт и лишний кадр.
      if (key === redzoneVisibilityKey) return;
      redzoneVisibilityKey = key;
      const vis = show ? "visible" : "none";
      for (const id of [...REDZONE_LINE_LAYERS, "redzones-fill"]) {
        map.setLayoutProperty(id, "visibility", vis);
      }
    };

    // Выбранный дом мог оказаться у края кадра: его район догружаем в кэш,
    // чтобы красные пины «ближайший минус» нашли свою зону. На карту
    // (в источник слоёв) это не попадает — зоны рисуются из overlays.pmtiles.
    const ensureRedzonesForDistrict = async (districtId: number) => {
      if (redzoneByDistrict[districtId]) return;
      await loadDistrictRedzones(districtId);
    };

    let labelCandidates: LabelCandidate[] = [];

    // Ближайший POI ищем по загруженным районам (кэш растёт по мере движения).
    const nearestPoi = (
      bonusKey: string,
      from: [number, number],
    ): { f: GFeature<PoiProps>; center: [number, number] } | null => {
      let best: { f: GFeature<PoiProps>; center: [number, number] } | null = null;
      let bestDist = Infinity;
      for (const { f, center } of poiPoints) {
        if (POI_TO_BONUS[f.properties.type] !== bonusKey) continue;
        const d = haversineM(center, from);
        if (d < bestDist) {
          bestDist = d;
          best = { f, center };
        }
      }
      return best;
    };

    const routesData: FeatureCollection = {
      type: "FeatureCollection",
      features: [],
    };

    let redPins: maplibregl.Marker[] = [];

    // Иконки/подписи POI — canvas-картинки, регистрируются в map.addImage.
    // Синхронно (canvas 2d), поэтому можно и по событию styleimagemissing.
    const registerPoiImages = (t: Theme) => {
      if (!map || !map.isStyleLoaded()) return;
      for (const type of Object.keys(POI_TO_ICON)) {
        const name = poiIconName(t, POI_TO_ICON[type]);
        if (map.hasImage(name)) continue;
        map.addImage(name, makePoiIconImage(type, t), {
          pixelRatio: POI_PIXEL_RATIO,
        });
      }
    };
    const ensurePoiLabelImage = (t: Theme, text: string): string => {
      const name = poiLabelImageName(t, text);
      if (map?.hasImage(name)) return name;
      if (map?.isStyleLoaded()) {
        map.addImage(name, makePoiLabelImage(t, text), {
          pixelRatio: POI_PIXEL_RATIO,
        });
      }
      return name;
    };

    // Векторный источник требует явного слоя tippecanoe; geojson — нет.
    const buildingSourceLayer = tileMode ? { "source-layer": "buildings" } : {};

    try {
      map = new maplibregl.Map({
      container,
      // На 1× мониторах (десктоп) без сглаживания кромки зданий и подписей
      // «рвутся». На телефонах DPR 2–3 уже даёт сглаживание, поэтому там
      // antialias не включаем — экономим батарею и GPU.
      // В MapLibre 6 опция живёт в canvasContextAttributes (top-level
      // antialias удалён), остальные атрибуты контекста берутся по умолчанию.
      canvasContextAttributes: {
        antialias:
          typeof window !== "undefined" && window.devicePixelRatio < 1.5,
      },
      style: {
        version: 8,
        light: MAP_LIGHT[themeRef.current],
        sky: MAP_FOG[themeRef.current],
        sources: {
          basemap: {
            type: "vector",
            // Тайлы нарезаны до z14 (-d14): с z14.1 MapLibre делает
            // мгновенный overzoom уже загруженного тайла z14 и не шлёт
            // запросы за z15–16 — подлёт к дому без «квадратов».
            url: `pmtiles://${new URL(BASEMAP_URL, window.location.href).href}`,
            minzoom: 6,
            maxzoom: 14,
          },
          // Зоны, POI и деревья — единые тайлы z8–14 без разрезов по районам.
          overlays: {
            type: "vector",
            url: `pmtiles://${new URL(OVERLAYS_URL, window.location.href).href}`,
            minzoom: 8,
            maxzoom: 14,
          },
          glow: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
          // Пилюли-подписи ближайших к выбранному дому POI.
          poiLabels: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
            // Отдельная геометрия выбранного дома и тонкого контура его крыши (~1.5 px).
            selectedBuilding: {
              type: "geojson",
              maxzoom: 16,
              data: { type: "FeatureCollection", features: [] },
            },
            selectedRoofEdge: {
              type: "geojson",
              maxzoom: 16,
              data: { type: "FeatureCollection", features: [] },
            },
          buildings: {
            type: "vector",
            // addProtocol ждёт абсолютный URL, страница живёт в подпапке.
            url: `pmtiles://${new URL(BUILDINGS_URL, window.location.href).href}`,
            minzoom: 9,
            // Данные до z14: на z14.1–18 — overzoom тайла z14 из RAM.
            maxzoom: 14,
          },
          routes: { type: "geojson", data: routesData },
          isochrone: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
        },
        layers: [
          // Полноценная подложка: земля, парки, вода, улицы (локальный OSM).
          ...basemapLayers(palette),
          {
            // Настоящий Neon: широкий размытый ореол (line-blur) поверх
            // магистралей и ж/д. LOD по классам (z8 trunk/primary, z12
            // secondary) уже в тайлах overlays.pmtiles — фильтр только по kind.
            id: "redzones-glow",
            type: "line",
            source: OVERLAYS_SOURCE,
            "source-layer": "redzones",
            minzoom: REDZONE_MIN_ZOOM,
            filter: ["in", ["get", "kind"], ["literal", ["road", "railway"]]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": palette.redzone,
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                9,
                4.5,
                12,
                8,
                14,
                13,
                17.5,
                24,
              ],
              "line-blur": [
                "interpolate",
                ["linear"],
                ["zoom"],
                9,
                3.5,
                12,
                6,
                14,
                9,
                17.5,
                16,
              ],
              "line-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                9,
                themeRef.current === "dark" ? 0.34 : 0.26,
                14,
                themeRef.current === "dark" ? 0.32 : 0.24,
                17.5,
                themeRef.current === "dark" ? 0.38 : 0.3,
              ],
            },
          },
          {
            // Ядро — узкая яркая линия поверх ореола: «свечение + чёткая линия».
            id: "redzones-core",
            type: "line",
            source: OVERLAYS_SOURCE,
            "source-layer": "redzones",
            minzoom: REDZONE_MIN_ZOOM,
            filter: ["in", ["get", "kind"], ["literal", ["road", "railway"]]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": palette.redzone,
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                9,
                0.9,
                12,
                1.6,
                14,
                2.2,
                16,
                3.0,
              ],
              "line-opacity": 0.9,
            },
          },
          {
            id: "redzones-fill",
            type: "fill",
            source: OVERLAYS_SOURCE,
            "source-layer": "redzones",
            minzoom: REDZONE_FILL_MIN_ZOOM,
            filter: [
              "in",
              ["get", "kind"],
              ["literal", ["industrial", "construction"]],
            ],
            paint: {
              "fill-color": palette.redzone,
              "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.1, 17.5, 0.16],
            },
          },
          {
            id: "redzones-road",
            type: "line",
            source: OVERLAYS_SOURCE,
            "source-layer": "redzones",
            minzoom: REDZONE_MIN_ZOOM,
            filter: ["==", ["get", "kind"], "road"],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": palette.redzone,
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                9,
                1.0,
                14,
                1.6,
                17.5,
                2.8,
              ],
              "line-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                9,
                0.4,
                14,
                0.48,
                17.5,
                0.62,
              ],
            },
          },
          {
            // Ж/д — фоновый слой: тонкий пунктир, чтобы не шумел (FX-3).
            id: "redzones-rail",
            type: "line",
            source: OVERLAYS_SOURCE,
            "source-layer": "redzones",
            minzoom: REDZONE_MIN_ZOOM,
            filter: ["==", ["get", "kind"], "railway"],
            paint: {
              "line-color": palette.redzone,
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                9,
                1.0,
                14,
                1.6,
                17.5,
                2.8,
              ],
              "line-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                9,
                0.4,
                14,
                0.48,
                17.5,
                0.6,
              ],
              "line-dasharray": [3, 3],
            },
          },
          {
            // Изохрона — под зданиями, чтобы 3D-дома не перекрывались.
            id: "isochrone-fill",
            type: "fill",
            source: "isochrone",
            paint: {
              "fill-color": palette.iso,
              "fill-opacity": 0.14,
            },
          },
          {
            id: "isochrone-line",
            type: "line",
            source: "isochrone",
            paint: {
              "line-color": palette.iso,
              "line-width": 1.5,
              "line-opacity": 0.8,
            },
          },
          {
            // Мягкое свечение у основания выбранного дома (эллипс в плоскости земли):
            // ночь — тёпло-зелёное, суммарная opacity 0.20–0.25; день — 0.10–0.12.
            id: "glow-outer",
            type: "circle",
            source: "glow",
            minzoom: 14,
            paint: {
              "circle-color": palette.selected,
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 28, 17, 76],
              "circle-opacity": themeRef.current === "dark" ? 0.13 : 0.06,
              "circle-blur": 1,
              "circle-pitch-alignment": "map",
            },
          },
          {
            id: "glow-inner",
            type: "circle",
            source: "glow",
            minzoom: 14,
            paint: {
              "circle-color": palette.selected,
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 14, 17, 38],
              "circle-opacity": themeRef.current === "dark" ? 0.1 : 0.05,
              "circle-blur": 0.85,
              "circle-pitch-alignment": "map",
            },
          },
          // Мягкая многослойная тень под домами: 3 плоских fill со сдвигом
          // [3,3]..[6,6], плавно проявляется с z14.8 к z16.
          ...BUILDING_SHADOW_LAYERS.map((s) => ({
            id: s.id,
            type: "fill" as const,
            source: "buildings",
            minzoom: BUILDING_SHADOW_MIN_ZOOM,
            ...buildingSourceLayer,
            paint: {
              "fill-color": palette.shadow,
              "fill-opacity": buildingShadowOpacityExpr(s.opacity[themeRef.current]),
              "fill-translate": s.translate,
              "fill-translate-anchor": "viewport" as const,
              "fill-antialias": false,
            },
          })),
          {
            // Мягкое свечение по footprint у основания выбранного дома.
            id: "outline-halo",
            type: "line",
            source: "buildings",
            minzoom: BUILDING_MIN_ZOOM,
            ...buildingSourceLayer,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": palette.halo,
              "line-width": ["interpolate", ["linear"], ["zoom"], 14, 10, 17, 22],
              "line-blur": ["interpolate", ["linear"], ["zoom"], 14, 7, 17, 15],
              "line-opacity": [
                "case",
                ["to-boolean", ["feature-state", "selected"]],
                themeRef.current === "dark" ? 0.18 : 0.09,
                0,
              ],
            },
          },
          {
            // Спокойный тонкий контур у основания выбранного дома (1.6 px, opacity 0.55).
            id: "outline-core",
            type: "line",
            source: "buildings",
            minzoom: BUILDING_MIN_ZOOM,
            ...buildingSourceLayer,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": palette.outlineCore,
              "line-width": 1.6,
              "line-opacity": [
                "case",
                ["to-boolean", ["feature-state", "selected"]],
                0.55,
                0,
              ],
            },
          },
          // V4b6: три концентрических обводки по footprint выбранного дома
          // на земле, под зданиями. Источник selectedBuilding уже содержит
          // полный контур, поэтому свет переезжает вместе с выбором.
          ...GLOW_RINGS.map((ring) => ({
            id: ring.id,
            type: "line" as const,
            source: "selectedBuilding",
            minzoom: FACADE_COARSE_MIN_ZOOM,
            layout: {
              "line-cap": "round" as const,
              "line-join": "round" as const,
            },
            paint: {
              "line-color": GLOW_GROUND_COLOR,
              "line-width": glowZoomScale(ring.width) as never,
              "line-blur": ring.blur,
              "line-opacity": glowRingOpacity(
                ring.opacity,
                themeRef.current,
              ) as never,
            },
          })),
          {
            // Яркая «неоновая» кромка по краю footprint — без blur.
            id: GLOW_EDGE_LAYER_ID,
            type: "line",
            source: "selectedBuilding",
            minzoom: FACADE_COARSE_MIN_ZOOM,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": GLOW_EDGE_COLOR,
              "line-width": ["interpolate", ["linear"], ["zoom"], 15.4, 2, 18, 2.5] as never,
              "line-opacity": themeRef.current === "dark" ? 0.5 : 0.08,
            },
          },
          {
            id: "buildings",
            type: "fill-extrusion",
            source: "buildings",
            minzoom: BUILDING_MIN_ZOOM,
            ...buildingSourceLayer,
            paint: {
              // fill-extrusion-color поддерживает feature-state,
              // fill-extrusion-opacity — нет, поэтому затемнение через цвет.
              "fill-extrusion-color": buildingColorExpr(
                palette,
                colorStops,
                themeRef.current === "dark" ? palette.selectedBody : null,
              ),
              "fill-extrusion-height": buildingExtrusionHeightExpr(),
              "fill-extrusion-base": 0,
              "fill-extrusion-opacity": 0.95,
              "fill-extrusion-vertical-gradient": true,
            },
          },
          {
            // Выбранный дом: корпус со спокойными окнами в обеих темах.
            id: "buildings-selected-body",
            type: "fill-extrusion",
            source: "selectedBuilding",
            minzoom: BUILDING_MIN_ZOOM,
            paint: {
              "fill-extrusion-color":
                themeRef.current === "dark"
                  ? palette.selectedBody
                  : (selectedStepColorsExpr(palette, colorStops, 0) as never),
              "fill-extrusion-base": 0,
              "fill-extrusion-height": ["coalesce", ["get", "height"], 9] as never,
              "fill-extrusion-opacity": 0.95,
              "fill-extrusion-vertical-gradient": true,
            },
          },
          {
            // Крыша обычных домов: тонкая плита поверх фасада (в светлой теме — почти нейтральная светлая).
            id: "buildings-roof",
            type: "fill-extrusion",
            source: "buildings",
            minzoom: BUILDING_MIN_ZOOM,
            ...buildingSourceLayer,
            paint: {
              "fill-extrusion-color": buildingRoofColorExpr(palette, colorStops),
              "fill-extrusion-base": buildingRoofBaseExpr(),
              "fill-extrusion-height": buildingRoofHeightExpr(),
              "fill-extrusion-opacity": 0.95,
              "fill-extrusion-vertical-gradient": false,
            },
          },
          {
            // Тонкий контур крыши выбранного дома (~1.5 px, спокойный зелёный, opacity 0.7):
            // лежит чуть ниже крыши buildings-selected-roof и выступает только по внешнему периметру.
            id: "buildings-selected-roof-edge",
            type: "fill-extrusion",
            source: "selectedRoofEdge",
            minzoom: BUILDING_MIN_ZOOM,
            paint: {
              "fill-extrusion-color": palette.outlineCore,
              "fill-extrusion-base": ["coalesce", ["get", "height"], 9] as never,
              "fill-extrusion-height": ["+", ["coalesce", ["get", "height"], 9], 0.28] as never,
              "fill-extrusion-opacity": 0.7,
              "fill-extrusion-vertical-gradient": false,
            },
          },
          {
            // Крыша выбранного дома: яркий цвет ступени дома (на 5% светлее), не мятная.
            // Перекрывает внутреннюю часть крыши и любые стыки тайлов.
            id: "buildings-selected-roof",
            type: "fill-extrusion",
            source: "selectedBuilding",
            minzoom: BUILDING_MIN_ZOOM,
            paint: {
              "fill-extrusion-color": selectedStepColorsExpr(palette, colorStops, 0.05) as never,
              "fill-extrusion-base": ["coalesce", ["get", "height"], 9] as never,
              "fill-extrusion-height": ["+", ["coalesce", ["get", "height"], 9], 0.35] as never,
              "fill-extrusion-opacity": 1,
              "fill-extrusion-vertical-gradient": false,
            },
          },
          {
            // V4b6: подсветка нижнего пояса стен (0.6–0.9 м). Выше — обычный
            // фасад. Только тёмная тема, над зданиями и под маршрутами/зонами.
            id: GLOW_BASE_LAYER_ID,
            type: "fill-extrusion",
            source: "selectedBuilding",
            minzoom: FACADE_COARSE_MIN_ZOOM,
            layout: {
              visibility: themeRef.current === "dark" ? "visible" : "none",
            },
            paint: {
              "fill-extrusion-color": GLOW_GROUND_COLOR,
              "fill-extrusion-base": 0,
              "fill-extrusion-height": 0.9,
              "fill-extrusion-opacity": 0.2,
              "fill-extrusion-vertical-gradient": false,
            },
          },
          {
            id: "routes-glow",
            type: "line",
            source: "routes",
            filter: ["==", ["geometry-type"], "LineString"],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": palette.route,
              "line-width": ["interpolate", ["linear"], ["zoom"], 14, 10, 17.5, 24],
              "line-blur": ["interpolate", ["linear"], ["zoom"], 14, 6, 17.5, 15],
              "line-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                14,
                themeRef.current === "dark" ? 0.26 : 0.22,
                17.5,
                themeRef.current === "dark" ? 0.36 : 0.3,
              ],
            },
          },
          {
            id: "routes-line",
            type: "line",
            source: "routes",
            filter: ["==", ["geometry-type"], "LineString"],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": palette.route,
              "line-width": ["interpolate", ["linear"], ["zoom"], 14, 3.2, 17.5, 5.8],
              "line-opacity": 0.88,
            },
          },
          {
            id: "routes-dots",
            type: "line",
            source: "routes",
            filter: ["==", ["geometry-type"], "LineString"],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": palette.routeCore,
              "line-width": ["interpolate", ["linear"], ["zoom"], 14, 2, 17.5, 3.6],
              "line-opacity": 0.95,
            },
          },
          // POI — symbol-слои поверх зданий: иконки категорий и подписи.
          ...poiLayers(themeRef.current),
        ],
      },
      // Демонстрационный ракурс «диорама»: плотный квартал, парк и река.
      center: [37.554, 55.756],
      zoom: 15.35,
      pitch: 55,
      bearing: -25,
      maxPitch: 58,
      // Perf-1: тайлы появляются сразу, без 300-мс «всплытия» по одному
      // (на 20 тайлах это читалось как «карта дёргается кусками»).
      // 0 не дало заметного мерцания — оставляем его.
      fadeDuration: 0,
      // PERF-3-TILECACHE: при pitch 60° в кадре ~30 тайлов, и на резком
      // сдвиге камеры MapLibre выбрасывал родительские тайлы z9–13 и
      // соседние кварталы — на новом квадрате z14 до прихода тайла был
      // виден обрыв дороги/магистрали. Щедрый кэш (600 тайлов, 8 зум-
      // уровней) держит соседние кварталы в памяти, а движение по тому же
      // месту не грузит тайлы заново (проверено сетевым логом).
      maxTileCacheSize: 600,
      maxTileCacheZoomLevels: 8,
      // Не отменяем уже начатые запросы тайлов при зуме: отмена давала
      // «дыры» в кадре и повторную загрузку того же тайла.
      cancelPendingTileRequestsWhileZooming: false,
      attributionControl: false,
      });
    } catch (e) {
      console.error("WebGL-контекст не создан:", e);
      if (!cancelled) {
        setFatalError(
          "Не удалось запустить WebGL2. Проверьте, что браузер и устройство поддерживают WebGL2, и обновите страницу.",
        );
      }
      return;
    }

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    // Подписи улиц/воды: DOM-маркеры (без глиф-PBF). Пересобираем после
    // движения карты: за время анимации маркеры едут вместе с точкой.
    let labelMarkers: maplibregl.Marker[] = [];
    // Угол подписи — экранный, он меняется на каждом кадре при bearing/pitch,
    // поэтому храним отрезок и внутренний div и пересчитываем в "move".
    const labelMeta: { inner: HTMLDivElement; a: [number, number]; b: [number, number] }[] =
      [];
    const screenAngle = (a: [number, number], b: [number, number]) => {
      if (!map || (a[0] === b[0] && a[1] === b[1])) return 0;
      const p1 = map.project(a);
      const p2 = map.project(b);
      let angle = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      return angle;
    };
    const syncLabelAngles = () => {
      if (!map) return;
      for (const m of labelMeta) {
        const angle = screenAngle(m.a, m.b);
        m.inner.style.transform = `rotate(${angle.toFixed(1)}deg)`;
        // Почти вертикальные подписи читаются хуже, чем отсутствие.
        m.inner.style.visibility = Math.abs(angle) > 68 ? "hidden" : "";
      }
    };
    const rebuildLabels = () => {
      if (!map) return;
      labelMarkers.forEach((m) => m.remove());
      labelMarkers = [];
      labelMeta.length = 0;
      const p = MAP_THEMES[themeRef.current];
      const zoom = map.getZoom();
      if (zoom < DECOR_MIN_ZOOM) return;
      const size = zoom >= 16 ? 13.5 : zoom >= 14.2 ? 12.5 : 11.5;
      const width = map.getContainer().clientWidth;
      const height = map.getContainer().clientHeight;
      const boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
      const maxLabels = width < 600 ? 14 : 20;
      const sorted = [...labelCandidates].sort((a, b) => b.importance - a.importance);
      for (const c of sorted) {
        if (labelMarkers.length >= maxLabels) break;
        if (c.kind === "street" && zoom < 14) continue;
        if (c.kind === "park" && zoom < 15) continue;
        if (c.kind === "water" && zoom < 12.8) continue;
        const mid: [number, number] = [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2];
        const pt = map.project(mid);
        const bw = Math.min(240, c.name.length * size * 0.62 + 8);
        const bh = size + 6;
        // Подпись целиком в кадре: половинки слов на краю выглядят как баг.
        if (
          pt.x - bw / 2 < 2 ||
          pt.y - bh / 2 < 2 ||
          pt.x + bw / 2 > width - 2 ||
          pt.y + bh / 2 > height - 2
        ) {
          continue;
        }
        const angle = screenAngle(c.a as [number, number], c.b as [number, number]);
        if (Math.abs(angle) > 68) continue;
        const rad = (angle * Math.PI) / 180;
        const boxW = Math.abs(bw * Math.cos(rad)) + Math.abs(bh * Math.sin(rad));
        const boxH = Math.abs(bw * Math.sin(rad)) + Math.abs(bh * Math.cos(rad));
        const box = {
          x1: pt.x - boxW / 2,
          y1: pt.y - boxH / 2,
          x2: pt.x + boxW / 2,
          y2: pt.y + boxH / 2,
        };
        if (
          boxes.some(
            (b) => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2),
          )
        ) {
          continue;
        }
        boxes.push(box);

        const color =
          c.kind === "water" ? p.labelWater : c.kind === "park" ? p.poiGreen : p.label;
        const halo = c.kind === "water" ? p.labelWaterHalo : p.labelHalo;
        const wrap = document.createElement("div");
        wrap.style.cssText = "pointer-events:none;z-index:0;transition:opacity 120ms linear;";
        const inner = document.createElement("div");
        inner.textContent = c.name;
        inner.style.cssText = [
          `transform: rotate(${angle.toFixed(1)}deg)`,
          "white-space: nowrap",
          "font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          `font-size: ${size}px`,
          "font-weight: 600",
          `font-style: ${c.kind === "water" ? "italic" : "normal"}`,
          `color: ${color}`,
          "line-height: 1",
          "letter-spacing: 0.01em",
          `text-shadow: -1.2px -1.2px 0 ${halo}, 1.2px -1.2px 0 ${halo}, -1.2px 1.2px 0 ${halo}, 1.2px 1.2px 0 ${halo}, 0 0 2px ${halo}`,
        ].join(";");
        wrap.append(inner);
        labelMarkers.push(
          new maplibregl.Marker({ element: wrap, anchor: "center" })
            .setLngLat(mid)
            .addTo(map),
        );
        labelMeta.push({ inner, a: c.a as [number, number], b: c.b as [number, number] });
      }
    };
    map.on("moveend", rebuildLabels);
    map.on("resize", rebuildLabels);
    // Угол подписи экранный: bearing/pitch меняют его на каждом кадре, поэтому
    // пересчитываем его в "move" (≤20 маркеров, ≤40 project за кадр).
    // Скрывать на rotatestart бессмысленно: Marker#_updateOpacity на каждом
    // "move" возвращает element.style.opacity к 1 и стирает нашу установку.
    map.on("move", syncLabelAngles);
    (window as unknown as { __rebuildLabels?: () => void }).__rebuildLabels = rebuildLabels;

    // Подложка приходит параллельно: как только она есть — подставляем
    // данные и подписи, не задерживая открытие карты с домами.
    // setData до готовности стиля MapLibre может проигнорировать, поэтому
    // ждём load и запоминаем данные.
    let basemapRefreshPending = false;
    const refreshBasemapDecorations = () => {
      if (cancelled || !map || basemapRefreshPending) return;
      // PERF-LOAD: во время движения сбор фич не нужен — по остановке его
      // всё равно вызовет moveend/idle, а лишний проход рвёт кадр.
      if (map.isMoving()) return;
      basemapRefreshPending = true;
      // Пачка догрузившихся тайлов должна обрабатываться один раз, а не на
      // каждый тайл: короткий дебаунс вместо мгновенного requestAnimationFrame.
      if (basemapDecorTimer !== null) window.clearTimeout(basemapDecorTimer);
      basemapDecorTimer = window.setTimeout(() => {
        basemapDecorTimer = null;
        basemapRefreshPending = false;
        if (cancelled || !map || map.isMoving()) return;
        // BM-LOW: ниже DECOR_MIN_ZOOM подписи не рисуются вовсе, а сбор
        // кандидатов — самое дорогое в кадре: querySourceFeatures по
        // всей подложке на обзоре отдаёт ~85 тыс. фич и ~20 МБ geometry-JSON,
        // и это повторяется на каждый moveend/idle/загрузку тайла. Пропускаем.
        if (map.getZoom() < DECOR_MIN_ZOOM) {
          labelCandidates = [];
          return;
        }
        const seen = new Set<string>();
        const features: GFeature<BasemapProps>[] = [];
        // PERF-3-TILECACHE: в кэше 600 тайлов; подписи нужны только
        // вокруг текущего экрана — отсекаем фичи вне bounds с запасом,
        // иначе buildLabelCandidates перебирает кварталы за кадром.
        const bounds = map.getBounds();
        const padDeg = 0.01;
        const west = bounds.getWest() - padDeg;
        const east = bounds.getEast() + padDeg;
        const south = bounds.getSouth() - padDeg;
        const north = bounds.getNorth() + padDeg;
        // PERF-LOAD: landuse и waterway в buildLabelCandidates не читаются —
        // не опрашиваем их вовсе.
        for (const sourceLayer of ["green", "water", "river", "road"]) {
          for (const feature of map.querySourceFeatures("basemap", {
            sourceLayer,
            // Фильтр на стороне MapLibre: без него на каждый вызов в JS
            // создаются тысячи безымянных GeoJSONFeature из всех
            // закэшированных тайлов.
            filter: ["has", "name"] as never,
          })) {
            const properties = feature.properties as unknown as
              | BasemapProps
              | undefined;
            if (!properties) continue;
            const name = properties.name;
            // Безымянные сегменты дорог/воды и green в подписи не годятся.
            if (!name) continue;
            // Фичи за пределами экрана (с запасом) в подписи не попадут.
            if (!geometryInBounds(feature.geometry, west, south, east, north)) continue;
            // Ключ без полной геометрии: sourceLayer + класс + имя +
            // id/начало геометрии достаточно, чтобы отсечь дубли на стыках.
            const key = `${sourceLayer}/${properties.class ?? ""}/${name}/${feature.id ?? ""}/${firstCoordinateKey(feature.geometry)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            let stableId = 2166136261;
            for (let i = 0; i < key.length; i++) {
              stableId = Math.imul(stableId ^ key.charCodeAt(i), 16777619);
            }
            features.push({
              type: "Feature",
              geometry: feature.geometry,
              properties,
              ...{ id: feature.id ?? (stableId >>> 0) },
            } as GFeature<BasemapProps>);
          }
        }
        labelCandidates = buildLabelCandidates(features);
        rebuildLabels();
      }, 45);
    };
    map.on("sourcedata", (event) => {
      if (
        event.sourceId === "basemap" &&
        (event.tile || event.isSourceLoaded) &&
        map &&
        !map.isMoving()
      ) {
        refreshBasemapDecorations();
      }
    });
    map.on("idle", refreshBasemapDecorations);
    map.on("moveend", refreshBasemapDecorations);

    // --- Фоновый префетчер соседних тайлов («чанки мира» в RAM) ---------
    // Резкий рывок камеры на 3–10 км не должен ждать сеть: после остановки
    // камеры тихо догружаем в RAM-кэш кольцо соседних тайлов текущего зума
    // и родительские тайлы z-1/z-2. MapLibre об этой загрузке не знает,
    // отрисовку она не блокирует и прерывается новым движением камеры.
    const PREFETCH_SOURCES = [BASEMAP_URL, OVERLAYS_URL, BUILDINGS_URL] as const;
    const PREFETCH_CONCURRENCY = 4;
    // Кольцо вокруг экрана на текущем зуме: на z14 это ~12×12 км вокруг.
    const PREFETCH_MARGIN = 2;
    const PREFETCH_PARENT_MARGIN = 1;
    // Предохранитель от безумных bounds (низкий зум/полюса).
    const PREFETCH_MAX_SPAN = 32;
    const pmtilesTileUrl = (base: string, z: number, x: number, y: number) =>
      `pmtiles://${new URL(base, window.location.href).href}/${z}/${x}/${y}`;

    const collectPrefetchUrls = (): string[] => {
      if (!map) return [];
      const bounds = map.getBounds();
      const zoom = Math.min(14, Math.max(9, Math.floor(map.getZoom())));
      const west = bounds.getWest();
      const east = bounds.getEast();
      const north = bounds.getNorth();
      const south = bounds.getSouth();
      const urls = new Set<string>();

      const addRange = (
        z: number,
        x0: number,
        x1: number,
        y0: number,
        y1: number,
        margin: number,
      ) => {
        const n = 2 ** z;
        const fromX = Math.max(0, x0 - margin);
        const toX = Math.min(n - 1, x1 + margin);
        const fromY = Math.max(0, y0 - margin);
        const toY = Math.min(n - 1, y1 + margin);
        if (toX - fromX >= PREFETCH_MAX_SPAN || toY - fromY >= PREFETCH_MAX_SPAN) return;
        for (let x = fromX; x <= toX; x++) {
          for (let y = fromY; y <= toY; y++) {
            for (const base of PREFETCH_SOURCES) urls.add(pmtilesTileUrl(base, z, x, y));
          }
        }
      };

      // 1) Кольцо соседних тайлов вокруг экрана на текущем зуме.
      const [x0] = lonLatToTileXY(west, south, zoom);
      const [x1] = lonLatToTileXY(east, south, zoom);
      const [, y0] = lonLatToTileXY(west, north, zoom);
      const [, y1] = lonLatToTileXY(west, south, zoom);
      addRange(zoom, x0, x1, y0, y1, PREFETCH_MARGIN);

      // 2) Родительские тайлы: дешевле и нужны при отлёте камеры.
      for (const pz of [Math.max(9, zoom - 1), Math.max(9, zoom - 2)]) {
        if (pz >= zoom) continue;
        const [px0] = lonLatToTileXY(west, south, pz);
        const [px1] = lonLatToTileXY(east, south, pz);
        const [, py0] = lonLatToTileXY(west, north, pz);
        const [, py1] = lonLatToTileXY(west, south, pz);
        addRange(pz, px0, px1, py0, py1, PREFETCH_PARENT_MARGIN);
      }
      return [...urls];
    };

    const runTilePrefetch = () => {
      if (!map || map.isMoving()) return;
      const token = ++tilePrefetchToken;
      const queue = collectPrefetchUrls().filter((u) => !pmtilesRamCache.has(u));
      if (!queue.length) return;
      let cursor = 0;
      const worker = async () => {
        while (cursor < queue.length) {
          // Движение камеры или новый прогон — тихо останавливаемся.
          if (token !== tilePrefetchToken || !map || map.isMoving()) return;
          const url = queue[cursor++];
          if (pmtilesRamCache.has(url)) continue;
          await fetchPmtilesTile(url).catch(() => undefined);
        }
      };
      void Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
    };

    const scheduleTilePrefetch = () => {
      if (!map) return;
      if (tilePrefetchTimer !== null) window.clearTimeout(tilePrefetchTimer);
      tilePrefetchTimer = window.setTimeout(() => {
        tilePrefetchTimer = null;
        runTilePrefetch();
      }, 200);
    };
    map.on("idle", scheduleTilePrefetch);
    map.on("moveend", scheduleTilePrefetch);

    // Источник изохроны: максимум одна фича (полигон выбранного времени).
    setIsoSourceRef.current = (geom) => {
      const src = map?.getSource("isochrone") as maplibregl.GeoJSONSource | null;
      if (!src) return;
      src.setData({
        type: "FeatureCollection",
        features: geom ? [{ type: "Feature", properties: {}, geometry: geom }] : [],
      } as never);
    };
    map.on("error", (e) => {
      console.error("map error:", e.error ?? e);
      const sourceId = (e as unknown as { sourceId?: string }).sourceId;
      if (sourceId === "buildings" || sourceId === "basemap") {
        setFatalError(
          "Не удалось прочитать городские PMTiles. Обновите страницу или сообщите о проблеме.",
        );
      }
    });
    (window as unknown as { __map?: maplibregl.Map }).__map = map;

    // Если картинка POI понадобилась раньше регистрации (стиль грузится
    // параллельно) — дорисовываем её синхронно по имени.
    map.on("styleimagemissing", (e) => {
      if (!map) return;
      if (map.hasImage(e.id)) return;
      const iconMatch = /^poi-(light|dark)-(.+)$/.exec(e.id);
      if (iconMatch) {
        const type = Object.keys(POI_TO_ICON).find(
          (key) => POI_TO_ICON[key] === (iconMatch[2] as IconKey),
        );
        if (type) {
          map.addImage(e.id, makePoiIconImage(type, iconMatch[1] as Theme), {
            pixelRatio: POI_PIXEL_RATIO,
          });
        }
        return;
      }
      const labelMatch = /^poi-label-(light|dark)-([\s\S]+)$/.exec(e.id);
      if (labelMatch) {
        map.addImage(e.id, makePoiLabelImage(labelMatch[1] as Theme, labelMatch[2]), {
          pixelRatio: POI_PIXEL_RATIO,
        });
      }
    });

    // Зоны, POI и деревья приходят из overlays.pmtiles: подгрузок по районам
    // на скролле нет. Кэш районов наполняется только при выборе дома.
    // Заставка: убираем, когда карта отрисована (idle) или через 2 с —
    // что раньше.
    const hideSplash = () => setSplash((s) => (s === "show" ? "fade" : s));
    map.once("idle", hideSplash);
    window.setTimeout(hideSplash, 2000);

    const rebuildOverlays = (sel: SelectedBuilding | null, vis: Visibility) => {
      if (!map) return;
      const theme = MAP_THEMES[themeRef.current];
      const themeName = themeRef.current;
      redPins.forEach((m) => m.remove());
      redPins = [];

      const selCenter = sel ? (buildingCenters[sel.id] ?? null) : null;

      // Подписи POI — не DOM, а пилюли-картинки symbol-слоя: только у
      // ближайшего к выбранному дому POI в каждой видимой категории.
      const labelFeatures: Feature[] = [];
      if (sel && selCenter) {
        for (const cat of BONUS_KEYS) {
          const layerKey = BONUS_TO_LAYER[cat];
          if (layerKey && !vis[layerKey]) continue;
          const target = nearestPoi(cat, selCenter);
          if (!target) continue;
          const entry = sel.breakdown?.bonuses?.[cat];
          const minutes = routesRef.current?.[cat]?.minutes ?? entry?.minutes;
          if (minutes == null) continue;
          const type = target.f.properties.type;
          const text = `${POI_LABELS[type] ?? type} · ${Math.round(minutes)} мин`;
          labelFeatures.push({
            type: "Feature",
            properties: { icon: ensurePoiLabelImage(themeName, text) },
            geometry: { type: "Point", coordinates: target.center },
          });
        }
      }
      (map.getSource(POI_LABEL_SOURCE) as maplibregl.GeoJSONSource | null)?.setData({
        type: "FeatureCollection",
        features: labelFeatures,
      } as never);

      if (sel?.breakdown && selCenter) {
        // Ищем по видимым районам и району выбранного дома, а не по всему кэшу города.
        const redzonePool = loadedRedzoneFeatures(sel.id);
        for (const [key, entry] of Object.entries(sel.breakdown.penalties ?? {})) {
          if (!entry || entry.penalty >= RED_FLAG_PENALTY) continue;
          const kind = PENALTY_TO_KIND[key];
          if (!kind) continue;
          let bestPt: Position | null = null;
          let bestDist = Infinity;
          for (const rz of redzonePool) {
            if (rz.properties.kind !== kind) continue;
            const np = nearestPosition(rz.geometry, selCenter);
            if (np && np.dist < bestDist) {
              bestDist = np.dist;
              bestPt = np.point;
            }
          }
          if (!bestPt) continue;
          const d = Number.isFinite(entry.distance_m) ? Math.round(entry.distance_m) : null;
          const text = `${PENALTY_LABELS[key] ?? key} · ${d !== null && d >= 0 ? `${d} м` : "рядом"}`;
          redPins.push(
            new maplibregl.Marker({
              element: makeRedPinEl(text, theme.redPill, theme.redIcon),
              anchor: "bottom",
            })
              .setLngLat(bestPt as [number, number])
              .addTo(map),
          );
        }
      }

      const routeFeatures: Feature[] = [];
      if (selCenter) {
        const cached = routesRef.current;
        for (const cat of BONUS_KEYS) {
          const layerKey = BONUS_TO_LAYER[cat];
          if (layerKey && !vis[layerKey]) continue;
          const target = nearestPoi(cat, selCenter);
          if (!target) continue;
          const entry = cached?.[cat];
          // Реальная геометрия Valhalla; дуга Безье — фолбэк, пока файл
          // маршрутов догружается (или если он недоступен).
          const coordinates = entry?.coordinates ?? curvedLine(selCenter, target.center);
          routeFeatures.push({
            type: "Feature",
            properties: { category: cat },
            geometry: { type: "LineString", coordinates },
          });
          const endPt = coordinates[coordinates.length - 1] ?? target.center;
          routeFeatures.push({
            type: "Feature",
            properties: { category: cat, kind: "endpoint" },
            geometry: { type: "Point", coordinates: endPt },
          });
        }
      }
      routesData.features = routeFeatures;
      (map.getSource("routes") as maplibregl.GeoJSONSource | null)?.setData(routesData);
    };

    applyVisibilityRef.current = (v: Visibility) => {
      if (!map) return;
      if (map.getLayer("redzones-road")) {
        // Видимость красных зон = флаг слоя (LOD по зуму — в тайлах).
        syncRedzoneVisibility();
      }
      if (map.getLayer("routes-line")) {
        const rt = v.routes ? "visible" : "none";
        map.setLayoutProperty("routes-glow", "visibility", rt);
        map.setLayoutProperty("routes-line", "visibility", rt);
        map.setLayoutProperty("routes-dots", "visibility", rt);
      }
      for (const def of POI_LAYER_DEFS) {
        if (map.getLayer(def.id)) {
          map.setLayoutProperty(def.id, "visibility", v[def.flag] ? "visible" : "none");
        }
      }
      rebuildOverlays(selectedRef.current, v);
    };

    const addFacadeImages = (t: Theme) => {
      if (!map) return;
      const p = MAP_THEMES[t];
      const selectedStepColor: Record<FacadeStep, string> = {
        vlow: p.selectedVlow,
        low: p.selectedLow,
        mid: p.selectedMid,
        high: p.selectedHigh,
        vhigh: p.selectedVhigh,
      };
      const lods: FacadeLod[] = ["flat", "subtle", "coarse", "fine"];
      const add = (variant: FacadeVariant, baseColor: string, lod: FacadeLod) => {
        const name = facadeImageName(t, variant, lod);
        if (map?.getImage(name)) return;
        map?.addImage(name, makeFacadeImage(baseColor, t, variant, lod), {
          pixelRatio: facadePixelRatio(lod),
        });
      };
      for (const lod of lods) {
        for (const step of FACADE_STEPS) {
          add(step, p[step], lod);
          if (t === "light") {
            add(`selected-${step}` as FacadeSelectedStep, selectedStepColor[step], lod);
          }
        }
        add("dim", p.dim, lod);
        add("other", p.other, lod);
        add("other-overview", p.otherOverview, lod);
        add("selected", p.selectedBody, lod);
      }
    };

    let currentSelectedFeatures: maplibregl.GeoJSONFeature[] = [];
    let currentSelectedId: number | null = null;
    let currentSelectedSignature: string | null = null;
    let currentSelectedArea = 0;
    let pendingFacadeBearingId: number | null = null;
    let currentRoofEdgeZoom: number | null = null;
    const selectedWindowCache = new globalThis.Map<
      number,
      { signature: string; includeHalo: boolean; data: FeatureCollection }
    >();
    const cacheSelectedWindows = (
      id: number,
      entry: { signature: string; includeHalo: boolean; data: FeatureCollection },
    ) => {
      selectedWindowCache.delete(id);
      selectedWindowCache.set(id, entry);
      if (selectedWindowCache.size > 8) {
        const oldest = selectedWindowCache.keys().next().value;
        if (oldest !== undefined) selectedWindowCache.delete(oldest);
      }
    };
    let captureToken = 0;
    let captureRequested = false;
    let captureScheduled = false;
    let selectionMovePending = false;
    let captureFrame: number | null = null;
    let pendingCaptureMoveEnd: (() => void) | null = null;
    let pendingCaptureIdle: (() => void) | null = null;

    const cancelSelectedCapture = () => {
      captureToken++;
      captureRequested = false;
      captureScheduled = false;
      selectionMovePending = false;
      if (captureFrame !== null) {
        window.cancelAnimationFrame(captureFrame);
        captureFrame = null;
      }
      if (pendingCaptureMoveEnd) {
        map?.off("moveend", pendingCaptureMoveEnd);
        pendingCaptureMoveEnd = null;
      }
      if (pendingCaptureIdle) {
        map?.off("idle", pendingCaptureIdle);
        pendingCaptureIdle = null;
      }
      return captureToken;
    };

    const refreshSelectedRoofEdge = () => {
      if (!map) return;
      const edgeSrc = map.getSource("selectedRoofEdge") as maplibregl.GeoJSONSource | null;
      if (!edgeSrc) return;
      const zoom = map.getZoom();
      if (currentRoofEdgeZoom === zoom) return;
      currentRoofEdgeZoom = zoom;
      edgeSrc.setData({
        type: "FeatureCollection",
        features: currentSelectedFeatures.length
          ? buildRoofEdgeFeatures(currentSelectedFeatures, map.getZoom())
          : [],
      } as never);
    };

    const clearSelectedWindows = () => {
      if (!map) return;
      const src = map.getSource(HERO_WINDOWS_SOURCE_ID) as maplibregl.GeoJSONSource | null;
      src?.setData({ type: "FeatureCollection", features: [] } as never);
      (
        window as unknown as { __selectedWindowsData?: FeatureCollection | null }
      ).__selectedWindowsData = null;
    };

    let currentSelectedWindowTheme: Theme | null = null;
    let currentSelectedWindowVisibility: boolean | null = null;
    let currentSelectedHaloVisibility: boolean | null = null;
    const syncSelectedWindowTheme = (t: Theme) => {
      if (!map) return;
      const colorProperty = t === "dark" ? "colorDark" : "colorLight";
      const lodVisible = facadeLodForZoom(map.getZoom()) !== "flat";
      const haloVisible =
        t === "dark" && window.matchMedia("(min-width: 768px)").matches && lodVisible;
      if (
        currentSelectedWindowTheme !== t &&
        map.getLayer(HERO_HALO_LAYER_ID)
      ) {
        map.setPaintProperty(
          HERO_HALO_LAYER_ID,
          "fill-extrusion-color",
          ["get", colorProperty] as never,
        );
      }
      if (
        currentSelectedHaloVisibility !== haloVisible &&
        map.getLayer(HERO_HALO_LAYER_ID)
      ) {
        map.setLayoutProperty(
          HERO_HALO_LAYER_ID,
          "visibility",
          haloVisible ? "visible" : "none",
        );
      }
      if (
        currentSelectedWindowTheme !== t &&
        map.getLayer(HERO_WINDOW_LAYER_ID)
      ) {
        map.setPaintProperty(
          HERO_WINDOW_LAYER_ID,
          "fill-extrusion-color",
          ["get", colorProperty] as never,
        );
      }
      if (
        currentSelectedWindowVisibility !== lodVisible &&
        map.getLayer(HERO_WINDOW_LAYER_ID)
      ) {
        map.setLayoutProperty(
          HERO_WINDOW_LAYER_ID,
          "visibility",
          lodVisible ? "visible" : "none",
        );
      }
      currentSelectedWindowTheme = t;
      currentSelectedWindowVisibility = lodVisible;
      currentSelectedHaloVisibility = haloVisible;
    };

    const rebuildSelectedWindows = (id: number, signature: string) => {
      if (!map) return;
      if (!currentSelectedFeatures.length) {
        clearSelectedWindows();
        return;
      }
      const includeHalo = window.matchMedia("(min-width: 768px)").matches;
      const cached = selectedWindowCache.get(id);
      let data =
        cached?.signature === signature && cached.includeHalo === includeHalo
          ? cached.data
          : null;
      if (data && cached) {
        selectedWindowCache.delete(id);
        selectedWindowCache.set(id, cached);
      } else {
        data = buildSelectedWindowFeatures(
          currentSelectedFeatures,
          colorStops,
          includeHalo,
        );
        cacheSelectedWindows(id, { signature, includeHalo, data });
      }
      (
        window as unknown as { __selectedWindowsData?: FeatureCollection | null }
      ).__selectedWindowsData = data.features.length ? data : null;

      const existingSource = map.getSource(
        HERO_WINDOWS_SOURCE_ID,
      ) as maplibregl.GeoJSONSource | null;
      if (existingSource) {
        existingSource.setData(data as never);
      } else {
        map.addSource(HERO_WINDOWS_SOURCE_ID, {
          type: "geojson",
          maxzoom: 22,
          tolerance: 0,
          data,
        });
      }
      if (!data.features.length) return;

      const beforeId = map.getLayer("buildings-selected-roof-edge")
        ? "buildings-selected-roof-edge"
        : map.getLayer("routes-glow")
          ? "routes-glow"
          : undefined;
      if (!map.getLayer(HERO_HALO_LAYER_ID)) {
        map.addLayer(
          {
            id: HERO_HALO_LAYER_ID,
            type: "fill-extrusion",
            source: HERO_WINDOWS_SOURCE_ID,
            minzoom: FACADE_COARSE_MIN_ZOOM,
            filter: ["==", ["get", "kind"], "halo"],
            layout: { visibility: "none" },
            paint: {
              "fill-extrusion-color": ["get", "colorDark"] as never,
              "fill-extrusion-base": ["get", "base"] as never,
              "fill-extrusion-height": ["get", "height"] as never,
              "fill-extrusion-opacity": 0.14,
              "fill-extrusion-vertical-gradient": false,
            },
          },
          beforeId,
        );
      }
      if (!map.getLayer(HERO_WINDOW_LAYER_ID)) {
        map.addLayer(
          {
            id: HERO_WINDOW_LAYER_ID,
            type: "fill-extrusion",
            source: HERO_WINDOWS_SOURCE_ID,
            minzoom: FACADE_COARSE_MIN_ZOOM,
            filter: ["!=", ["get", "kind"], "halo"],
            layout: { visibility: "none" },
            paint: {
              "fill-extrusion-color": ["get", "colorDark"] as never,
              "fill-extrusion-base": ["get", "base"] as never,
              "fill-extrusion-height": ["get", "height"] as never,
              "fill-extrusion-opacity": 0.96,
              "fill-extrusion-vertical-gradient": false,
            },
          },
          beforeId,
        );
      }
      currentSelectedWindowTheme = null;
      currentSelectedWindowVisibility = null;
      currentSelectedHaloVisibility = null;
      syncSelectedWindowTheme(themeRef.current);
    };

    // Четыре уровня текстуры фасадов по зуму:
    // z < 15.4 ("flat") — чистый цвет без окон и без крыши-плиты обычных домов;
    // z 15.4–16.0 ("subtle") — единичные огни в ночи (≤ 6% контраста);
    // z 16.0–17.0 ("coarse") — редкие огни в ночи и окна выбранного дома;
    // z >= 17.0 ("fine") — крупный план.
    // Pattern не снимаем через null (в MapLibre 6 это ломало рендер слоя),
    // а подменяем набор картинок.
    let selectedId: number | null = null;
    let currentFacadeLod: FacadeLod | null = null;
    let currentNonHomeDim: boolean | null = null;
    let selectedBodyRevealPending = false;
    const syncFacades = (t: Theme) => {
      if (!map || !map.getLayer("buildings")) return;
      refreshSelectedRoofEdge();
      const zoom = map.getZoom();
      const lod = facadeLodForZoom(zoom);
      const dimNonHome = zoom >= NON_HOME_DIM_MIN_ZOOM;
      syncSelectedWindowTheme(t);
      if (lod === currentFacadeLod && dimNonHome === currentNonHomeDim) return;
      currentFacadeLod = lod;
      currentNonHomeDim = dimNonHome;
      addFacadeImages(t);
      // В светлой теме у слоя buildings обычные жилые и нежилые здания не имеют оконной
      // текстуры (а выбранный дом рисуется отдельным слоем buildings-selected-body + 3D hero-окна),
      // поэтому в light-теме и при zoom < 15.4 ("flat") не вешаем fill-extrusion-pattern на
      // весь город: нативный шейдер цвета даёт живой светотеневой объём стен на всех зумах z14–16+.
      if (t === "light" || zoom < FACADE_COARSE_MIN_ZOOM) {
        map.setPaintProperty("buildings", "fill-extrusion-pattern", undefined);
      } else {
        map.setPaintProperty(
          "buildings",
          "fill-extrusion-pattern",
          facadePatternExpr(t, colorStops, lod, selectedId, dimNonHome),
        );
      }
      map.setLayoutProperty("buildings-roof", "visibility", "visible");
      if (
        map.getLayer("buildings-selected-body") &&
        !selectedBodyRevealPending
      ) {
        map.setLayoutProperty(
          "buildings-selected-body",
          "visibility",
          "visible",
        );
      }
      // Шейдер pattern-варианта компилируется не в том же кадре, а карта
      // уже остановилась на zoomend. Без повторного кадра слой может
      // остаться невидимым до следующего движения — пинаем ещё раз.
      const kick = () => map?.triggerRepaint();
      requestAnimationFrame(kick);
      window.setTimeout(kick, 250);
    };

    applyThemeRef.current = (t: Theme) => {
      if (!map || !map.getLayer("buildings")) return;
      const p = MAP_THEMES[t];
      map.setLight(MAP_LIGHT[t]);
      map.setSky(MAP_FOG[t]);
      map.setPaintProperty(
        "buildings",
        "fill-extrusion-color",
        buildingColorExpr(p, colorStops, t === "dark" ? p.selectedBody : null),
      );
      map.setPaintProperty(
        "buildings",
        "fill-extrusion-height",
        buildingExtrusionHeightExpr(),
      );
      map.setPaintProperty(
        "buildings-selected-body",
        "fill-extrusion-color",
        t === "dark" ? p.selectedBody : (selectedStepColorsExpr(p, colorStops, 0) as never),
      );
      map.setPaintProperty(
        "buildings-selected-body",
        "fill-extrusion-base",
        0,
      );
      map.setPaintProperty(
        "buildings-selected-body",
        "fill-extrusion-height",
        ["coalesce", ["get", "height"], 9] as never,
      );
      map.setPaintProperty(
        "buildings-selected-body",
        "fill-extrusion-vertical-gradient",
        true,
      );
      map.setPaintProperty(
        "buildings-roof",
        "fill-extrusion-color",
        buildingRoofColorExpr(p, colorStops),
      );
      map.setPaintProperty(
        "buildings-roof",
        "fill-extrusion-base",
        buildingRoofBaseExpr(),
      );
      map.setPaintProperty(
        "buildings-roof",
        "fill-extrusion-height",
        buildingRoofHeightExpr(),
      );
      if (map.getLayer("buildings-selected-roof")) {
        map.setPaintProperty(
          "buildings-selected-roof",
          "fill-extrusion-color",
          selectedStepColorsExpr(p, colorStops, 0.05) as never,
        );
      }
      if (map.getLayer("buildings-selected-roof-edge")) {
        map.setPaintProperty(
          "buildings-selected-roof-edge",
          "fill-extrusion-color",
          p.outlineCore,
        );
      }
      // У темы свой набор картинок — пере-применяем pattern принудительно.
      // Активную тему готовим заранее: pattern включается на zoomend уже в
      // готовом атласе, иначе первый кадр может пропустить слой.
      addFacadeImages(t);
      // POI: у темы свой цвет капель — обновляем картинки и icon-image.
      registerPoiImages(t);
      for (const def of POI_LAYER_DEFS) {
        if (map.getLayer(def.id)) {
          map.setLayoutProperty(def.id, "icon-image", poiIconExpression(t) as never);
        }
      }
      syncSelectedWindowTheme(t);
      currentFacadeLod = null;
      currentNonHomeDim = null;
      syncFacades(t);
      for (const s of BUILDING_SHADOW_LAYERS) {
        if (map.getLayer(s.id)) {
          map.setPaintProperty(
            s.id,
            "fill-opacity",
            buildingShadowOpacityExpr(s.opacity[t]),
          );
        }
      }
      map.setPaintProperty("glow-outer", "circle-opacity", t === "dark" ? 0.13 : 0.06);
      map.setPaintProperty("glow-inner", "circle-opacity", t === "dark" ? 0.1 : 0.05);
      map.setPaintProperty("outline-halo", "line-color", p.halo);
      map.setPaintProperty("outline-halo", "line-opacity", [
        "case",
        ["to-boolean", ["feature-state", "selected"]],
        t === "dark" ? 0.18 : 0.09,
        0,
      ] as never);
      map.setPaintProperty("outline-core", "line-color", p.outlineCore);
      // V4b6: земляное свечение и подсветка низа стен — только тёмная тема.
      for (const ring of GLOW_RINGS) {
        if (!map.getLayer(ring.id)) continue;
        map.setPaintProperty(
          ring.id,
          "line-opacity",
          glowRingOpacity(ring.opacity, t) as never,
        );
      }
      if (map.getLayer(GLOW_EDGE_LAYER_ID)) {
        map.setPaintProperty(
          GLOW_EDGE_LAYER_ID,
          "line-opacity",
          t === "dark" ? 0.5 : 0.08,
        );
      }
      if (map.getLayer(GLOW_BASE_LAYER_ID)) {
        map.setLayoutProperty(
          GLOW_BASE_LAYER_ID,
          "visibility",
          t === "dark" ? "visible" : "none",
        );
      }
      map.setPaintProperty("redzones-fill", "fill-color", p.redzone);
      for (const [id, paint] of Object.entries(basemapPaint(p))) {
        if (!map.getLayer(id)) continue;
        for (const [prop, value] of Object.entries(paint)) {
          map.setPaintProperty(id, prop as never, value as never);
        }
      }
      map.setPaintProperty("redzones-glow", "line-color", p.redzone);
      map.setPaintProperty("redzones-glow", "line-opacity", [
        "interpolate",
        ["linear"],
        ["zoom"],
        9,
        t === "dark" ? 0.34 : 0.26,
        14,
        t === "dark" ? 0.32 : 0.24,
        17.5,
        t === "dark" ? 0.38 : 0.3,
      ] as never);
      map.setPaintProperty("redzones-core", "line-color", p.redzone);
      map.setPaintProperty("redzones-road", "line-color", p.redzone);
      map.setPaintProperty("redzones-rail", "line-color", p.redzone);
      map.setPaintProperty("routes-glow", "line-color", p.route);
      map.setPaintProperty("routes-glow", "line-opacity", [
        "interpolate",
        ["linear"],
        ["zoom"],
        14,
        t === "dark" ? 0.26 : 0.22,
        17.5,
        t === "dark" ? 0.36 : 0.3,
      ] as never);
      map.setPaintProperty("routes-line", "line-color", p.route);
      map.setPaintProperty("routes-dots", "line-color", p.routeCore);
      map.setPaintProperty("isochrone-fill", "fill-color", p.iso);
      map.setPaintProperty("isochrone-line", "line-color", p.iso);
      rebuildOverlays(selectedRef.current, visibleRef.current);
      rebuildLabels();
    };

    // Порог окон: переключаем ровно по окончании зума/движения (и на load через
    // applyThemeRef). Во время инерции карта не дёргается.
    map.on("zoomend", () => syncFacades(themeRef.current));
    map.on("moveend", () => syncFacades(themeRef.current));
    let selectedWindowDesktop = window.matchMedia("(min-width: 768px)").matches;
    map.on("resize", () => {
      const nextDesktop = window.matchMedia("(min-width: 768px)").matches;
      if (nextDesktop === selectedWindowDesktop) return;
      selectedWindowDesktop = nextDesktop;
      const id = currentSelectedId;
      const signature = currentSelectedSignature;
      if (id === null || signature === null) return;
      const rebuildForViewport = () => {
        if (
          currentSelectedId !== id ||
          currentSelectedSignature !== signature
        ) {
          return;
        }
        selectedWindowCache.delete(id);
        rebuildSelectedWindows(id, signature);
      };
      if (map?.isMoving()) map.once("moveend", rebuildForViewport);
      else rebuildForViewport();
    });

    let appliedSelectedId: number | null = null;
    const applySelection = (activateSelected = true) => {
      if (!map || !map.getSource("buildings")) return;
      // Векторному источнику нужен sourceLayer и для feature-state.
      const stateSource = tileMode
        ? { source: "buildings", sourceLayer: "buildings" }
        : { source: "buildings" };
      // PERF-1-FLY: ровно точечные вызовы. Раньше здесь был цикл по всем
      // 100 049 домам Москвы ради `inactive`, который ни один стиль не читает.
      if (appliedSelectedId !== null && appliedSelectedId !== selectedId) {
        map.setFeatureState(
          { ...stateSource, id: appliedSelectedId },
          { selected: false },
        );
      }
      if (selectedId !== null) {
        map.setFeatureState(
          { ...stateSource, id: selectedId },
          { selected: Boolean(activateSelected) },
        );
      }
      appliedSelectedId = activateSelected ? selectedId : null;
      // PERF-1-FLY: на старте flyTo (activateSelected === false) не сбрасываем
      // LOD и не пересобираем fill-extrusion-pattern всех видимых тайлов — эта
      // пересборка 3D-геометрии и давала слайд-шоу в первых кадрах перелёта.
      // Pattern обновляет reveal по moveend/idle — там applySelection() с true.
      if (activateSelected) {
        currentFacadeLod = null;
        currentNonHomeDim = null;
        syncFacades(themeRef.current);
      }
    };

    const setSelectedBodyLayerVisible = (visible: boolean) => {
      if (!map?.getLayer("buildings-selected-body")) return;
      map.setLayoutProperty(
        "buildings-selected-body",
        "visibility",
        visible ? "visible" : "none",
      );
    };

    const scheduleSelectedBodyReveal = (id: number, token: number) => {
      const activeMap = map;
      if (
        !activeMap ||
        id !== selectedId ||
        token !== captureToken ||
        currentSelectedId !== id ||
        !currentSelectedFeatures.length
      ) {
        return;
      }
      const reveal = () => {
        pendingCaptureIdle = null;
        if (
          token !== captureToken ||
          id !== selectedId ||
          currentSelectedId !== id ||
          !currentSelectedFeatures.length
        ) {
          return;
        }
        applySelection();
        selectedBodyRevealPending = false;
        setSelectedBodyLayerVisible(true);
      };
      if (pendingCaptureIdle) activeMap.off("idle", pendingCaptureIdle);
      pendingCaptureIdle = reveal;
      activeMap.once("idle", reveal);
    };

    const scheduleSelectedCapture = (
      id: number | null = selectedId,
      token = captureToken,
    ) => {
      const activeMap = map;
      if (
        !activeMap ||
        id === null ||
        id !== selectedId ||
        token !== captureToken
      ) {
        return;
      }
      captureRequested = true;
      if (selectionMovePending) return;
      if (captureScheduled) return;
      if (activeMap.isMoving()) {
        if (!pendingCaptureMoveEnd) {
          const onMoveEnd = () => {
            pendingCaptureMoveEnd = null;
            selectionMovePending = false;
            window.requestAnimationFrame(() => scheduleSelectedCapture(id, token));
          };
          pendingCaptureMoveEnd = onMoveEnd;
          activeMap.once("moveend", onMoveEnd);
        }
        return;
      }

      captureScheduled = true;
      const runCapture = () => {
        if (!captureScheduled) return;
        captureScheduled = false;
        if (pendingCaptureIdle) {
          activeMap.off("idle", pendingCaptureIdle);
          pendingCaptureIdle = null;
        }
        if (
          token !== captureToken ||
          id !== selectedId ||
          !captureRequested
        ) {
          return;
        }
        if (activeMap.isMoving()) {
          scheduleSelectedCapture(id, token);
          return;
        }
        captureRequested = false;
        captureSelectedBody(id, token);
      };
      pendingCaptureIdle = runCapture;
      activeMap.once("idle", runCapture);
      captureFrame = window.requestAnimationFrame(() => {
        captureFrame = null;
        if (
          token === captureToken &&
          id === selectedId &&
          !activeMap.isMoving() &&
          activeMap.loaded()
        ) {
          runCapture();
        }
      });
    };

    const setUrlBuilding = (id: number | null) => {
      const url = new URL(window.location.href);
      if (id === null) url.searchParams.delete("building");
      else url.searchParams.set("building", String(id));
      window.history.replaceState(null, "", url);
    };

    const setGlow = (center: [number, number] | null) => {
      const src = map?.getSource("glow") as maplibregl.GeoJSONSource | null;
      src?.setData({
        type: "FeatureCollection",
        features: center
          ? [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "Point", coordinates: center },
              },
            ]
          : [],
      } as never);
    };

    const setSelectedBody = (features: maplibregl.GeoJSONFeature[]) => {
      const normalized = features.map((feature) => {
        const rawId = feature.id ?? feature.properties?.id;
        const numId = typeof rawId === "number" ? rawId : Number(rawId);
        const meta = Number.isFinite(numId) ? metaById[numId] : undefined;
        return {
          type: "Feature" as const,
          id: rawId,
          geometry: feature.geometry,
          properties: {
            id: rawId,
            height: feature.properties?.height ?? 9,
            index: feature.properties?.index ?? meta?.index ?? 5,
          },
        };
      });
      const nextSignature = normalized.length
        ? normalized.map((f) => geometrySignature(f.geometry)).join("&")
        : null;
      const rawId = normalized[0]?.properties.id;
      const nextId = rawId == null ? null : Number(rawId);
      if (
        nextSignature !== null &&
        nextId === currentSelectedId &&
        nextSignature === currentSelectedSignature
      ) {
        return;
      }
      if (nextSignature === null && currentSelectedSignature === null) return;
      currentSelectedId = nextId;
      currentSelectedSignature = nextSignature;
      currentSelectedArea = normalized.reduce(
        (acc, f) => acc + footprintAreaM2(f.geometry),
        0,
      );
      currentSelectedFeatures = normalized as unknown as maplibregl.GeoJSONFeature[];
      const src = map?.getSource("selectedBuilding") as maplibregl.GeoJSONSource | null;
      src?.setData({
        type: "FeatureCollection",
        features: normalized,
      } as never);
      currentRoofEdgeZoom = null;
      refreshSelectedRoofEdge();
      if (nextId !== null && nextSignature !== null) {
        rebuildSelectedWindows(nextId, nextSignature);
      } else {
        clearSelectedWindows();
      }
    };

    const rotateToFacadeIfSafe = (id: number, geometry: Geometry) => {
      if (!map || pendingFacadeBearingId !== id || selectedId !== id) return;
      pendingFacadeBearingId = null;
      const target = facadeCameraBearing(geometry);
      if (target === null) return;
      const current = map.getBearing();
      const delta = ((((target - current + 180) % 360) + 360) % 360) - 180;
      // Не доворачиваемся, если фасад уже далеко от направления луча;
      // угол — всегда кратчайший, дополнительный предел защищает от рывка.
      if (Math.abs(delta) >= 20) return;
      const adjustment = Math.max(-35, Math.min(35, delta));
      if (Math.abs(adjustment) > 1) {
        map.easeTo({ bearing: current + adjustment, duration: 700 });
      }
    };

    // Геометрия выбранного дома: берём все части с одним id из всех
    // загруженных тайлов (дом режется границами PMTiles) и объединяем их
    // в один footprint, чтобы нормали окон считались по целому контуру.
    const selectedBodyCache = new globalThis.Map<
      number,
      {
        partsSignature: string;
        feature: maplibregl.GeoJSONFeature;
        area: number;
      }
    >();
    const rememberSelectedBody = (
      id: number,
      entry: {
        partsSignature: string;
        feature: maplibregl.GeoJSONFeature;
        area: number;
      },
    ) => {
      selectedBodyCache.delete(id);
      selectedBodyCache.set(id, entry);
      if (selectedBodyCache.size > 8) {
        const oldest = selectedBodyCache.keys().next().value;
        if (oldest !== undefined) selectedBodyCache.delete(oldest);
      }
    };
    let lastCaptureAttemptId: number | null = null;
    let lastCaptureAttemptSignature: string | null = null;
    const captureSelectedBody = (id: number, token: number) => {
      if (!map || map.isMoving() || token !== captureToken || selectedId !== id) return;
      const opts = tileMode ? { sourceLayer: "buildings" } : undefined;
      const matches = (f: maplibregl.GeoJSONFeature) =>
        Number(f.id) === id || Number(f.properties?.id) === id;

      const found: maplibregl.GeoJSONFeature[] = [];
      const seen = new Set<string>();
      const push = (f: maplibregl.GeoJSONFeature) => {
        const key = geometrySignature(f.geometry);
        if (!key || seen.has(key)) return;
        seen.add(key);
        found.push(f);
      };

      for (const f of map.querySourceFeatures("buildings", opts as never)) {
        if (matches(f)) push(f);
      }
      // Запасной путь, если источник ещё не отдал фичи после flyTo.
      for (const f of map.queryRenderedFeatures({ layers: ["buildings"] })) {
        if (matches(f)) push(f);
      }
      if (!found.length) return;

      const partsSignature = [...seen].sort().join("&");
      const cached = selectedBodyCache.get(id);
      if (cached?.partsSignature === partsSignature) {
        selectedBodyCache.delete(id);
        selectedBodyCache.set(id, cached);
        setSelectedBodyLayerVisible(false);
        setSelectedBody([cached.feature]);
        currentSelectedArea = cached.area;
        scheduleSelectedBodyReveal(id, token);
        rotateToFacadeIfSafe(id, cached.feature.geometry);
        return;
      }
      if (
        currentSelectedId === id &&
        lastCaptureAttemptId === id &&
        lastCaptureAttemptSignature === partsSignature
      ) {
        return;
      }
      lastCaptureAttemptId = id;
      lastCaptureAttemptSignature = partsSignature;

      const geometry = unionFootprintGeometries(found.map((f) => f.geometry));
      if (!geometry) return;

      // Не откатываемся на обрезок, если часть тайлов выгрузилась при движении.
      if (
        currentSelectedId === id &&
        currentSelectedArea > 0 &&
        footprintAreaM2(geometry) < currentSelectedArea * 0.98
      ) {
        return;
      }

      // Высота и индекс у частей одного дома одинаковые; высоту берём
      // максимумом — на случай расхождений между тайлами.
      let height: number | undefined;
      let indexVal: number | undefined;
      for (const f of found) {
        const h = Number(f.properties?.height);
        if (Number.isFinite(h)) height = height === undefined ? h : Math.max(height, h);
        if (indexVal === undefined) {
          const idx = Number(f.properties?.index);
          if (Number.isFinite(idx)) indexVal = idx;
        }
      }

      const unified = {
        type: "Feature" as const,
        id,
        geometry,
        properties: {
          id,
          height: height ?? 9,
        ...(indexVal !== undefined ? { index: indexVal } : {}),
        },
      };
      const feature = unified as unknown as maplibregl.GeoJSONFeature;
      setSelectedBodyLayerVisible(false);
      setSelectedBody([feature]);
      rememberSelectedBody(id, {
        partsSignature,
        feature,
        area: currentSelectedArea,
      });
      scheduleSelectedBodyReveal(id, token);
      rotateToFacadeIfSafe(id, geometry);
    };

    map.on("sourcedata", (e) => {
      if (e.sourceId !== "buildings") return;
      // PERF-LOAD: во время flyTo к дому каждый догрузившийся тайл зданий
      // не должен запускать захват — moveend в flyToBuilding уже это сделает.
      if (selectionMovePending || map?.isMoving()) return;
      if (selectedId !== null && (e.tile || e.isSourceLoaded)) {
        scheduleSelectedCapture(selectedId, captureToken);
      }
    });

    const deselect = () => {
      cancelSelectedCapture();
      selectedId = null;
      selectedBodyRevealPending = false;
      pendingFacadeBearingId = null;
      routesRef.current = null;
      applySelection();
      updateSelected(null);
      setNonHomeNotice(null);
      setGlow(null);
      setSelectedBody([]);
      setSelectedBodyLayerVisible(true);
      rebuildOverlays(null, visibleRef.current);
      setUrlBuilding(null);
      map?.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 300 });
    };
    deselectRef.current = deselect;

    // Маршруты здания: кэш + догрузка. null в кэше = «файла нет, не повторять».
    const loadRoutes = async (id: number) => {
      const cached = routesCacheRef.current[id];
      if (cached !== undefined) {
        routesRef.current = cached;
        if (selectedRef.current?.id === id) {
          rebuildOverlays(selectedRef.current, visibleRef.current);
        }
        return;
      }
      try {
        const districtId = districtByBuildingRef.current[id];
        if (districtId === undefined) throw new Error("район дома не найден");
        const shardId = id % 16;
        const shardKey = `${districtId}/${shardId}`;
        const shard =
          routesShardCacheRef.current[shardKey] ??
          (routesShardCacheRef.current[shardKey] = fetchGzipJson<
            Record<string, BuildingRoutes>
          >(ROUTES_URL(districtId, shardId)).catch(() => null));
        const data = (await shard)?.[String(id)];
        if (!data) throw new Error(`в шарде ${shardId} нет дома ${id}`);
        const flat: FlatRoutes = {};
        for (const [cat, e] of Object.entries(data.categories)) {
          flat[cat] = { minutes: e.minutes, coordinates: e.geometry.coordinates };
        }
        routesCacheRef.current[id] = flat;
        routesRef.current = flat;
        // В breakdown на тайле есть запасной путь; шард остаётся источником,
        // если отдельный тайловый feature не содержит разбивку.
        if (tileMode) {
          const current = selectedRef.current;
          // v2-компакт из тайла главнее legacy-разбивки из старого шарда.
          const fromShard = parseBuildingBreakdown(data.breakdown);
          const breakdown =
            current?.id === id && isCompactBreakdown(current.breakdown)
              ? current.breakdown
              : fromShard ?? (current?.id === id ? current.breakdown : null);
          breakdownCacheRef.current[id] = breakdown;
          if (current?.id === id && breakdown) {
            const next: SelectedBuilding = { ...current, breakdown };
            updateSelected(next);
            rebuildOverlays(next, visibleRef.current);
          }
        }
      } catch (e) {
        console.error(`Маршруты для здания ${id} не загрузились:`, e);
        routesCacheRef.current[id] = null;
        routesRef.current = null;
      }
      if (selectedRef.current?.id === id) {
        rebuildOverlays(selectedRef.current, visibleRef.current);
      }
    };

    const flyToBuilding = (
      center: [number, number],
      id: number,
      token: number,
    ) => {
      // Ждём две отрисовки, чтобы шторка с новым контентом заняла размер,
      // затем центрируем здание в видимой области карты: на мобиле —
      // padding снизу под шторку, на десктопе — padding справа под док.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!map || token !== captureToken || selectedId !== id) return;
          const sheetEl = document.getElementById("building-sheet");
          const rect = sheetEl?.getBoundingClientRect();
          const desktop = window.matchMedia("(min-width: 768px)").matches;
          const onMoveEnd = () => {
            pendingCaptureMoveEnd = null;
            selectionMovePending = false;
            window.requestAnimationFrame(() => scheduleSelectedCapture(id, token));
          };
          map.flyTo({
            center,
            // Сразу приближаем до зума выбора дома (16.6, режим coarse),
            // чтобы фасады с окнами были видны сразу после клика.
            zoom: Math.max(map.getZoom(), FACADE_SELECT_ZOOM),
            speed: 1.1,
            curve: 1.3,
            padding: desktop
              ? { right: (rect?.width ?? 0) + 24, bottom: 0 }
              : { bottom: (rect?.height ?? 0) + 24 },
          });
          if (map.isMoving()) {
            pendingCaptureMoveEnd = onMoveEnd;
            map.once("moveend", onMoveEnd);
          } else {
            selectionMovePending = false;
            requestAnimationFrame(() => scheduleSelectedCapture(id, token));
          }
        });
      });
    };

    const findBuildingFeature = (id: number): maplibregl.GeoJSONFeature | undefined => {
      if (!map) return undefined;
      const matches = (feature: maplibregl.GeoJSONFeature) =>
        Number(feature.id) === id || Number(feature.properties?.id) === id;
      try {
        return (
          map
            .querySourceFeatures("buildings", { sourceLayer: "buildings" })
            .find(matches) ??
          map.queryRenderedFeatures({ layers: ["buildings"] }).find(matches)
        );
      } catch {
        return undefined;
      }
    };

    const districtForPoint = (center: [number, number]) =>
      districts.find(
        ({ bbox }) =>
          center[0] >= bbox[0] &&
          center[0] <= bbox[2] &&
          center[1] >= bbox[1] &&
          center[1] <= bbox[3],
      );

    // Общая логика выбора: клик по зданию и открытие по ?building=<osm_id>.
    const selectById = (
      id: number,
      clickedFeature?: maplibregl.GeoJSONFeature,
      clickedPoint?: [number, number],
    ) => {
      const existingMeta = metaById[id];
      const feature = clickedFeature ?? findBuildingFeature(id);
      if (!feature) {
        const center = existingMeta?.center;
        if (!center || !map) {
          setDeepLinkError("Дом не найден. Возможно, ссылка устарела — найдите адрес на карте.");
          return;
        }
        const checkAfterMove = () => {
          if (!map) return;
          map.once("idle", () => {
            if (cancelled) return;
            const loaded = findBuildingFeature(id);
            if (loaded) selectById(id, loaded);
            else {
              setDeepLinkError(
                "Не удалось загрузить здание. Проверьте соединение и повторите попытку.",
              );
            }
          });
        };
        if (map.isMoving()) map.once("moveend", checkAfterMove);
        else checkAfterMove();
        map.flyTo({
          center,
          zoom: Math.max(map.getZoom(), FACADE_SELECT_ZOOM),
          speed: 1.1,
          curve: 1.3,
        });
        return;
      }

      const properties = feature.properties as unknown as BuildingProps;
      const center =
        existingMeta?.center ?? geometryCenter(feature.geometry) ?? null;
      const rawIsHome = properties.is_home ?? existingMeta?.isHome;
      const isHome =
        rawIsHome === true ||
        rawIsHome === 1 ||
        rawIsHome === "1" ||
        rawIsHome === "true";
      if (!isHome) {
        if (selectedId !== null) deselect();
        const point = clickedPoint ?? center;
        if (point) {
          setNotice(null);
          setNonHomeNotice({ point, status: "idle" });
        } else {
          showNotice(
            "Нежилое здание. Индекс окружения считается только для жилых домов",
          );
        }
        return;
      }
      setNonHomeNotice(null);
      if (!center) {
        setDeepLinkError("Не удалось определить положение здания.");
        return;
      }
      const numeric = (value: unknown): number | null => {
        if (value === null || value === undefined || value === "") return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const meta: BuildingMeta = {
        ...existingMeta,
        id,
        center,
        address:
          typeof properties.address === "string"
            ? properties.address
            : existingMeta?.address ?? null,
        index: numeric(properties.index) ?? existingMeta?.index ?? null,
        year: numeric(properties.year) ?? existingMeta?.year ?? null,
        isHome: true,
      };
      metaById[id] = meta;
      buildingCenters[id] = center;
      const district = districtForPoint(center);
      if (!district) {
        setDeepLinkError("Не удалось определить район здания.");
        return;
      }
      districtByBuildingRef.current[id] = district.id;
      const token = cancelSelectedCapture();
      selectionMovePending = true;
      selectedId = id;
      // POI района дома — в кэш, чтобы ближайшие и маршруты были сразу.
      void ensurePoiNear(center);
      // Красные зоны района дома — для пинов «ближайший минус».
      void ensureRedzonesForDistrict(district.id).then(() => {
        const revealRedzones = () => {
          if (selectedId !== id) return;
          rebuildOverlays(selectedRef.current, visibleRef.current);
        };
        // PERF-LOAD: перестройка оверлеев посреди flyTo рвёт кадр.
        if (selectionMovePending || map?.isMoving()) map?.once("moveend", revealRedzones);
        else revealRedzones();
      });

      selectedBodyRevealPending = true;
      setDeepLinkError(null);
      applySelection(false);
      setSelectedBodyLayerVisible(false);

      const breakdown =
        breakdownCacheRef.current[id] ??
        parseBuildingBreakdown(properties.breakdown);
      if (breakdown) breakdownCacheRef.current[id] = breakdown;
      const next: SelectedBuilding = {
        id,
        index: meta.index ?? null,
        address: meta.address,
        year: meta.year ?? null,
        breakdown,
      };
      updateSelected(next);
      setUrlBuilding(id);
      routesRef.current = routesCacheRef.current[id] ?? null;
      rebuildOverlays(next, visibleRef.current);
      void loadRoutes(id);

      setGlow(center);
      if (currentSelectedId !== id) {
        setSelectedBody([]);
      }
      pendingFacadeBearingId = id;
      flyToBuilding(center, id, token);
    };
    selectRef.current = selectById;
    findNearestHomeRef.current = async (point: [number, number]) => {
      let index = searchIndexData;
      if (!index) {
        setNonHomeNotice((curr) =>
          curr ? { ...curr, status: "loading" } : null,
        );
        try {
          index = await ensureSearchIndex();
        } catch (error) {
          console.error("Индекс для поиска ближайшего дома не загрузился:", error);
          if (!cancelled) {
            setNonHomeNotice((curr) =>
              curr ? { ...curr, status: "error" } : null,
            );
          }
          return;
        }
      }
      if (cancelled) return;
      let bestId: number | null = null;
      let bestDist = Infinity;
      for (let i = 0; i < index.ids.length; i++) {
        const d = haversineM([index.lon[i], index.lat[i]], point);
        if (d < bestDist) {
          bestDist = d;
          bestId = index.ids[i];
        }
      }
      if (bestId === null || bestDist > 200) {
        setNonHomeNotice((curr) =>
          curr ? { ...curr, status: "far" } : null,
        );
        return;
      }
      setNonHomeNotice(null);
      selectById(bestId);
    };

    map.on("load", () => {
      refreshBasemapDecorations();
      applyThemeRef.current?.(themeRef.current);
      applyVisibilityRef.current?.(visibleRef.current);
      setIsoSourceRef.current?.(isoGeomRef.current);
      rebuildLabels();
      // Публичная ссылка «Отправить клиенту»: ?building=<osm_id>
      const param = new URLSearchParams(window.location.search).get("building");
      if (param !== null) {
        const id = Number(param);
        if (Number.isInteger(id)) {
          void loadSearchIndex().then(() => {
            if (cancelled) return;
            if (metaById[id]) {
              selectById(id);
            } else {
              setDeepLinkError(
                "Дом не найден. Возможно, ссылка устарела — выберите дом на карте или найдите по адресу.",
              );
            }
          });
        } else {
          setDeepLinkError(
            "Дом не найден. Возможно, ссылка устарела — выберите дом на карте или найдите по адресу.",
          );
        }
      }
    });

    const buildingHitLayers = () => {
      const layers = ["buildings"];
      for (const id of [
        "buildings-roof",
        "buildings-selected-roof-edge",
        "buildings-selected-roof",
        "buildings-selected-body",
      ]) {
        if (map?.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none") {
          layers.unshift(id);
        }
      }
      return layers;
    };

    const poiHitLayers = () =>
      [...POI_LAYER_DEFS.map((def) => def.id), POI_LABEL_LAYER].filter((id) =>
        map?.getLayer(id),
      );

    map.on("click", (e) => {
      if (!map || !map.getLayer("buildings")) return;
      // Клик по капле или пилюле POI не проваливается в дом под ней — как
      // раньше, когда DOM-маркер перехватывал событие.
      const poiLayers = poiHitLayers();
      if (
        poiLayers.length &&
        map.queryRenderedFeatures(e.point, { layers: poiLayers }).length
      ) {
        return;
      }
      const feats = map.queryRenderedFeatures(e.point, { layers: buildingHitLayers() });
      const rawId = feats.length ? (feats[0].id ?? feats[0].properties?.id) : null;
      // В тайлах id может прийти строкой — приводим к числу (brief B2).
      const id =
        typeof rawId === "string"
          ? Number(rawId)
          : typeof rawId === "number"
            ? rawId
            : null;

      if (id === null || !Number.isFinite(id) || id === selectedId) {
        deselect();
        return;
      }

      selectById(id, feats[0], [e.lngLat.lng, e.lngLat.lat]);
    });

    let lastHoverCheckMs = 0;
    let lastHoverCursor = "";
    map.on("mousemove", (e) => {
      if (!map || !map.getLayer("buildings")) return;
      // 3D-рейкаст по сотням домов стоит 10–25 мс на событие (z15–16).
      // Во время движения карты и чаще раза в 60 мс его не запускаем.
      if (map.isMoving() || selectionMovePending) return;
      const now = performance.now();
      if (now - lastHoverCheckMs < 60) return;
      lastHoverCheckMs = now;
      const poiLayers = poiHitLayers();
      // Лёгкие 2D-слои POI проверяем первыми: если попали, тяжёлый
      // рейкаст по 3D-экструзии зданий не нужен.
      let hit =
        poiLayers.length > 0 &&
        map.queryRenderedFeatures(e.point, { layers: poiLayers }).length > 0;
      if (!hit) {
        hit =
          map.queryRenderedFeatures(e.point, { layers: buildingHitLayers() }).length > 0;
      }
      const nextCursor = hit ? "pointer" : "";
      if (nextCursor !== lastHoverCursor) {
        lastHoverCursor = nextCursor;
        map.getCanvas().style.cursor = nextCursor;
      }
    });
  };

  void init();

  return () => {
    cancelled = true;
    if (basemapDecorTimer !== null) {
      window.clearTimeout(basemapDecorTimer);
      basemapDecorTimer = null;
    }
    if (tilePrefetchTimer !== null) {
      window.clearTimeout(tilePrefetchTimer);
      tilePrefetchTimer = null;
    }
    // Отменяем фоновые догрузки: они проверяют токен перед каждым тайлом.
    tilePrefetchToken++;
    map?.remove();
    map = null;
  };
}
