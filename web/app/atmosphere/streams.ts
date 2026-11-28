// Геометрия потока ветра: 2–4 струи-«кометы» из точек. Модуль чистый — ни
// canvas, ни DOM, ни таймеров: позиции считаются из времени и скорости, поэтому
// ту же модель можно проверить без браузера.
//
// Экранные координаты: x вправо, y вниз. Азимут полёта 0° — на север (вверх),
// 90° — на восток (вправо), поэтому вектор направления = (sin θ, −cos θ).
import { streamLengthPx } from "./wind";

export type RandomSource = () => number;

/**
 * Детерминированный ПСЧ (mulberry32): при одном seed картина та же — это нужно
 * статичному кадру и повторяемости проверок.
 */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type StreamParticle = {
  /** Место точки вдоль кометы: 0 — хвост, 1 — голова. */
  u: number;
  /** Поперечное смещение в долях полуширины, −1…1. */
  cross: number;
  /** Фаза собственного дрейфа, рад. */
  driftPhase: number;
  /** Скорость собственного дрейфа, рад/с. */
  driftSpeed: number;
  /** Амплитуда собственного дрейфа, px. */
  driftAmp: number;
  /** Радиус точки, px. */
  radius: number;
  /** Базовая яркость, 0…1. */
  brightness: number;
};

export type WindStream = {
  /** Пройденный по экрану путь, px (растёт на speed · dt). */
  travel: number;
  /** Поперечное смещение струи от центра экрана, px. */
  offset: number;
  /** Длина кометы, px. */
  length: number;
  /** Полуширина облака, px. */
  halfWidth: number;
  particles: StreamParticle[];
};

export type StreamOptions = {
  count: number;
  width: number;
  height: number;
  /** Направление полёта, градусы (0 — север, 90 — восток). */
  bearingDeg: number;
  /** Скорость потока, px/с — от неё зависит длина струи. */
  speedPx: number;
  /** Длина пути через экран, px (см. flowSpan) — по ней случайная фаза. */
  span: number;
  rand?: RandomSource;
};

const TAU = Math.PI * 2;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Длина пути через экран вдоль азимута: сколько нужно пролететь, чтобы комета
 * вошла с одной стороны и целиком ушла за другую (для заворота фазы).
 */
export function flowSpan(
  width: number,
  height: number,
  bearingDeg: number,
  lengthPx: number,
): number {
  const rad = toRadians(bearingDeg);
  const along =
    Math.abs(width * Math.sin(rad)) + Math.abs(height * Math.cos(rad));
  return Math.max(120, along + lengthPx + 80);
}

function makeParticle(rand: RandomSource): StreamParticle {
  // u = √r — точек гуще у головы, как у кометы: хвост растворяется.
  const u = Math.sqrt(rand());
  // Треугольное распределение в −1…1: облако не обрезано по краям.
  const cross = (rand() + rand() + rand()) / 1.5 - 1;
  return {
    u,
    cross,
    driftPhase: rand() * TAU,
    driftSpeed: 0.3 + rand() * 0.55,
    driftAmp: 2 + rand() * 5,
    radius: 1.3 + rand() * 1.8,
    brightness: 0.7 + rand() * 0.3,
  };
}

/**
 * Создать струи: случайная фаза, случайное поперечное смещение, свой размер.
 * Смещения раскладываются по ширине потока, чтобы струи не наезжали друг на
 * друга в одну линию.
 */
export function createStreams(options: StreamOptions): WindStream[] {
  const { width, height, bearingDeg, speedPx, span } = options;
  const rand = options.rand ?? Math.random;
  const count = Math.max(2, Math.min(4, Math.round(options.count)));
  const rad = toRadians(bearingDeg);
  // Полуширина экрана вдоль поперечной оси: дальше струя целиком уходит за
  // кадр, поэтому смещения ограничены этим пределом, а не диагональю.
  const perpX = Math.cos(rad);
  const perpY = Math.sin(rad);
  const halfPerp = Math.min(
    Math.abs(perpX) > 1e-6
      ? width / (2 * Math.abs(perpX))
      : Number.POSITIVE_INFINITY,
    Math.abs(perpY) > 1e-6
      ? height / (2 * Math.abs(perpY))
      : Number.POSITIVE_INFINITY,
  );
  const band = Number.isFinite(halfPerp)
    ? halfPerp
    : Math.min(width, height) / 2;
  // Протяжённость экрана вдоль ветра: струя длиннее половины этой дистанции,
  // иначе поток читается как облачко в центре, а не как поток.
  const alongExtent =
    Math.abs(width * Math.sin(rad)) + Math.abs(height * Math.cos(rad));
  const streams: WindStream[] = [];

  for (let index = 0; index < count; index += 1) {
    // Дорожки равномерно по ширине потока плюс небольшой случайный сдвиг.
    const lane = count === 1 ? 0 : index / (count - 1) - 0.5;
    const jitter = (rand() - 0.5) * (count === 1 ? 0 : 0.24);
    const offset = (lane + jitter) * band * 1.4;
    const length = Math.max(
      streamLengthPx(speedPx),
      alongExtent * (0.5 + rand() * 0.22),
    );
    // Узкая струя: вытянутое облако, а не широкая полоса, но с заметной
    // поперечной шириной — иначе точки выстраиваются в одну линию.
    const halfWidth = 22 + rand() * 26;
    // Плотность держим одинаковой: длиннее струя — больше точек в ней.
    const particleCount = Math.round(length * 0.32 + 20);
    const particles: StreamParticle[] = [];
    for (let pointIndex = 0; pointIndex < particleCount; pointIndex += 1) {
      particles.push(makeParticle(rand));
    }
    streams.push({
      // Фазы раскладываем по пути и размываем случайно: струи видны по всей
      // карте, а не собираются случайно у одного края.
      travel: ((index + rand() * 0.6) / count) * span,
      offset,
      length,
      halfWidth,
      particles,
    });
  }
  return streams;
}

/** Всего точек во всех струях — для атрибута `data-atmosphere-particles`. */
export function streamParticleTotal(streams: readonly WindStream[]): number {
  let total = 0;
  for (const stream of streams) total += stream.particles.length;
  return total;
}

/**
 * Сдвинуть струи на dt секунд: голова летит со скоростью ветра, пройденный
 * путь заворачивается по длине экрана. Мутация здесь намеренная — кадр не
 * должен аллоцировать массив струй.
 */
export function advanceStreams(
  streams: WindStream[],
  dtSec: number,
  speedPx: number,
  span: number,
): void {
  if (!Number.isFinite(dtSec) || dtSec <= 0) return;
  const step = speedPx * dtSec;
  for (const stream of streams) {
    stream.travel = (stream.travel + step) % span;
  }
}

export type StreamDot = {
  x: number;
  y: number;
  radius: number;
  /** Яркость точки 0…1. */
  alpha: number;
  /** 0 — хвост, 1 — голова: у головы рисуем светлое ядро. */
  heat: number;
};

/**
 * Точки струи в экранных координатах на момент `timeSec`.
 *
 * Центр потока — центр экрана; `travel − span/2` — голова кометы, от неё
 * назад вдоль вектора ветра идут точки. Своя жизнь точки — синусоидальный
 * дрейф поперёк и чуть вдоль, у каждой своя фаза и скорость.
 */
export function streamDots(
  stream: WindStream,
  bearingDeg: number,
  width: number,
  height: number,
  span: number,
  timeSec: number,
): StreamDot[] {
  const rad = toRadians(bearingDeg);
  const dirX = Math.sin(rad);
  const dirY = -Math.cos(rad);
  const perpX = Math.cos(rad);
  const perpY = Math.sin(rad);
  const centerX = width / 2;
  const centerY = height / 2;
  const head = stream.travel - span / 2;
  const dots: StreamDot[] = [];

  for (const particle of stream.particles) {
    // Облако сужается к хвосту и голове — тело струи, а не полоса.
    const taper = Math.sin(Math.PI * particle.u) ** 0.7;
    const wave = Math.sin(timeSec * particle.driftSpeed + particle.driftPhase);
    const lateral =
      stream.offset +
      particle.cross * stream.halfWidth * taper +
      wave * particle.driftAmp;
    const along = -particle.u * stream.length + wave * particle.driftAmp * 0.35;
    const x = centerX + dirX * (head + along) + perpX * lateral;
    const y = centerY + dirY * (head + along) + perpY * lateral;
    // За кадром не рисуем — точка вернётся на обороте фазы.
    if (x < -48 || x > width + 48 || y < -48 || y > height + 48) continue;
    dots.push({
      x,
      y,
      radius: particle.radius,
      alpha:
        particle.brightness *
        (0.32 + 0.68 * particle.u ** 1.2) *
        (0.75 + 0.25 * taper),
      heat: particle.u,
    });
  }
  return dots;
}
