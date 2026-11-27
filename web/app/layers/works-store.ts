// Слой «Стройки и работы» (S7): общий ресурс карты и карточки объекта.
//
// Источник — `live/works.geojson` из `pipeline/fetch_facts.py`: набор 2855
// «действующие ордера» data.mos.ru (4109 объектов). Файл читают две части
// одного слоя: императивная (источник и слои MapLibre) и карточка (URL
// `?work=<global_id>`). Запрос один: `loadWorks()` запоминает промис, второй
// вызов получает тот же результат — в том числе при включении/выключении чипа.
//
// Карточка не выдумывает полей: всё, что показывается, берётся из properties
// фичи, а отсутствующее поле помечается в UI как «в источнике не указано».
// Геометрия для адреса не используется.
import type { Feature, FeatureCollection, Geometry } from "geojson";

/** Файл рядом со страницей: сайт живёт в подпапке Pages `/puls-moskvy/`. */
export const WORKS_URL = "live/works.geojson";

/** Имя параметра URL: `?work=<global_id>` — ссылка на карточку объекта. */
export const WORK_PARAM = "work";

/** Идентификаторы источника и слоёв карты (их же проверяют e2e). */
export const WORK_SOURCE_ID = "works";
export const WORK_LAYER_IDS = ["works-fill", "works-line", "works-point"] as const;

/** Провенанс: набор, его номер и ссылка на первоисточник (S7/ROADMAP). */
export const WORK_SOURCE_DATASET = 2855;
export const WORK_SOURCE_URL = "https://data.mos.ru/opendata/2855";

/**
 * Свойства объекта набора 2855 — ровно те, что есть в файле. Массивы
 * (`work_type`, `order_work`) приходят списками; пустые поля — пустой строкой.
 */
export type WorkProperties = {
  global_id?: number | string | null;
  order_number?: string | null;
  order_date?: string | null;
  work_start_date?: string | null;
  work_end_date?: string | null;
  customer?: string | null;
  work_type?: string[] | string | null;
  order_work?: string[] | string | null;
  address?: string | null;
  work_place?: string | null;
  district?: string | null;
  adm_area?: string | null;
};

export type WorkFeature = Feature<Geometry, WorkProperties>;

export type WorksData = {
  /** Нормализованная коллекция: GeometryCollection развёрнут по геометриям. */
  collection: FeatureCollection<Geometry, WorkProperties>;
  /** Объект по `global_id` — для карточки (первая фича с этим id). */
  byId: Record<string, WorkFeature>;
  /** Сколько объектов в наборе (до разворачивания GeometryCollection). */
  objects: number;
};

export type WorksStatus = "idle" | "loading" | "ok" | "missing";

export type WorksState = {
  status: WorksStatus;
  data: WorksData | null;
  /** Открытая карточка: `global_id` строкой (URL и properties — строки). */
  selectedId: string | null;
  /**
   * Объект, к которому нужно перевести камеру (deep link `?work=`).
   * null — камера не двигается (открытие по клику: объект уже в кадре).
   */
  focusId: string | null;
};

/** Состояние до первого запроса — стабильная ссылка для SSR-снимка. */
export const initialWorks: WorksState = {
  status: "idle",
  data: null,
  selectedId: null,
  focusId: null,
};

let current: WorksState = initialWorks;
const listeners = new Set<() => void>();

export const worksStore = {
  get: (): WorksState => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

function publish(patch: Partial<WorksState>): void {
  current = { ...current, ...patch };
  for (const listener of [...listeners]) listener();
}

/** `global_id` из properties — строкой; null, если поля нет. */
export function workId(properties: WorkProperties): string | null {
  const value = properties.global_id;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

/** Развернуть GeometryCollection в список простых геометрий. */
function flattenGeometry(geometry: Geometry | null): Geometry[] {
  if (!geometry) return [];
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.flatMap((part) => flattenGeometry(part));
  }
  return [geometry];
}

/**
 * Разбор FeatureCollection. Для отрисовки MapLibre нужны отдельные фичи
 * простых типов: GeometryCollection (385 объектов) разворачиваем, свойства
 * дублируем. Карточка ищет объект по `global_id` в исходном виде.
 */
export function parseWorks(payload: unknown): WorksData {
  const collection =
    payload !== null && typeof payload === "object"
      ? (payload as FeatureCollection<Geometry, WorkProperties>)
      : null;
  const rawFeatures = Array.isArray(collection?.features)
    ? collection.features
    : [];

  const features: WorkFeature[] = [];
  const byId: Record<string, WorkFeature> = {};
  for (const raw of rawFeatures) {
    const properties = (raw.properties ?? {}) as WorkProperties;
    const id = workId(properties);
    if (id !== null && byId[id] === undefined) {
      byId[id] = { type: "Feature", geometry: raw.geometry, properties };
    }
    for (const geometry of flattenGeometry(raw.geometry)) {
      features.push({ type: "Feature", geometry, properties });
    }
  }

  return {
    collection: { type: "FeatureCollection", features },
    byId,
    objects: rawFeatures.length,
  };
}

let loadPromise: Promise<WorksData | null> | null = null;

/**
 * Загрузить и разобрать `works.geojson` (один запрос на страницу). null —
 * файла нет/ответ битый: карточка честно пишет «данных нет», а не пустоту.
 */
export function loadWorks(): Promise<WorksData | null> {
  if (loadPromise) return loadPromise;
  if (current.status !== "ok") publish({ status: "loading" });
  loadPromise = fetch(WORKS_URL, { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) throw new Error(`works.geojson: ${response.status}`);
      return response.json() as Promise<unknown>;
    })
    .then((payload) => {
      const data = parseWorks(payload);
      publish({ status: "ok", data });
      return data;
    })
    .catch(() => {
      // Следующий вызов может повторить запрос (например, после офлайна).
      loadPromise = null;
      publish({ status: "missing" });
      return null;
    });
  return loadPromise;
}

/** Открыть карточку объекта; `syncUrl: false` — пришло из URL, не переписывать. */
export function openWork(
  rawId: string | number,
  options: { syncUrl?: boolean; focus?: boolean } = {},
): void {
  const id = String(rawId).trim();
  if (!id) return;
  // focus — только deep link: при клике объект уже в кадре, камеру не трогаем.
  publish({ selectedId: id, focusId: options.focus ? id : null });
  void loadWorks();
  if (options.syncUrl !== false) writeWorkParam(id);
}

/** Закрыть карточку и убрать `?work` (остальные параметры сохраняются). */
export function closeWork(): void {
  if (current.selectedId !== null || current.focusId !== null) {
    publish({ selectedId: null, focusId: null });
  }
  writeWorkParam(null);
}

/** Камера отработала (или объект без геометрии) — снять запрос фокуса. */
export function clearWorkFocus(): void {
  if (current.focusId !== null) publish({ focusId: null });
}

/**
 * Центр геометрии объекта: среднее всех координат. Для точки это сама точка,
 * для линии/полигона — взвешенный по вершинам центр (камера deep link).
 */
export function workCentroid(feature: WorkFeature): [number, number] | null {
  const positions: [number, number][] = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number"
    ) {
      positions.push([value[0], value[1]]);
      return;
    }
    for (const item of value) collect(item);
  };
  const collectGeometry = (geometry: Geometry | null): void => {
    if (!geometry) return;
    if (geometry.type === "GeometryCollection") {
      for (const part of geometry.geometries) collectGeometry(part);
      return;
    }
    collect(geometry.coordinates);
  };
  collectGeometry(feature.geometry);
  if (!positions.length) return null;
  let lng = 0;
  let lat = 0;
  for (const [x, y] of positions) {
    lng += x;
    lat += y;
  }
  return [lng / positions.length, lat / positions.length];
}

/** `?work=<id>` из строки запроса; null — параметра нет. */
export function readWorkParam(search?: string): string | null {
  if (search === undefined && typeof window === "undefined") return null;
  const params = new URLSearchParams(
    search ?? (typeof window === "undefined" ? "" : window.location.search),
  );
  const value = params.get(WORK_PARAM);
  return value !== null && value.trim() ? value.trim() : null;
}

/** Абсолютная ссылка на карточку — для кнопки «Скопировать ссылку». */
export function workShareUrl(id: string): string {
  if (typeof window === "undefined") {
    return `?${WORK_PARAM}=${encodeURIComponent(id)}`;
  }
  const url = new URL(window.location.href);
  url.searchParams.set(WORK_PARAM, id);
  return url.toString();
}

/** Записать/убрать `?work` без перезагрузки и без новой записи в истории. */
export function writeWorkParam(id: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete(WORK_PARAM);
  else url.searchParams.set(WORK_PARAM, id);
  if (url.href === window.location.href) return;
  window.history.replaceState(null, "", url);
}
