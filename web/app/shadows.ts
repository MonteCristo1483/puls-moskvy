// Геометрия теней (S3): контур дома смещается вдоль солнечного луча на
// длину height/tan(высота солнца), затем исходный и сдвинутый контуры
// объединяются в один полигон (polygon-clipping). Так тень — это «заметённая»
// область, а не два наложенных прямоугольника.
//
// Чистый модуль: ни DOM, ни карты, ни React — проверяется в Node и в
// Playwright-тестах без браузера. Координаты — [lon, lat], метры — локальная
// плоская аппроксимация (тени короче километра, ошибка < 0.5%).

import polygonClipping from "polygon-clipping";

export type LonLat = [number, number];
export type Ring = LonLat[];
/** MultiPolygon-координаты: [полигон][кольцо][точка]. */
export type ShadowMultiPolygon = LonLat[][][];

/** Ниже этой высоты солнца тень бесконечно длинная и превращается в шум. */
export const MIN_SHADOW_ALTITUDE_DEG = 1.5;
/** Потолок длины тени: 100-метровый дом при 8° даёт 700 м, дальше — шум. */
export const MAX_SHADOW_LENGTH_M = 900;
/** Короче 0.6 м тень не видна и только раздувает GeoJSON. */
const MIN_SHADOW_LENGTH_M = 0.6;
const DIGITS = 7;

export type SunDirection = {
  /** Азимут от севера по часовой стрелке, градусы. */
  azimuthDeg: number;
  /** Высота над горизонтом, градусы. */
  altitudeDeg: number;
};

export type ShadowOffset = {
  /** Смещение на восток, метры (может быть отрицательным). */
  eastM: number;
  /** Смещение на север, метры. */
  northM: number;
  /** Длина тени, метры. */
  lengthM: number;
};

/** Метров в одном градусе широты/долготы для широты точки. */
export function metersPerDegree(latitude: number): { lat: number; lon: number } {
  const phi = (latitude * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    lon: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi),
  };
}

/**
 * Смещение тени на земле: направление — противоположное азимуту солнца,
 * длина = height / tan(altitude). null — солнце слишком низко (тени нет).
 */
export function shadowOffset(
  heightM: number,
  sun: SunDirection,
): ShadowOffset | null {
  if (!Number.isFinite(heightM) || heightM <= 0) return null;
  if (!Number.isFinite(sun.altitudeDeg) || !Number.isFinite(sun.azimuthDeg)) {
    return null;
  }
  if (sun.altitudeDeg <= MIN_SHADOW_ALTITUDE_DEG) return null;

  const rawLength =
    heightM / Math.tan((sun.altitudeDeg * Math.PI) / 180);
  const lengthM = Math.min(rawLength, MAX_SHADOW_LENGTH_M);
  if (!Number.isFinite(lengthM) || lengthM < MIN_SHADOW_LENGTH_M) return null;

  const shadowAzimuth = (sun.azimuthDeg + 180) % 360;
  const radians = (shadowAzimuth * Math.PI) / 180;
  // Азимут от севера: east = sin, north = cos.
  return {
    eastM: Math.sin(radians) * lengthM,
    northM: Math.cos(radians) * lengthM,
    lengthM,
  };
}

function roundCoordinate(value: number): number {
  const factor = 10 ** DIGITS;
  return Math.round(value * factor) / factor;
}

/** Кольцо без повторов подряд и без незакрытого хвоста; null — меньше 3 точек. */
export function cleanRing(ring: Ring | undefined | null): Ring | null {
  if (!ring || ring.length < 3) return null;
  const result: Ring = [];
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const lon = point[0];
    const lat = point[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const rounded: LonLat = [roundCoordinate(lon), roundCoordinate(lat)];
    const previous = result[result.length - 1];
    if (previous && previous[0] === rounded[0] && previous[1] === rounded[1]) {
      continue;
    }
    result.push(rounded);
  }
  if (result.length < 3) return null;
  const first = result[0];
  const last = result[result.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) result.push([first[0], first[1]]);
  return result.length >= 4 ? result : null;
}

/** Сдвиг кольца на eastM/northM метров в локальной плоскости. */
export function translateRing(
  ring: Ring,
  eastM: number,
  northM: number,
  latitude: number,
): Ring {
  const per = metersPerDegree(latitude);
  const dLon = eastM / per.lon;
  const dLat = northM / per.lat;
  const shifted: Ring = ring.map(([lon, lat]) => [
    roundCoordinate(lon + dLon),
    roundCoordinate(lat + dLat),
  ]);
  const first = shifted[0];
  const last = shifted[shifted.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    shifted.push([first[0], first[1]]);
  }
  return shifted;
}

/** Площадь кольца в м² (плоская аппроксимация, для фильтров). */
export function ringAreaM2(ring: Ring, latitude: number): number {
  if (!ring || ring.length < 4) return 0;
  const per = metersPerDegree(latitude);
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [lon0, lat0] = ring[i];
    const [lon1, lat1] = ring[i + 1];
    const x0 = lon0 * per.lon;
    const y0 = lat0 * per.lat;
    const x1 = lon1 * per.lon;
    const y1 = lat1 * per.lat;
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

/** Расстояние по земле (haversine), метры. */
export function distanceMeters(a: LonLat, b: LonLat): number {
  const radius = 6_371_008.8;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Выпуклая оболочка (монотонная цепь). Тень дома = оболочка контура и его
 * сдвинутой копии: для выпуклого контура это ровно union двух копий, для
 * сложного (Г-образного) — оболочка, которая заливает вдавленный угол.
 * Оболочка в 20 раз дешевле union на дом и делает дешёвым растворение кадра.
 */
function convexHull(points: LonLat[]): Ring | null {
  if (points.length < 3) return null;
  const sorted = [...points].sort((a, b) =>
    a[0] === b[0] ? a[1] - b[1] : a[0] - b[0],
  );
  const cross = (o: LonLat, a: LonLat, b: LonLat): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: LonLat[] = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: LonLat[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  upper.pop();
  lower.pop();
  const ring = lower.concat(upper);
  if (ring.length < 3) return null;
  // Замыкаем кольцо: без последней точки shoelace и заливка «плывут».
  const first = ring[0];
  ring.push([first[0], first[1]]);
  return ring;
}

/**
 * Тень дома: выпуклая оболочка контура и его копии, сдвинутой на всю длину
 * тени (проекция верхней кромки на землю). null — тени нет.
 * Дыры (внутренние кольца) не переносим: тень двора перекрывается телом тени.
 * Части одного дома (разрез тайлом) считаем отдельно, чтобы оболочка не
 * перекинулась мостом через двор; перекрытие частей снимает растворение кадра.
 */
export function buildingShadowMulti(
  polygons: ShadowMultiPolygon,
  heightM: number,
  sun: SunDirection,
  latitude: number,
): ShadowMultiPolygon | null {
  const offset = shadowOffset(heightM, sun);
  if (!offset) return null;

  const result: ShadowMultiPolygon = [];
  for (const polygon of polygons) {
    const points: LonLat[] = [];
    for (const ring of polygon) {
      const outer = cleanRing(ring);
      if (!outer) continue;
      points.push(...outer);
      points.push(
        ...translateRing(outer, offset.eastM, offset.northM, latitude),
      );
    }
    if (points.length < 3) continue;
    const hull = convexHull(points);
    if (hull) result.push([hull]);
  }
  return result.length > 0 ? result : null;
}

/** Тень одного кольца (одноэтажный дом или тест). */
export function buildingShadow(
  ring: Ring | undefined | null,
  heightM: number,
  sun: SunDirection,
  latitude: number,
): ShadowMultiPolygon | null {
  const base = cleanRing(ring);
  if (!base) return null;
  return buildingShadowMulti([[base]], heightM, sun, latitude);
}

// Кольцо, у которого после union остались десятки коллинеарных точек на
// прямых участках, раздувает стоимость следующего union в разы. Точки,
// лежащие на прямой с точностью ~10 см, выкидываем: форма не меняется,
// а вершин становится в 20 раз меньше.
const COLLINEAR_EPS = 1e-10; // deg² ≈ 0.1 м прогиба на 10 м отрезка
const POINT_EPS = 1e-9; // ~0.1 мм: склейка совпадающих точек

function simplifyRing(ring: Ring): Ring | null {
  if (!ring || ring.length < 4) return null;
  const open: Ring = [];
  for (const point of ring) {
    const last = open[open.length - 1];
    if (
      last &&
      Math.abs(last[0] - point[0]) < POINT_EPS &&
      Math.abs(last[1] - point[1]) < POINT_EPS
    ) {
      continue;
    }
    open.push(point);
  }
  if (open.length > 1) {
    const first = open[0];
    const last = open[open.length - 1];
    if (
      Math.abs(first[0] - last[0]) < POINT_EPS &&
      Math.abs(first[1] - last[1]) < POINT_EPS
    ) {
      open.pop();
    }
  }
  if (open.length < 3) return null;

  const kept: Ring = [];
  const count = open.length;
  for (let i = 0; i < count; i += 1) {
    const prev = open[(i - 1 + count) % count];
    const current = open[i];
    const next = open[(i + 1) % count];
    const cross =
      (current[0] - prev[0]) * (next[1] - prev[1]) -
      (current[1] - prev[1]) * (next[0] - prev[0]);
    if (Math.abs(cross) > COLLINEAR_EPS) kept.push(current);
  }
  if (kept.length < 3) return null;
  return [...kept, kept[0]];
}

/**
 * Растворение теней кадра в один MultiPolygon: перекрытия соседних домов
 * перестают складывать альфу (иначе тёмные пятна выжигают подложку).
 * Полигоны предварительно упрощаются — union по «чистым» контурам на порядок
 * дешевле.
 */
export function dissolveShadows(
  polygons: ShadowMultiPolygon[],
): ShadowMultiPolygon {
  if (polygons.length === 0) return [];
  const simplified: ShadowMultiPolygon = [];
  for (const multi of polygons) {
    for (const polygon of multi) {
      const rings: Ring[] = [];
      for (const ring of polygon) {
        const simple = simplifyRing(ring);
        if (simple) rings.push(simple);
      }
      if (rings.length > 0) simplified.push(rings);
    }
  }
  if (simplified.length === 0) return [];
  if (simplified.length === 1) return simplified;
  try {
    const merged = polygonClipping.union(
      simplified[0] as never,
      ...(simplified.slice(1) as never[]),
    ) as unknown as ShadowMultiPolygon;
    return merged.filter((polygon) => Array.isArray(polygon) && polygon.length > 0);
  } catch {
    // Булева операция упала — отдаём полигоны как есть (тень останется,
    // но перекрытия снова начнут складывать альфу). Лучше, чем пустой слой.
    return simplified;
  }
}

export type DustSpot = {
  lon: number;
  lat: number;
  areaM2: number;
};

/**
 * Точки для векторов пыли: центры bbox полигонов строек/пустырей.
 * Крупные — первыми, слишком близкие друг к другу отбрасываем, чтобы
 * стрелки не слипались в кашу.
 */
export function dustSpots(
  polygons: ShadowMultiPolygon[],
  latitude: number,
  options: {
    minAreaM2?: number;
    minSpacingM?: number;
    limit?: number;
  } = {},
): DustSpot[] {
  const minAreaM2 = options.minAreaM2 ?? 400;
  const minSpacingM = options.minSpacingM ?? 140;
  const limit = options.limit ?? 16;

  const candidates: DustSpot[] = [];
  for (const multi of polygons) {
    for (const polygon of multi) {
      const outer = cleanRing(polygon[0]);
      if (!outer) continue;
      const areaM2 = ringAreaM2(outer, latitude);
      if (areaM2 < minAreaM2) continue;
      let west = Infinity;
      let east = -Infinity;
      let south = Infinity;
      let north = -Infinity;
      for (const [lon, lat] of outer) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
      candidates.push({
        lon: (west + east) / 2,
        lat: (south + north) / 2,
        areaM2,
      });
    }
  }
  candidates.sort((a, b) => b.areaM2 - a.areaM2);

  const picked: DustSpot[] = [];
  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    const tooClose = picked.some(
      (spot) => distanceMeters([spot.lon, spot.lat], [candidate.lon, candidate.lat]) < minSpacingM,
    );
    if (!tooClose) picked.push(candidate);
  }
  return picked;
}
