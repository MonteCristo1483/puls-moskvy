// Рисование потока частиц на canvas 2D. Отдельно от геометрии: здесь только
// canvas-состояние и кисти, никакой React-логики.
import type { Theme } from "../theme";
import { streamDots, type WindStream } from "./streams";
import type { AtmospherePalette } from "./wind";

const TAU = Math.PI * 2;

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

/** Порог «голова кометы»: у неё рисуем светлое ядро. */
const CORE_HEAT = 0.78;
/** Порог «заметная точка»: только им нужен ореол — остальное экономит кадр. */
const GLOW_HEAT = 0.25;

/**
 * Кадр потока. Возвращает число точек, попавших на экран: по нему компонент
 * пишет `data-atmosphere-dots` (и тесты видят, что частицы действительно есть).
 */
export function drawAtmosphereFrame(options: DrawFrameOptions): number {
  const { ctx, width, height, bearingDeg, span, timeSec, streams, palette, theme } =
    options;
  ctx.clearRect(0, 0, width, height);
  // Ночь — аддитивное свечение (частицы «светятся»); день — обычное
  // смешивание: на светлой карте additive выбеливает лазурь в белое.
  ctx.globalCompositeOperation = theme === "dark" ? "lighter" : "source-over";
  let drawn = 0;

  for (const stream of streams) {
    const dots = streamDots(stream, bearingDeg, width, height, span, timeSec);
    drawn += dots.length;

    // Ореол — мягкое свечение вокруг ярких точек.
    ctx.fillStyle = palette.glow;
    for (const dot of dots) {
      if (dot.heat < GLOW_HEAT) continue;
      ctx.globalAlpha = dot.alpha * 0.22;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, dot.radius * 2.4, 0, TAU);
      ctx.fill();
    }
    // Тело частицы.
    ctx.fillStyle = palette.wind;
    for (const dot of dots) {
      ctx.globalAlpha = dot.alpha;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, dot.radius, 0, TAU);
      ctx.fill();
    }
    // Ядро у головы: точка не теряется на пёстром тайле.
    ctx.fillStyle = palette.core;
    for (const dot of dots) {
      if (dot.heat < CORE_HEAT) continue;
      ctx.globalAlpha = Math.min(1, dot.alpha * 1.35);
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, dot.radius * 0.55, 0, TAU);
      ctx.fill();
    }
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return drawn;
}
