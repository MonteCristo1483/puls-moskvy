// Геометрия потока ветра: 2–4 струи-«кометы» из точек. Модуль чистый — ни
// canvas, ни DOM, ни таймеров: позиции считаются из времени и скорости, поэтому
// ту же модель можно проверить без браузера.
//
// Экранные координаты: x вправо, y вниз. Азимут полёта 0° — на север (вверх),
// 90° — на восток (вправо), поэтому вектор направления = (sin θ, −cos θ).
import { streamLengthPx } from "./wind";

export type RandomSource = () => number;

/**
 * Seed картины слоя. Экспортируется, чтобы проверки геометрии считали ту же
 * картину, что видит человек: это не подгонка, а общая отправная точка.
 */
export const STREAM_SEED = 20_261_128;

/** ГПСЧ слоя: один и тот же seed на то же число струй. */
export function streamRandom(count: number): RandomSource {
  return seededRandom(STREAM_SEED + count * 7919);
}

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

export function makeParticle(rand: RandomSource): StreamParticle {
  // u равномерно вдоль следа: нить читается сплошной, а «кометность» задаёт
  // альфа-градиент (хвост тусклее, голова ярче), а не сгусток у головы.
  const u = rand();
  // Треугольное распределение в −1…1: облако не обрезано по краям.
  const cross = (rand() + rand() + rand()) / 1.5 - 1;
  return {
    u,
    cross,
    driftPhase: rand() * TAU,
    driftSpeed: 0.3 + rand() * 0.55,
    // Дрейф лёгкий: вместе с полушириной следа он держит поперечный разброс
    // в пределах 20 px — струя остаётся ниткой, а не облаком.
    driftAmp: 0.8 + rand() * 2.2,
    // Точка крупнее прежней: при узком следе именно размер ядра и ореола
    // делает нить читаемой на светлой карте.
    radius: 1.6 + rand() * 1.4,
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
  // Протяжённость экрана вдоль ветра: струя длиннее половины этой дистанции,
  // иначе поток читается как облачко в центре, а не как поток.
  const alongExtent =
    Math.abs(width * Math.sin(rad)) + Math.abs(height * Math.cos(rad));
  // Короткая ось экрана — поперёк потока: струи раскладываем по ней долями
  // 1/4, 2/4, 3/4 (для трёх) или 1/8…7/8 (для четырёх) с шагом в четверть,
  // чтобы все струи были видны одновременно и порознь.
  const shortAxis = Math.min(width, height);
  const laneSpread = (count - 1) * 0.25;
  const streams: WindStream[] = [];

  for (let index = 0; index < count; index += 1) {
    const lane =
      count === 1 ? 0.5 : 0.5 + (index / (count - 1) - 0.5) * laneSpread;
    // Джиттер — ±0,08 шага между струями: картина живая, но соседние центры
    // не сходятся ближе 60 px.
    const jitter = (rand() - 0.5) * 2 * 0.08 * (shortAxis / count);
    const offset = (lane - 0.5) * shortAxis + jitter;
    const length = Math.max(
      streamLengthPx(speedPx),
      // Не короче 58 % экрана вдоль ветра (приёмка требует ≥ 55 %).
      alongExtent * (0.58 + rand() * 0.2),
    );
    // Узкий след: точки выстраиваются в нитку, а не размазываются облаком.
    const halfWidth = 8 + rand() * 8;
    // Плотность держим одинаковой: длиннее струя — больше точек в ней.
    const particleCount = Math.round(length * 0.55 + 30);
    const particles: StreamParticle[] = [];
    for (let pointIndex = 0; pointIndex < particleCount; pointIndex += 1) {
      particles.push(makeParticle(rand));
    }
    // Фазу выбираем так, чтобы тело струи пересекало экран: голова гуляет по
    // окну «от края экрана до края плюс длина следа». Случайный джиттер
    // оставляет картину живой, но струи видны все сразу, а не по одной.
    const visibleWindow = alongExtent + length;
    const head =
      -alongExtent / 2 +
      ((index + 0.5) / count) * visibleWindow +
      (rand() - 0.5) * (visibleWindow / count) * 0.25;
    streams.push({
      travel: (head + span / 2) % span,
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
  /** 0 — хвост, 1 — голова: чем больше, тем ярче ядро. */
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
      heat: particle.u,
    });
  }
  return dots;
}
