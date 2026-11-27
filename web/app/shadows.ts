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
 * «Мост» между контуром и его сдвинутой копией: четырёхугольник по крайним
 * точкам вдоль оси, перпендикулярной тени. Без него union двух копий даёт
 * две отдельные фигуры с разрывом длиной в саму тень (длинная тень «отрывается»
 * от дома), а с мостом получается заметённая полоса — для выпуклого контура
 * это ровно выпуклая оболочка, для сложного — её разумное приближение.
 */
function bridgeQuad(
  base: ShadowMultiPolygon,
  shifted: ShadowMultiPolygon,
  offset: ShadowOffset,
  latitude: number,
): Ring | null {
  const length = Math.hypot(offset.eastM, offset.northM);
  if (!(length > 0)) return null;
  const per = metersPerDegree(latitude);
  // Ось, перпендикулярная сдвигу: p = (north, -east) / length.
  const px = offset.northM / length;
  const py = -offset.eastM / length;

  const extreme = (points: LonLat[], sign: 1 | -1): LonLat | null => {
    let best: LonLat | null = null;
    let bestDot = -Infinity;
    for (const point of points) {
      const dot = (point[0] * per.lon * px + point[1] * per.lat * py) * sign;
      if (dot > bestDot) {
        bestDot = dot;
        best = point;
      }
    }
    return best;
  };

  const basePoints: LonLat[] = [];
  for (const polygon of base) basePoints.push(...polygon[0]);
  const shiftedPoints: LonLat[] = [];
  for (const polygon of shifted) shiftedPoints.push(...polygon[0]);

  const baseMax = extreme(basePoints, 1);
  const baseMin = extreme(basePoints, -1);
  const shiftedMax = extreme(shiftedPoints, 1);
  const shiftedMin = extreme(shiftedPoints, -1);
  if (!baseMax || !baseMin || !shiftedMax || !shiftedMin) return null;

  return [
    [baseMax[0], baseMax[1]],
    [shiftedMax[0], shiftedMax[1]],
    [shiftedMin[0], shiftedMin[1]],
    [baseMin[0], baseMin[1]],
    [baseMax[0], baseMax[1]],
  ];
}

/**
 * Тень дома: union исходного контура, контура, сдвинутого на всю длину тени
 * (проекция верхней кромки на землю), и «моста» между ними. null — тени нет.
 * Дыры (внутренние кольца) не переносим: тень двора перекрывается телом тени.
 * Несколько полигонов — части одного дома, разрезанного границей тайла:
 * объединяем их сразу, иначе на стыке тайлов тень темнеет дважды.
 */
export function buildingShadowMulti(
  polygons: ShadowMultiPolygon,
  heightM: number,
  sun: SunDirection,
  latitude: number,
): ShadowMultiPolygon | null {
  const base: ShadowMultiPolygon = [];
  for (const polygon of polygons) {
    const outer = cleanRing(polygon[0]);
    if (outer) base.push([outer]);
  }
  if (base.length === 0) return null;

  const offset = shadowOffset(heightM, sun);
  if (!offset) return null;

  const shifted: ShadowMultiPolygon = base.map((polygon) =>
    polygon.map((ring) =>
      translateRing(ring, offset.eastM, offset.northM, latitude),
    ),
  );
  const bridge = bridgeQuad(base, shifted, offset, latitude);

  try {
    const bridgeGeom = bridge ? [[bridge]] : [];
    const merged = polygonClipping.union(
      base as never,
      shifted as never,
      ...(bridgeGeom as never[]),
    ) as unknown as ShadowMultiPolygon;
    const result = merged.filter(
      (polygon) => Array.isArray(polygon) && polygon.length > 0,
    );
    return result.length > 0 ? result : null;
  } catch {
    // Булева операция не должна ронять слой: рисуем оба контура как есть.
    return [...base, ...shifted];
  }
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
