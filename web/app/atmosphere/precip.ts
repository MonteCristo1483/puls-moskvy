// Осадки и туман как поле частиц — чистые функции без canvas и DOM.
//
// Направление всегда берём из ветра: у дождя штрих идёт строго по ветру
// (наклон = flightBearingDeg), у снега — падение вниз плюс покачивание,
// у тумана — медленный дрейф по ветру. Скорости и плотности — числа приёмки.
import { streamSpeedPx } from "./wind";

export type ScreenVector = { dx: number; dy: number };

/** Единичный вектор полёта ветра: 0° — вверх (север), 90° — вправо (восток). */
export function flightVector(bearingDeg: number): ScreenVector {
  const rad = (bearingDeg * Math.PI) / 180;
  return { dx: Math.sin(rad), dy: -Math.cos(rad) };
}

// ── Дождь ────────────────────────────────────────────────────────────────

export const RAIN_MIN_SPEED_PX = 380;
export const RAIN_MAX_SPEED_PX = 520;

/** Скорость капли: база 380–520 px/с плюс снос ветром. */
export function rainSpeedPx(windMs: number, unit = 1): number {
  const base =
    RAIN_MIN_SPEED_PX +
    (RAIN_MAX_SPEED_PX - RAIN_MIN_SPEED_PX) * Math.min(1, Math.max(0, unit));
  return base + streamSpeedPx(windMs) * 0.35;
}

/** Длина штриха растёт с силой ветра: 6 px в штиль, ~20 px при 10 м/с. */
export function rainStreakLengthPx(windMs: number): number {
  return Math.round((6 + streamSpeedPx(windMs) * 0.16) * 10) / 10;
}

/** Плотность дождя: на 390×844 — 286 капель (приёмка требует ≥ 250). */
export function rainCount(width: number, height: number): number {
  return Math.max(0, Math.round((width * height) / 1150));
}

export type RainDrop = {
  x: number;
  y: number;
  /** px/с вдоль вектора ветра. */
  speed: number;
  length: number;
  alpha: number;
};

export function createRain(options: {
  width: number;
  height: number;
  bearingDeg: number;
  windMs: number;
  rand: () => number;
}): RainDrop[] {
  const { width, height, windMs, rand } = options;
  const count = rainCount(width, height);
  const drops: RainDrop[] = [];
  for (let index = 0; index < count; index += 1) {
    drops.push({
      x: rand() * width,
      y: rand() * height,
      speed: rainSpeedPx(windMs, rand()),
      length: rainStreakLengthPx(windMs),
      alpha: 0.25 + rand() * 0.45,
    });
  }
  return drops;
}

/** Сдвинуть капли по ветру; ушедшие за кадр возвращаются с другой стороны. */
export function advanceRain(
  drops: RainDrop[],
  dtSec: number,
  width: number,
  height: number,
  bearingDeg: number,
): void {
  if (!Number.isFinite(dtSec) || dtSec <= 0) return;
  const { dx, dy } = flightVector(bearingDeg);
  const margin = 48;
  const spanX = width + margin * 2;
  const spanY = height + margin * 2;
  for (const drop of drops) {
    drop.x += dx * drop.speed * dtSec;
    drop.y += dy * drop.speed * dtSec;
    drop.x = ((((drop.x + margin) % spanX) + spanX) % spanX) - margin;
    drop.y = ((((drop.y + margin) % spanY) + spanY) % spanY) - margin;
  }
}

// ── Снег ─────────────────────────────────────────────────────────────────

export const SNOW_MIN_SPEED_PX = 70;
export const SNOW_MAX_SPEED_PX = 110;
/** Покачивание поперёк: ±8 px. */
export const SNOW_SWAY_PX = 8;

export function snowSpeedPx(unit = 1): number {
  return (
    SNOW_MIN_SPEED_PX +
    (SNOW_MAX_SPEED_PX - SNOW_MIN_SPEED_PX) * Math.min(1, Math.max(0, unit))
  );
}

/** Плотность снега: на 390×844 — 164 снежинки (приёмка требует ≥ 150). */
export function snowCount(width: number, height: number): number {
  return Math.max(0, Math.round((width * height) / 2000));
}

export type SnowFlake = {
  /** Базовая x без покачивания. */
  baseX: number;
  y: number;
  speed: number;
  swayPhase: number;
  swaySpeed: number;
  radius: number;
  alpha: number;
};

export function createSnow(options: {
  width: number;
  height: number;
  rand: () => number;
}): SnowFlake[] {
  const { width, height, rand } = options;
  const count = snowCount(width, height);
  const flakes: SnowFlake[] = [];
  for (let index = 0; index < count; index += 1) {
    flakes.push({
      baseX: rand() * width,
      y: rand() * height,
      speed: snowSpeedPx(rand()),
      swayPhase: rand() * Math.PI * 2,
      swaySpeed: 0.5 + rand() * 0.9,
      radius: 1.4 + rand() * 1.8,
      alpha: 0.3 + rand() * 0.4,
    });
  }
  return flakes;
}

/** Медленное падение вниз (по ветру не сносим — снег падает, а не летит). */
export function advanceSnow(
  flakes: SnowFlake[],
  dtSec: number,
  height: number,
): void {
  if (!Number.isFinite(dtSec) || dtSec <= 0) return;
  const span = height + 32;
  for (const flake of flakes) {
    flake.y = (flake.y + flake.speed * dtSec + 16) % span - 16;
  }
}

/** Покачивание снежинки поперёк: ±8 px, у каждой своя фаза и скорость. */
export function snowSwayPx(flake: SnowFlake, timeSec: number): number {
  return Math.sin(timeSec * flake.swaySpeed + flake.swayPhase) * SNOW_SWAY_PX;
}

// ── Туман ────────────────────────────────────────────────────────────────

export const FOG_ALPHA_MAX = 0.25;
export const FOG_DRIFT_PX_PER_S = 8;

export type FogPuff = {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  phase: number;
};

/** Туман — крупные медленные клочья; осадками не считается. */
export function fogCount(width: number, height: number): number {
  return Math.max(8, Math.round((width * height) / 26_000));
}

export function createFog(options: {
  width: number;
  height: number;
  rand: () => number;
}): FogPuff[] {
  const { width, height, rand } = options;
  const count = fogCount(width, height);
  const puffs: FogPuff[] = [];
  for (let index = 0; index < count; index += 1) {
    puffs.push({
      x: rand() * width,
      y: rand() * height,
      radius: 60 + rand() * 90,
      // Альфа каждого клочья ≤ 0,25; на перекрытиях туман всё равно мягкий.
      alpha: 0.08 + rand() * (FOG_ALPHA_MAX - 0.08),
      phase: rand() * Math.PI * 2,
    });
  }
  return puffs;
}

/** Туман ползёт по ветру ~8 px/с; медленно, без рывков. */
export function advanceFog(
  puffs: FogPuff[],
  dtSec: number,
  bearingDeg: number,
  width: number,
  height: number,
): void {
  if (!Number.isFinite(dtSec) || dtSec <= 0) return;
  const { dx, dy } = flightVector(bearingDeg);
  const step = FOG_DRIFT_PX_PER_S * dtSec;
  const spanX = width + 240;
  const spanY = height + 240;
  for (const puff of puffs) {
    puff.x += dx * step;
    puff.y += dy * step;
    puff.x = ((((puff.x + 120) % spanX) + spanX) % spanX) - 120;
    puff.y = ((((puff.y + 120) % spanY) + spanY) % spanY) - 120;
  }
}
