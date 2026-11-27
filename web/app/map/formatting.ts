import type { Geometry, Position } from "geojson";
import type { BuildingBreakdown } from "../building-sheet";

// PERF-LOAD: ключ дедупликации фич подложки — первая координата геометрии
// (округление до 1e-5). Раньше в ключ шла вся геометрия через JSON.stringify:
// на z12.6+ это десятки мегабайт строк на каждую пачку догрузившихся тайлов.
function coordKey(point: Position | undefined): string {
  if (!point) return "";
  return `${Math.round(point[0] * 1e5)}:${Math.round(point[1] * 1e5)}`;
}

export function firstCoordinateKey(geometry: Geometry): string {
  switch (geometry.type) {
    case "GeometryCollection": {
      const first = geometry.geometries[0];
      return first ? firstCoordinateKey(first) : "";
    }
    case "Point":
      return coordKey(geometry.coordinates);
    case "MultiPoint":
    case "LineString":
      return coordKey(geometry.coordinates[0]);
    case "MultiLineString":
    case "Polygon":
      return coordKey(geometry.coordinates[0]?.[0]);
    case "MultiPolygon":
      return coordKey(geometry.coordinates[0]?.[0]?.[0]);
    default:
      return "";
  }
}

export function parseBuildingBreakdown(value: unknown): BuildingBreakdown | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? (parsed as BuildingBreakdown)
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object"
    ? (value as BuildingBreakdown)
    : null;
}

// Маршрут «по крышам» → мягкая дуга: квадратичная кривая Безье, контрольная
// точка сбоку от середины (линия огибает здания). Прямые отрезки не подходят —
// сэмплируем кривую в полилинию.
export function curvedLine(a: Position, b: Position, bend = 0.25): Position[] {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const cx = mx - dy * bend;
  const cy = my + dx * bend;
  const pts: Position[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const u = 1 - t;
    pts.push([
      u * u * a[0] + 2 * u * t * cx + t * t * b[0],
      u * u * a[1] + 2 * u * t * cy + t * t * b[1],
    ]);
  }
  return pts;
}
