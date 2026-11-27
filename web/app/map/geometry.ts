import type { Geometry, Position } from "geojson";
import polygonClipping from "polygon-clipping";

// Web Mercator (спецификация XYZ / slippy map): lon/lat → номер тайла.
export function lonLatToTileXY(lon: number, lat: number, zoom: number): [number, number] {
  const n = 2 ** zoom;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

// Сплошной полигон крыши, слегка расширенный наружу (~1.5 px на текущем зуме):
// рисуется на 5 см ниже основной крыши дома (buildings-selected-roof), поэтому
// вся внутренняя площадь и любые стыки тайлов перекрываются крышей цвета ступени,
// а снаружи остаётся только чистый тонкий контур по внешнему периметру крыши.
export function outsetPolygonRing(ring: Position[], outsetMeters: number): Position[] | null {
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
  if (n < 3) return null;

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
  if (Math.abs(signedArea2) * 0.5 < 2) return null;

  const d = outsetMeters;
  // Внешняя нормаль противоположна внутренней:
  const sign = signedArea2 >= 0 ? -1 : 1;

  const edgeNormals: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1] = local[i];
    const [x2, y2] = local[(i + 1) % n];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    edgeNormals.push([(-sign * dy) / len, (sign * dx) / len]);
  }

  const outer: Position[] = [];
  for (let i = 0; i < n; i++) {
    const n1 = edgeNormals[(i - 1 + n) % n];
    const n2 = edgeNormals[i];
    const dot = n1[0] * n2[0] + n1[1] * n2[1];
    const denom = Math.max(0.35, 1 + dot);
    const k = Math.min(d * 1.35, d / denom);
    const ox = local[i][0] + k * (n1[0] + n2[0]);
    const oy = local[i][1] + k * (n1[1] + n2[1]);
    outer.push([lon0 + ox / kx, lat0 + oy / ky]);
  }
  outer.push(outer[0]);
  return outer;
}

type LonLatPair = [number, number];

function cleanLonLatRing(ring: Position[]): LonLatPair[] {
  const pts: LonLatPair[] = [];
  for (const pt of ring) {
    const lon = pt[0];
    const lat = pt[1];
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(lon - prev[0], lat - prev[1]) > 1e-9) {
      pts.push([lon, lat]);
    }
  }
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9) {
      pts.pop();
    }
  }
  if (pts.length >= 3) pts.push(pts[0]);
  return pts;
}

function ringAreaM2(ring: LonLatPair[]): number {
  if (ring.length < 4) return 0;
  const [lon0, lat0] = ring[0];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  let area2 = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    const x1 = (lon1 - lon0) * kx;
    const y1 = (lat1 - lat0) * ky;
    const x2 = (lon2 - lon0) * kx;
    const y2 = (lat2 - lat0) * ky;
    area2 += x1 * y2 - x2 * y1;
  }
  return Math.abs(area2) * 0.5;
}

export function footprintAreaM2(geom: Geometry): number {
  const polygonArea = (rings: Position[][]): number => {
    let area = 0;
    for (let i = 0; i < rings.length; i++) {
      const a = ringAreaM2(cleanLonLatRing(rings[i]));
      area += i === 0 ? a : -a;
    }
    return Math.max(0, area);
  };
  if (geom.type === "Polygon") return polygonArea(geom.coordinates);
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.reduce((acc, poly) => acc + polygonArea(poly), 0);
  }
  return 0;
}

export function geometrySignature(geom: Geometry): string {
  const ringKey = (ring: Position[]) =>
    ring.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(";");
  if (geom.type === "Polygon") {
    return `P:${geom.coordinates.map(ringKey).join("|")}`;
  }
  if (geom.type === "MultiPolygon") {
    return `M:${geom.coordinates.map((poly) => poly.map(ringKey).join("/")).join("|")}`;
  }
  return "";
}

// V4b5: если смотреть на длинный дом с ребра, окна на фасаде не видны.
// Для выбранного дома выбираем bearing так, чтобы камера смотрела на самый
// длинный южный фасад (внешнее кольцо, без дворов).
export function facadeCameraBearing(geom: Geometry): number | null {
  const norm = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
  let bestLen = 0;
  let bestNormals: [number, number] | null = null;
  const visitRing = (ring: Position[]) => {
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];
      if (
        typeof lon1 !== "number" ||
        typeof lat1 !== "number" ||
        typeof lon2 !== "number" ||
        typeof lat2 !== "number"
      ) {
        continue;
      }
      const kx = 111320 * Math.cos((lat1 * Math.PI) / 180);
      const dx = (lon2 - lon1) * kx;
      const dy = (lat2 - lat1) * 110574;
      const len = Math.hypot(dx, dy);
      if (len < 6 || len <= bestLen) continue;
      const azimuth = (Math.atan2(dx, dy) * 180) / Math.PI;
      bestLen = len;
      bestNormals = [azimuth + 90, azimuth - 90];
    }
  };
  if (geom.type === "Polygon") {
    visitRing(geom.coordinates[0]);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) visitRing(poly[0]);
  }
  const normals = bestNormals as [number, number] | null;
  if (normals === null) return null;
  const [n1, n2] = normals;
  // Из двух сторон длинного фасада берём ту, что ближе к югу: камера
  // остаётся в привычной южной полусфере.
  const normal =
    Math.abs(norm(n1 - 180)) <= Math.abs(norm(n2 - 180)) ? n1 : n2;
  return norm(normal - 180);
}

// V4b5: дом режется границами тайлов PMTiles — склеиваем все его части
// (union) в один footprint. Порядок колец и дыры сохраняет polygon-clipping:
// внешние кольца CCW, внутренние (дворы) CW.
export function unionFootprintGeometries(geoms: Geometry[]): Geometry | null {
  if (geoms.length === 1 && geoms[0].type === "Polygon") {
    const rings = geoms[0].coordinates
      .map(cleanLonLatRing)
      .filter((ring) => ring.length >= 4);
    return rings.length ? { type: "Polygon", coordinates: rings } : null;
  }

  const polygons: LonLatPair[][][] = [];
  for (const geom of geoms) {
    if (geom.type === "Polygon") {
      const rings = geom.coordinates.map(cleanLonLatRing).filter((r) => r.length >= 4);
      if (rings.length) polygons.push(rings);
    } else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates) {
        const rings = poly.map(cleanLonLatRing).filter((r) => r.length >= 4);
        if (rings.length) polygons.push(rings);
      }
    }
  }
  const valid = polygons.filter((poly) => poly.length > 0);
  if (!valid.length) return null;
  if (valid.length === 1) {
    return { type: "Polygon", coordinates: valid[0] as unknown as Position[][] };
  }
  try {
    const merged = polygonClipping.union(
      valid[0] as never,
      ...(valid.slice(1) as never[]),
    ) as unknown as LonLatPair[][][];
    const polys = merged.filter((poly) => poly.length > 0);
    if (!polys.length) return null;
    return { type: "MultiPolygon", coordinates: polys as unknown as Position[][][] };
  } catch (e) {
    // Булева операция не должна ронять карту: показываем части как есть,
    // санитарная проверка площади ниже не даст строить окна на обрезке.
    console.warn("Не удалось объединить части контура дома:", e);
    return { type: "MultiPolygon", coordinates: valid as unknown as Position[][][] };
  }
}

export type HeroFacadeEdge = {
  lon0: number;
  lat0: number;
  kx: number;
  ky: number;
  x1: number;
  y1: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  len: number;
  floors: number;
  buildingHeight: number;
  buildingId: number;
};

export function buildQuadRing(
  edge: HeroFacadeEdge,
  s0: number,
  s1: number,
  dInner: number,
  dOuter: number,
): Position[] {
  const { lon0, lat0, kx, ky, x1, y1, tx, ty, nx, ny } = edge;
  const pt = (s: number, d: number): Position => [
    lon0 + (x1 + s * tx + d * nx) / kx,
    lat0 + (y1 + s * ty + d * ny) / ky,
  ];
  const p00 = pt(s0, dInner);
  const p10 = pt(s1, dInner);
  const p11 = pt(s1, dOuter);
  const p01 = pt(s0, dOuter);
  const cross = tx * ny - ty * nx;
  return cross < 0 ? [p00, p10, p11, p01, p00] : [p00, p01, p11, p10, p00];
}
export type GFeature<P> = { type: "Feature"; geometry: Geometry; properties: P };
export type GCollection<P> = { type: "FeatureCollection"; features: GFeature<P>[] };
