// Рисование потока частиц на canvas 2D. Отдельно от геометрии: здесь только
// canvas-состояние и кисти, никакой React-логики.
import type { Theme } from "../theme";
import type { DustTrail } from "./dust";
import {
  flightVector,
  snowSwayPx,
  SNOW_SPRITE_RADIUS_SCALE,
  SNOW_SPRITE_STOPS,
  type FogPuff,
  type RainDrop,
  type SnowBucket,
  type SnowFlake,
} from "./precip";
import { streamDots, type WindStream } from "./streams";
import { FOG_VEIL_ALPHA } from "./sky";
import type { AtmospherePalette } from "./wind";

const TAU = Math.PI * 2;
/** Радиус мягкого свечения относительно ядра точки. */
const GLOW_SCALE = 2.2;
/** Постоянная альфа свечения: гало, а не второй яркий слой. */
const GLOW_ALPHA = 0.1;
/** Ядро: от 0,55 на хвосте до 0,95 у головы — точка читается на карте. */
const CORE_ALPHA_MIN = 0.55;
const CORE_ALPHA_MAX = 0.95;
/** Голова кометы крупнее остальных точек — у потока видно направление. */
const HEAD_SCALE = 1.6;
/** Ступени альфы ядра: заливаем пачками, а не по одной точке. */
const CORE_BUCKETS = 8;

function rgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export type DrawFrameOptions = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Направление полёта, градусы. */
  bearingDeg: number;
  /** Длина пути через экран, px (фаза заворота). */
  span: number;
  /** Время анимации, с. */
  timeSec: number;
  streams: readonly WindStream[];
  palette: AtmospherePalette;
  theme: Theme;
  /** Прозрачность струй 0…1: осадки/туман гасят их без рывка. */
  opacity?: number;
};

/**
 * Кадр потока. Возвращает число точек, попавших на экран: по нему компонент
 * пишет `data-atmosphere-dots` (и тесты видят, что частицы действительно есть).
 *
 * На каждую точку — два круга: мягкое свечение (радиус ×2,2, альфа 0,10) и
 * ядро (альфа 0,55–0,95, ярче к голове). Вместе они читаются на светлой
 * пастельной карте, не превращаясь в яркие «лампочки».
 */
export function drawAtmosphereFrame(options: DrawFrameOptions): number {
  const {
    ctx,
    width,
    height,
    bearingDeg,
    span,
    timeSec,
    streams,
    palette,
    theme,
    opacity = 1,
  } = options;
  // Кадр всегда начинается с очистки: даже при нулевой прозрачности струй
  // поверх лягут осадки/туман, а старые точки не должны остаться.
  ctx.clearRect(0, 0, width, height);
  if (opacity <= 0.01) return 0;
  // Ночь — аддитивное свечение (частицы «светятся»); день — обычное
  // смешивание: на светлой карте additive выбеливает лазурь в белое.
  ctx.globalCompositeOperation = theme === "dark" ? "lighter" : "source-over";
  ctx.fillStyle = palette.wind;
  let drawn = 0;

  for (const stream of streams) {
    const dots = streamDots(stream, bearingDeg, width, height, span, timeSec);
    drawn += dots.length;
    if (dots.length === 0) continue;

    // Свечение — одной пачкой на струю: альфа постоянная, поэтому путь
    // собираем целиком и заливаем один раз.
    ctx.globalAlpha = GLOW_ALPHA * opacity;
    ctx.beginPath();
    for (const dot of dots) {
      const radius = dot.radius * GLOW_SCALE;
      ctx.moveTo(dot.x + radius, dot.y);
      ctx.arc(dot.x, dot.y, radius, 0, TAU);
    }
    ctx.fill();

    // Ядро: альфа растёт к голове. Восемь ступеней — градиент сохраняется, а
    // заливка идёт пачками: на светлой карте точек много, по одной дорого.
    let head = dots[0];
    for (const dot of dots) {
      if (dot.heat > head.heat) head = dot;
    }
    for (let bucket = 0; bucket < CORE_BUCKETS; bucket += 1) {
      ctx.globalAlpha =
        (CORE_ALPHA_MIN +
          (CORE_ALPHA_MAX - CORE_ALPHA_MIN) *
            ((bucket + 0.5) / CORE_BUCKETS)) *
        opacity;
      ctx.beginPath();
      let hasPoints = false;
      for (const dot of dots) {
        const index = Math.min(
          CORE_BUCKETS - 1,
          Math.floor(dot.heat * CORE_BUCKETS),
        );
        if (index !== bucket) continue;
        hasPoints = true;
        ctx.moveTo(dot.x + dot.radius, dot.y);
        ctx.arc(dot.x, dot.y, dot.radius, 0, TAU);
      }
      if (hasPoints) ctx.fill();
    }

    // Голова кометы — крупнее и с максимальной альфой.
    ctx.globalAlpha = CORE_ALPHA_MAX * opacity;
    ctx.beginPath();
    ctx.arc(head.x, head.y, head.radius * HEAD_SCALE, 0, TAU);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return drawn;
}

/**
 * Дождь: штрихи строго вдоль вектора ветра. Хвост штриха смотрит против
 * движения, поэтому капля читается летящей по ветру. Альфу квантуем на
 * ступени и рисуем пачками: сотни одиночных stroke в кадре дороже, чем
 * восемь путей.
 */
export function drawRain(
  ctx: CanvasRenderingContext2D,
  drops: readonly RainDrop[],
  bearingDeg: number,
  color: string,
  opacity: number,
): void {
  if (opacity <= 0.01 || drops.length === 0) return;
  const { dx, dy } = flightVector(bearingDeg);
  const buckets = 8;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const low = bucket / buckets;
    const high = (bucket + 1) / buckets;
    ctx.globalAlpha = ((low + high) / 2) * opacity;
    ctx.beginPath();
    let hasDrops = false;
    for (const drop of drops) {
      // drop.alpha лежит в 0,25…0,7 — нормируем в 0…1 для ступени.
      const level = Math.min(0.999, Math.max(0, (drop.alpha - 0.25) / 0.45));
      if (Math.floor(level * buckets) !== bucket) continue;
      hasDrops = true;
      ctx.moveTo(drop.x, drop.y);
      ctx.lineTo(drop.x - dx * drop.length, drop.y - dy * drop.length);
    }
    if (hasDrops) ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Снег: спрайт с радиальным градиентом, без второго круга и без кольца. */
export function drawSnow(
  ctx: CanvasRenderingContext2D,
  flakes: readonly SnowFlake[],
  opacity: number,
  timeSec: number,
): void {
  if (opacity <= 0.01 || flakes.length === 0) return;
  for (const flake of flakes) {
    const sprite = snowSprite(flake.bucket);
    if (!sprite) continue;
    const halo = flake.radius * SNOW_SPRITE_RADIUS_SCALE;
    const size = halo * 2;
    ctx.globalAlpha = flake.alpha * opacity;
    ctx.drawImage(
      sprite,
      flake.baseX + snowSwayPx(flake, timeSec) - halo,
      flake.y - halo,
      size,
      size,
    );
  }
  ctx.globalAlpha = 1;
}

/** Размеры битмапов спрайта по ведрам (мелкий/средний/крупный). */
const SNOW_SPRITE_BITMAP_PX = [24, 36, 48];
const snowSpriteCache: Array<HTMLCanvasElement | null> = [null, null, null];

/**
 * Спрайт снежинки: один радиальный градиент из стопов (монотонная альфа).
 * Пререндерится один раз на ведро размера — в кадре только drawImage.
 */
function snowSprite(bucket: SnowBucket): HTMLCanvasElement | null {
  const cached = snowSpriteCache[bucket];
  if (cached) return cached;
  const size = SNOW_SPRITE_BITMAP_PX[bucket];
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  for (const stop of SNOW_SPRITE_STOPS) {
    gradient.addColorStop(stop.at, `rgba(${stop.color},${stop.alpha})`);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  snowSpriteCache[bucket] = canvas;
  return canvas;
}

/**
 * Туман: общая вуаль снизу вверх (альфа ≤ 0,12) плюс крупные мягкие клочья.
 * Карта остаётся различимой — это видимость, а не белая заливка.
 */
export function drawFog(
  ctx: CanvasRenderingContext2D,
  puffs: readonly FogPuff[],
  color: string,
  opacity: number,
  width: number,
  height: number,
): void {
  if (opacity <= 0.01 || puffs.length === 0) return;
  const veil = ctx.createLinearGradient(0, height, 0, 0);
  veil.addColorStop(0, rgba(color, FOG_VEIL_ALPHA * opacity));
  veil.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, width, height);

  for (const puff of puffs) {
    const gradient = ctx.createRadialGradient(
      puff.x,
      puff.y,
      0,
      puff.x,
      puff.y,
      puff.radius,
    );
    gradient.addColorStop(0, rgba(color, puff.alpha * opacity));
    gradient.addColorStop(0.55, rgba(color, puff.alpha * 0.85 * opacity));
    gradient.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(
      puff.x - puff.radius,
      puff.y - puff.radius,
      puff.radius * 2,
      puff.radius * 2,
    );
  }
}

/** Пыль: красные точки шлейфа возле очага стройки. */
export function drawDust(
  ctx: CanvasRenderingContext2D,
  trails: readonly DustTrail[],
  color: string,
  opacity: number,
): void {
  if (opacity <= 0.01 || trails.length === 0) return;
  ctx.fillStyle = color;
  for (const trail of trails) {
    for (const point of trail.points) {
      ctx.globalAlpha = point.alpha * opacity;
      ctx.beginPath();
      ctx.arc(point.x, point.y, point.radius, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
