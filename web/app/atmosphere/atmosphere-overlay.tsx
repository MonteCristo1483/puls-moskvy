"use client";

// «Атмосфера»: ветер как поток частиц на canvas 2D вместо стрелок-символов.
// Один canvas на весь экран, клики не ловит, под панелями (z-index как у
// `.sky-twilight`). Данные — из общего стека погоды (`context.weather`), поэтому
// своего запроса нет: пока снимка нет, канваса нет вообще (S9).
//
// Анимация — requestAnimationFrame; на скрытой вкладке rAF останавливается, а
// при `prefers-reduced-motion: reduce` рисуется один статичный кадр без rAF.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LayerContext } from "../layers/contract";
import { drawAtmosphereFrame } from "./render";
import {
  advanceStreams,
  createStreams,
  flowSpan,
  streamParticleTotal,
  streamRandom,
  type WindStream,
} from "./streams";
import {
  atmospherePalette,
  flightBearingDeg,
  streamCount,
  streamLengthPx,
  streamSpeedPx,
} from "./wind";

/** Потолок devicePixelRatio: на 3x канвас в 9 раз дороже, а разницы не видно. */
const MAX_DPR = 2;
/** Вкладка могла провиснуть — не телепортируем струи через полэкрана. */
const MAX_FRAME_DT = 0.05;

type Scene = {
  streams: WindStream[];
  width: number;
  height: number;
  bearingDeg: number;
  span: number;
  speedPx: number;
};

export default function AtmosphereOverlay({ context }: { context: LayerContext }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Погода из общего стека слоя: подписка перерисовывает компонент, когда
  // Open-Meteo ответил или сменился час таймлайна.
  const snapshot = useSyncExternalStore(
    context.weather.subscribe,
    context.weather.get,
    () => null,
  );
  const values = context.weather.at(context.time.minutes) ?? snapshot;
  const windMs = values?.windSpeedMs ?? null;
  const directionFrom = values?.windDirectionDeg ?? null;
  const theme = context.theme;

  useEffect(() => {
    // Сужение типа не переживает вложенных function-деклараций (TS7), поэтому
    // фиксируем не-null ссылки один раз.
    const element = canvasRef.current;
    if (!element || windMs === null || directionFrom === null) return;
    const canvas: HTMLCanvasElement = element;
    const context2d = canvas.getContext("2d");
    if (!context2d) return;
    const ctx: CanvasRenderingContext2D = context2d;
    const windValue: number = windMs;
    const directionValue: number = directionFrom;

    const palette = atmospherePalette(theme);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let scene: Scene | null = null;
    let frameId = 0;
    let lastFrameAt = 0;
    let timeSec = 0;
    let staticMode = reducedMotion.matches;
    let drawnDots = -1;

    function draw() {
      if (!scene) return;
      const dots = drawAtmosphereFrame({
        ctx,
        width: scene.width,
        height: scene.height,
        bearingDeg: scene.bearingDeg,
        span: scene.span,
        timeSec,
        streams: scene.streams,
        palette,
        theme,
      });
      // Атрибут меняется только при смене числа видимых точек: не дёргаем DOM
      // каждый кадр.
      if (dots !== drawnDots) {
        drawnDots = dots;
        canvas.dataset.atmosphereDots = String(dots);
      }
    }

    /** Размер canvas под экран и новая сцена: струи, фазы, смещения. */
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const width = Math.max(1, Math.round(window.innerWidth));
      const height = Math.max(1, Math.round(window.innerHeight));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const bearingDeg = flightBearingDeg(directionValue);
      const speedPx = streamSpeedPx(windValue);
      const span = flowSpan(width, height, bearingDeg, streamLengthPx(speedPx));
      const count = streamCount(windValue);
      scene = {
        streams: createStreams({
          count,
          width,
          height,
          bearingDeg,
          speedPx,
          span,
          rand: streamRandom(count),
        }),
        width,
        height,
        bearingDeg,
        span,
        speedPx,
      };
      canvas.dataset.atmosphereParticles = String(
        streamParticleTotal(scene.streams),
      );
      canvas.dataset.atmosphereStreams = String(count);
      // При reduce движение выключено: после смены размера кадр перерисовываем
      // сразу, без кадрового цикла.
      if (staticMode) draw();
    }

    function schedule() {
      if (frameId || staticMode || document.hidden) return;
      frameId = window.requestAnimationFrame(frame);
    }

    function stop() {
      if (frameId) window.cancelAnimationFrame(frameId);
      frameId = 0;
    }

    function frame(now: number) {
      frameId = 0;
      if (!scene) return;
      const dt = lastFrameAt ? Math.min(MAX_FRAME_DT, (now - lastFrameAt) / 1000) : 0;
      lastFrameAt = now;
      timeSec += dt;
      advanceStreams(scene.streams, dt, scene.speedPx, scene.span);
      draw();
      schedule();
    }

    function onVisibilityChange() {
      if (document.hidden) {
        stop();
        return;
      }
      // Возврат на вкладку: не считаем паузу временем полёта.
      lastFrameAt = 0;
      schedule();
    }

    function onReducedMotionChange() {
      staticMode = reducedMotion.matches;
      stop();
      canvas.dataset.atmosphereMotion = staticMode ? "static" : "animated";
      if (staticMode) {
        lastFrameAt = 0;
        draw();
      } else {
        schedule();
      }
    }

    resize();
    canvas.dataset.atmosphereMotion = staticMode ? "static" : "animated";
    // Первый кадр рисуем сразу: при reduce он же и единственный.
    draw();
    schedule();

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    reducedMotion.addEventListener("change", onReducedMotionChange);
    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reducedMotion.removeEventListener("change", onReducedMotionChange);
    };
    // Смена силы/направления ветра и темы пересобирает сцену; движение
    // продолжается с текущей фазой только для resize — это осознанно.
  }, [windMs, directionFrom, theme]);

  // Нет данных — нет частиц: слой не рисует пустую анимацию (S9).
  if (values === null || windMs === null || directionFrom === null) return null;

  const bearing = flightBearingDeg(directionFrom);
  return (
    <canvas
      ref={canvasRef}
      data-atmosphere="1"
      data-atmosphere-wind={windMs.toFixed(2)}
      data-atmosphere-bearing={bearing.toFixed(2)}
      data-atmosphere-streams={String(streamCount(windMs))}
      data-atmosphere-theme={theme}
      aria-hidden
      className="atmosphere-flow"
    />
  );
}
