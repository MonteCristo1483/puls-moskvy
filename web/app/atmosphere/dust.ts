// Пыль стройплощадок: красные частицы, улетающие по ветру от очага.
// Чистая геометрия без canvas — точки шлейфа считаются из ветра и времени.
import type { Theme } from "../theme";
import { flightBearingDeg } from "./wind";

/** Цвет пыли: красно-оранжевый днём, глуше ночью. */
export const DUST_COLORS: Record<Theme, string> = {
  light: "#ff6b52",
  dark: "#e8604a",
};

/** Больше шести очагов в кадре — каша; берём ближайшие к центру. */
export const DUST_MAX_SOURCES = 6;
export const DUST_TRAIL_MIN_POINTS = 12;
export const DUST_TRAIL_MAX_POINTS = 20;
export const DUST_ALPHA_MIN = 0.35;
export const DUST_ALPHA_MAX = 0.8;

export type DustPoint = {
  x: number;
  y: number;
  radius: number;
  alpha: number;
};

export type DustTrail = {
  points: DustPoint[];
  /** Азимут шлейфа — для проверок направления. */
  bearing: number;
};

export type DustTrailOptions = {
  /** Очаг в экранных координатах. */
  x: number;
  y: number;
  /** Метеонаправление «откуда», как приходит из погоды. */
  windDirectionFrom: number;
  rand: () => number;
  timeSec: number;
};

/**
 * Шлейф из 12–20 точек: каждая следующая дальше по ветру от очага, альфа
 * гаснет к концу (0,8 → 0,35). Лёгкое покачивание поперёк делает шлейф живым,
 * но центробежность остаётся строго по азимуту ветра.
 */
export function dustTrail(options: DustTrailOptions): DustTrail {
  const { x, y, windDirectionFrom, rand, timeSec } = options;
  const bearing = flightBearingDeg(windDirectionFrom);
  const rad = (bearing * Math.PI) / 180;
  const dirX = Math.sin(rad);
  const dirY = -Math.cos(rad);
  const perpX = Math.cos(rad);
  const perpY = Math.sin(rad);
  const count =
    DUST_TRAIL_MIN_POINTS +
    Math.round(rand() * (DUST_TRAIL_MAX_POINTS - DUST_TRAIL_MIN_POINTS));
  const points: DustPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const progress = index / Math.max(1, count - 1);
    // Шаг 4–7 px: шлейф короткий и плотный у очага.
    const along = 3 + index * (4 + rand() * 3);
    const sway = Math.sin(timeSec * 1.1 + index * 0.7) * 1.5;
    const across = (rand() - 0.5) * 6 + sway;
    points.push({
      x: x + dirX * along + perpX * across,
      y: y + dirY * along + perpY * across,
      radius: 1 + rand() * 1.6,
      alpha: DUST_ALPHA_MAX - (DUST_ALPHA_MAX - DUST_ALPHA_MIN) * progress,
    });
  }
  return { points, bearing };
}

/** Центр тяжести шлейфа относительно очага — для проверки «по ветру». */
export function dustCentroid(
  trail: DustTrail,
  x: number,
  y: number,
): { dx: number; dy: number } {
  if (trail.points.length === 0) return { dx: 0, dy: 0 };
  let sumX = 0;
  let sumY = 0;
  for (const point of trail.points) {
    sumX += point.x;
    sumY += point.y;
  }
  return {
    dx: sumX / trail.points.length - x,
    dy: sumY / trail.points.length - y,
  };
}

export type ProjectedSpot = { x: number; y: number };

/**
 * Не больше `limit` очагов в кадре, ближайшие к центру: дальше начинается
 * каша из шлейфов. Чистая функция — проверяется без карты.
 */
export function nearestDustSpots(
  spots: readonly ProjectedSpot[],
  centerX: number,
  centerY: number,
  limit: number = DUST_MAX_SOURCES,
): ProjectedSpot[] {
  return [...spots]
    .map((spot) => ({
      spot,
      distance: Math.hypot(spot.x - centerX, spot.y - centerY),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.spot);
}
