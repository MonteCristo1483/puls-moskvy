// Рисование потока частиц на canvas 2D. Отдельно от геометрии: здесь только
// canvas-состояние и кисти, никакой React-логики.
import type { Theme } from "../theme";
import { streamDots, type WindStream } from "./streams";
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
  const { ctx, width, height, bearingDeg, span, timeSec, streams, palette, theme } =
    options;
  ctx.clearRect(0, 0, width, height);
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
    ctx.globalAlpha = GLOW_ALPHA;
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
        CORE_ALPHA_MIN +
        (CORE_ALPHA_MAX - CORE_ALPHA_MIN) * ((bucket + 0.5) / CORE_BUCKETS);
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
    ctx.globalAlpha = CORE_ALPHA_MAX;
    ctx.beginPath();
    ctx.arc(head.x, head.y, head.radius * HEAD_SCALE, 0, TAU);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return drawn;
}
