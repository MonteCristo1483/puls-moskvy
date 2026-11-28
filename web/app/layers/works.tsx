import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { FeatureCollection, Geometry } from "geojson";
import WorkCard from "../work-card";
import { WORKS_PAINT } from "../map/palette";
import type { Theme } from "../theme";
import type { LayerPlugin } from "./contract";
import type { FactsSnapshot } from "./facts-store";
import {
  closeWork,
  loadWorks,
  openWork,
  WORK_LAYER_IDS,
  WORK_SOURCE_ID,
  type WorksData,
  type WorkProperties,
} from "./works-store";

// Слой «Стройки и работы» (S7). Императивная часть по контракту: сам ставит
// источник и слои на карту, сам снимает их в unmount; карта (map.tsx) о нём
// не знает — подключение идёт через реестр.
//
// Три типа геометрии — три слоя: линии (работы/раскопки), полигоны (площадки),
// точки (отдельные работы). GeometryCollection в store развёрнут заранее,
// поэтому каждый слой получает простые фичи.
const RETRY_MS = 250;
const MAX_ATTEMPTS = 320; // 80 с: PMTiles и тайлы грузятся долго, но не бесконечно

const WORKS_LABEL = "Стройки и работы";

const LINE_LAYER = "works-line";
const FILL_LAYER = "works-fill";
const POINT_LAYER = "works-point";

const EMPTY: FeatureCollection<Geometry, WorkProperties> = {
  type: "FeatureCollection",
  features: [],
};

function sourceData(data: WorksData | null): FeatureCollection<Geometry, WorkProperties> {
  return data?.collection ?? EMPTY;
}

/**
 * S9: слой работ живёт только на живых фактах. Пока `meta.json` грузится,
 * считаем слой доступным (иначе чип и карточка мигали бы при каждой загрузке);
 * скрываем, только когда состояние известно и данные устарели/отсутствуют.
 *
 * Причина пишется в консоль **один раз на переход** «доступен → скрыт», а не
 * на каждый рендер: `available` зовут и хост, и панель. Повторная запись
 * появится лишь после возврата данных (например, после повторной загрузки).
 */
let warnedHidden = false;

function worksAvailable(facts: FactsSnapshot): boolean {
  if (facts.status === "loading") return true;
  if (!facts.stale) {
    warnedHidden = false;
    return true;
  }
  if (!warnedHidden) {
    warnedHidden = true;
    const reason =
      facts.meta === null
        ? "meta.json не найден"
        : `данные старше 24 ч (generated_at ${facts.generated ?? "неизвестно"})`;
    console.warn(`[S9] слой «${WORKS_LABEL}» скрыт: ${reason}`);
  }
  return false;
}

/** Цвета WebGL не читают CSS-переменные — берём их из палитры тем. */
function applyPaint(map: MapLibreMap, theme: Theme): void {
  const paint = WORKS_PAINT[theme];
  try {
    if (map.getLayer(FILL_LAYER)) {
      map.setPaintProperty(FILL_LAYER, "fill-color", paint.fill);
      map.setPaintProperty(FILL_LAYER, "fill-opacity", paint.fillOpacity);
      map.setPaintProperty(FILL_LAYER, "fill-outline-color", paint.line);
    }
    if (map.getLayer(LINE_LAYER)) {
      map.setPaintProperty(LINE_LAYER, "line-color", paint.line);
    }
    if (map.getLayer(POINT_LAYER)) {
      map.setPaintProperty(POINT_LAYER, "circle-color", paint.point);
      map.setPaintProperty(POINT_LAYER, "circle-stroke-color", paint.pointStroke);
    }
  } catch {
    // Стиль уже сменился/карта удалена — перекраска не критична.
  }
}

function addLayers(map: MapLibreMap, theme: Theme): void {
  const paint = WORKS_PAINT[theme];
  if (!map.getLayer(FILL_LAYER)) {
    map.addLayer({
      id: FILL_LAYER,
      type: "fill",
      source: WORK_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": paint.fill,
        "fill-opacity": paint.fillOpacity,
        "fill-outline-color": paint.line,
      },
    } as never);
  }
  if (!map.getLayer(LINE_LAYER)) {
    map.addLayer({
      id: LINE_LAYER,
      type: "line",
      source: WORK_SOURCE_ID,
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": paint.line,
        "line-width": 1.8,
        "line-opacity": 0.9,
      },
    } as never);
  }
  if (!map.getLayer(POINT_LAYER)) {
    map.addLayer({
      id: POINT_LAYER,
      type: "circle",
      source: WORK_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-color": paint.point,
        "circle-radius": 3.5,
        "circle-opacity": 0.95,
        "circle-stroke-color": paint.pointStroke,
        "circle-stroke-width": 1.2,
      },
    } as never);
  }
}

function removeLayers(map: MapLibreMap): void {
  for (const id of [POINT_LAYER, LINE_LAYER, FILL_LAYER]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(WORK_SOURCE_ID)) map.removeSource(WORK_SOURCE_ID);
}

/** Карта создаётся асинхронно; слой ждёт её и готовность стиля опросом. */
export const worksLayer: LayerPlugin = {
  id: "works",
  label: WORKS_LABEL,
  defaultVisible: false,
  visibilityKey: "works",
  available(context) {
    return worksAvailable(context.facts.get());
  },
  mount(context) {
    let cancelled = false;
    let timer: number | null = null;
    let attempts = 0;
    let data: WorksData | null = null;
    let wired = false;

    const schedule = () => {
      if (cancelled || timer !== null || attempts >= MAX_ATTEMPTS) return;
      attempts += 1;
      timer = window.setTimeout(() => {
        timer = null;
        ensure();
      }, RETRY_MS);
    };

    // Клик по объекту открывает карточку; клик мимо — закрывает её.
    // Дом под объектом может выбрать движок карты — карточка работ лежит
    // выше (z-20) и остаётся главной, пока её не закроют.
    const onClick = (event: MapMouseEvent) => {
      const map = context.getMap();
      if (!map || cancelled) return;
      const layers = WORK_LAYER_IDS.filter((id) => map.getLayer(id));
      if (!layers.length) return;
      const hits = map.queryRenderedFeatures(event.point, { layers });
      if (!hits.length) {
        closeWork();
        return;
      }
      const raw = hits[0]?.properties?.global_id;
      if (raw === null || raw === undefined) return;
      openWork(String(raw));
    };

    function ensure(): void {
      if (cancelled) return;
      const map = context.getMap();
      if (!map) {
        schedule();
        return;
      }
      try {
        if (!map.isStyleLoaded()) {
          schedule();
          return;
        }
        if (!map.getSource(WORK_SOURCE_ID)) {
          map.addSource(WORK_SOURCE_ID, {
            type: "geojson",
            data: sourceData(data),
          } as never);
        }
        addLayers(map, context.theme);
        if (data) {
          const source = map.getSource(WORK_SOURCE_ID) as GeoJSONSource | undefined;
          source?.setData(data.collection as never);
        }
        applyPaint(map, context.theme);
        if (!wired) {
          map.on("click", onClick);
          wired = true;
        }
        attempts = 0;
      } catch {
        // Стиль ещё не готов (PMTiles) — повторим через RETRY_MS.
        schedule();
      }
    }

    ensure();
    void loadWorks().then((loaded) => {
      data = loaded;
      if (!cancelled) ensure();
    });

    return {
      unmount() {
        cancelled = true;
        if (timer !== null) window.clearTimeout(timer);
        const map = context.getMap();
        if (!map) return;
        try {
          if (wired) map.off("click", onClick);
          removeLayers(map);
        } catch {
          // Карта уже удалена вместе со стилем.
        }
      },
    };
  },
  onTheme(theme) {
    if (typeof window === "undefined") return;
    const map = (window as unknown as { __map?: MapLibreMap }).__map;
    if (map) applyPaint(map, theme);
  },
};

/**
 * Карточка объекта — отдельный слой без чипа: она должна открываться по
 * `?work=<id>` и при выключенном слое (4109 объектов по умолчанию не грузим).
 * Видимостью управляет URL, а не панель слоёв, поэтому `defaultVisible: true`.
 * S9: без живых фактов карточка не монтируется вовсе — deep link `?work=` не
 * открывает объект, о котором нечего честно сказать.
 */
export const worksCardLayer: LayerPlugin = {
  id: "works-card",
  label: "Карточка объекта",
  defaultVisible: true,
  available(context) {
    return worksAvailable(context.facts.get());
  },
  View: ({ context }) => <WorkCard facts={context.facts} getMap={context.getMap} />,
};
