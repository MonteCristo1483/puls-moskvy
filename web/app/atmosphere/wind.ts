// Ветер в числах для потока частиц: чистые функции, без DOM, canvas и таймеров.
//
// Метеонаправление — «откуда» (так его отдаёт Open-Meteo и так рисовали старые
// стрелки): 210° значит «дует из юго-юго-запада». Частицы летят туда, куда
// дует ветер, поэтому азимут полёта = направление + 180°.
import type { Theme } from "../theme";

/** При штиле поток не замирает совсем: медленный дрейф. */
export const BASE_STREAM_SPEED_PX = 12;
/** Прибавка скорости на каждый метр в секунду. */
export const STREAM_SPEED_PER_MS = 7.5;
/** Ниже этого ветер считается слабым — две струи. */
export const MEDIUM_WIND_MS = 3;
/** От этого — сильный ветер, четыре струи. */
export const STRONG_WIND_MS = 6;
/** Базовый лазурный цвет обычного ветра. */
export const WIND_COLOR = "#7fd3ff";

/**
 * Скорость полёта частиц, px/с: `12 + 7.5 · v` — при штиле 12, при 10 м/с 87.
 * Отрицательные и нечисловые значения трактуем как штиль.
 */
export function streamSpeedPx(windMs: number): number {
  const speed = Number.isFinite(windMs) ? Math.max(0, windMs) : 0;
  return BASE_STREAM_SPEED_PX + STREAM_SPEED_PER_MS * speed;
}

/**
 * Азимут полёта (куда дует), градусы 0–360: `(windDirectionFrom + 180) % 360`.
 * 0° — север, 90° — восток. Отрицательные направления нормализуем.
 */
export function flightBearingDeg(windDirectionFrom: number): number {
  const direction = Number.isFinite(windDirectionFrom) ? windDirectionFrom : 0;
  return (direction + 180 + 360) % 360;
}

/**
 * Число струй: 2 на слабом ветре, 3 на среднем, 4 на сильном — и никогда
 * больше четырёх (больше — уже шум, а не поток).
 */
export function streamCount(windMs: number): number {
  const speed = Number.isFinite(windMs) ? Math.max(0, windMs) : 0;
  if (speed >= STRONG_WIND_MS) return 4;
  if (speed >= MEDIUM_WIND_MS) return 3;
  return 2;
}

/** Длина «кометы», px: сильнее ветер — длиннее след. */
export function streamLengthPx(speedPx: number): number {
  const length = 150 + speedPx * 2.6;
  return Math.round(Math.min(480, Math.max(150, length)));
}

export type AtmospherePalette = {
  /** Цвет обычного ветра. */
  wind: string;
  /** Мягкое свечение вокруг точки (та же лазурь, ниже альфа). */
  glow: string;
  /** Ядро: чуть светлее частицы, чтобы точка читалась на карте. */
  core: string;
};

/**
 * Палитра по теме: день — светло-лазурный `#7fd3ff`, ночь — тот же тон, но
 * холоднее (ближе к 210°) и приглушённее, чтобы не светиться на тёмной карте.
 */
export const ATMOSPHERE_PALETTE: Record<Theme, AtmospherePalette> = {
  light: {
    wind: WIND_COLOR,
    glow: "rgba(127, 211, 255, 0.30)",
    core: "#eaf8ff",
  },
  dark: {
    wind: "#699ed3",
    glow: "rgba(105, 158, 211, 0.24)",
    core: "#cfe8f7",
  },
};

export function atmospherePalette(theme: Theme): AtmospherePalette {
  return ATMOSPHERE_PALETTE[theme];
}
