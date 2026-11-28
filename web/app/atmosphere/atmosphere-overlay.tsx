"use client";

// «Атмосфера»: ветер как поток частиц на canvas 2D вместо стрелок-символов.
// Один canvas на весь экран, клики не ловит, под панелями (z-index как у
// `.sky-twilight`). Данные — из общего стека погоды (`context.weather`), поэтому
// своего запроса нет: пока снимка нет, канваса нет вообще (S9).
//
// Состояние неба (skyState по weather_code) добавляет к струям осадки:
// дождь — штрихи по ветру, снег — медленные снежинки с покачиванием, туман —
// крупные клочья. Переходы только прозрачностью, 350 мс; в дождь и снег
// лазурные струи гаснут до 0,3, в туман — до нуля.
//
// Пыль строек приходит из общего store (`dust-store`): её публикует слой
// «Тени и пыль», поэтому выключенный слой гасит и шлейфы.
//
// Анимация — requestAnimationFrame; на скрытой вкладке rAF останавливается, а
// при `prefers-reduced-motion: reduce` рисуется один статичный кадр без rAF.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LayerContext } from "../layers/contract";
import {
  DUST_COLORS,
  dustTrail,
  nearestDustSpots,
  type DustTrail,
} from "./dust";
import { dustStore, type DustHotspot } from "./dust-store";
import {
  advanceFog,
  advanceRain,
  advanceSnow,
  createFog,
  createRain,
  createSnow,
  rainSpeedPx,
  rainCount,
  snowSpeedPx,
  snowCount,
  type FogPuff,
  type RainDrop,
  type SnowFlake,
} from "./precip";
import {
  drawAtmosphereFrame,
  drawDust,
  drawFog,
  drawRain,
  drawSnow,
} from "./render";
import {
  hasPrecipitation,
  SKY_TRANSITION_MS,
  skyState,
  STREAM_OPACITY,
  type SkyKind,
} from "./sky";
import {
  advanceStreams,
  createStreams,
  flowSpan,
  seededRandom,
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
/** Seed шлейфов пыли: у каждого очага свой, картина стабильна между кадрами. */
const DUST_SEED = 907;
const EMPTY_HOTSPOTS: DustHotspot[] = [];

type Scene = {
  kind: SkyKind;
  streams: WindStream[];
  rain: RainDrop[];
  snow: SnowFlake[];
  fog: FogPuff[];
  width: number;
  height: number;
  bearingDeg: number;
  span: number;
  speedPx: number;
};

function moveToward(current: number, target: number, step: number): number {
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}

export default function AtmosphereOverlay({ context }: { context: LayerContext }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapRef = useRef(context.getMap());
  mapRef.current = context.getMap();
  // Погода из общего стека слоя: подписка перерисовывает компонент, когда
  // Open-Meteo ответил или сменился час таймлайна.
  const snapshot = useSyncExternalStore(
    context.weather.subscribe,
    context.weather.get,
    () => null,
  );
  const hotspots = useSyncExternalStore(
    dustStore.subscribe,
    dustStore.get,
    () => EMPTY_HOTSPOTS,
  );
  const hotspotsRef = useRef(hotspots);
  hotspotsRef.current = hotspots;

  const values = context.weather.at(context.time.minutes) ?? snapshot;
  const windMs = values?.windSpeedMs ?? null;
  const directionFrom = values?.windDirectionDeg ?? null;
  const theme = context.theme;
  const kind = skyState(values);

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

    // Переходы «только прозрачностью»: линейно доходим до цели за 350 мс.
    let streamAlpha = STREAM_OPACITY[kind];
    let precipAlpha = hasPrecipitation(kind) ? 1 : 0;
    let fogAlpha = kind === "fog" ? 1 : 0;
    const targetStream = STREAM_OPACITY[kind];
    const targetPrecip = hasPrecipitation(kind) ? 1 : 0;
    const targetFog = kind === "fog" ? 1 : 0;

    let lastDust = -1;
    let lastStream = -1;

    function projectDustTrails(): DustTrail[] {
      const map = mapRef.current;
      const spots = hotspotsRef.current;
      if (!map || spots.length === 0 || !scene) return [];
      const width = scene.width;
      const height = scene.height;
      const projected: Array<{ x: number; y: number; distance: number }> = [];
      for (const spot of spots) {
        let point: { x: number; y: number };
        try {
          point = map.project([spot.lon, spot.lat]);
        } catch {
          continue;
        }
        if (
          point.x < -60 ||
          point.x > width + 60 ||
          point.y < -60 ||
          point.y > height + 60
        ) {
          continue;
        }
        projected.push({
          x: point.x,
          y: point.y,
          distance: Math.hypot(point.x - width / 2, point.y - height / 2),
        });
      }
      // Больше шести очагов — каша: берём ближайшие к центру кадра.
      const nearest = nearestDustSpots(projected, width / 2, height / 2);
      return nearest.map((spot, index) =>
        dustTrail({
          x: spot.x,
          y: spot.y,
          windDirectionFrom: directionValue,
          rand: seededRandom(DUST_SEED + index * 97),
          timeSec,
        }),
      );
    }

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
        opacity: streamAlpha,
      });
      if (scene.kind === "rain") {
        drawRain(
          ctx,
          scene.rain,
          scene.bearingDeg,
          palette.wind,
          precipAlpha,
        );
      } else if (scene.kind === "snow") {
        drawSnow(ctx, scene.snow, palette.wind, precipAlpha, timeSec);
      } else if (scene.kind === "fog") {
        drawFog(ctx, scene.fog, palette.wind, fogAlpha);
      }
      const trails = projectDustTrails();
      drawDust(ctx, trails, DUST_COLORS[theme], 1);

      // Атрибуты меняются только при заметном изменении: не дёргаем DOM кадр.
      if (dots !== drawnDots) {
        drawnDots = dots;
        canvas.dataset.atmosphereDots = String(dots);
      }
      if (trails.length !== lastDust) {
        lastDust = trails.length;
        canvas.dataset.atmosphereDust = String(trails.length);
      }
      const streamRounded = Math.round(streamAlpha * 100);
      if (streamRounded !== lastStream) {
        lastStream = streamRounded;
        canvas.dataset.atmosphereStreamOpacity = (streamRounded / 100).toFixed(2);
      }
    }

    /** Размер canvas под экран и новая сцена: струи, осадки, туман. */
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const width = Math.max(1, Math.round(window.innerWidth));
      const height = Math.max(1, Math.round(window.innerHeight));
      const bitmapWidth = Math.round(width * dpr);
      const bitmapHeight = Math.round(height * dpr);
      if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
      if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const bearingDeg = flightBearingDeg(directionValue);
      const speedPx = streamSpeedPx(windValue);
      const span = flowSpan(width, height, bearingDeg, streamLengthPx(speedPx));
      const count = streamCount(windValue);
      const rand = streamRandom(count);
      scene = {
        kind,
        streams: createStreams({
          count,
          width,
          height,
          bearingDeg,
          speedPx,
          span,
          rand,
        }),
        rain:
          kind === "rain"
            ? createRain({
                width,
                height,
                bearingDeg,
                windMs: windValue,
                rand: seededRandom(211),
              })
            : [],
        snow:
          kind === "snow"
            ? createSnow({ width, height, rand: seededRandom(307) })
            : [],
        fog:
          kind === "fog"
            ? createFog({ width, height, rand: seededRandom(401) })
            : [],
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
      canvas.dataset.atmosphereSky = kind;
      canvas.dataset.atmospherePrecip = String(
        kind === "rain"
          ? rainCount(width, height)
          : kind === "snow"
            ? snowCount(width, height)
            : 0,
      );
      const fogMax =
        kind === "fog" && scene.fog.length > 0
          ? Math.max(...scene.fog.map((puff) => puff.alpha))
          : 0;
      canvas.dataset.atmosphereFogAlpha = fogMax.toFixed(2);
      canvas.dataset.atmosphereDustColor = DUST_COLORS[theme];
      if (kind === "rain") {
        canvas.dataset.atmosphereRainSpeed = String(
          Math.round(rainSpeedPx(windValue, 1)),
        );
        canvas.dataset.atmosphereRainBearing = bearingDeg.toFixed(2);
      } else {
        delete canvas.dataset.atmosphereRainSpeed;
        delete canvas.dataset.atmosphereRainBearing;
      }
      if (kind === "snow") {
        canvas.dataset.atmosphereSnowSpeed = String(
          Math.round(snowSpeedPx(1)),
        );
      } else {
        delete canvas.dataset.atmosphereSnowSpeed;
      }
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
      if (scene.kind === "rain") {
        advanceRain(
          scene.rain,
          dt,
          scene.width,
          scene.height,
          scene.bearingDeg,
        );
      } else if (scene.kind === "snow") {
        advanceSnow(scene.snow, dt, scene.height);
      } else if (scene.kind === "fog") {
        advanceFog(scene.fog, dt, scene.bearingDeg, scene.width, scene.height);
      }
      // Переходы — только прозрачностью, ровно за SKY_TRANSITION_MS.
      const step = (dt * 1000) / SKY_TRANSITION_MS;
      streamAlpha = moveToward(streamAlpha, targetStream, step);
      precipAlpha = moveToward(precipAlpha, targetPrecip, step);
      fogAlpha = moveToward(fogAlpha, targetFog, step);
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
        streamAlpha = targetStream;
        precipAlpha = targetPrecip;
        fogAlpha = targetFog;
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
    // Смена силы/направления ветра, темы и состояния неба пересобирает сцену.
  }, [windMs, directionFrom, theme, kind]);

  // Нет данных — нет частиц: слой не рисует пустую анимацию (S9).
  if (values === null || windMs === null || directionFrom === null) return null;

  const bearing = flightBearingDeg(directionFrom);
  return (
    <canvas
      ref={canvasRef}
      data-atmosphere="1"
      data-atmosphere-sky={kind}
      data-atmosphere-wind={windMs.toFixed(2)}
      data-atmosphere-bearing={bearing.toFixed(2)}
      data-atmosphere-streams={String(streamCount(windMs))}
      data-atmosphere-theme={theme}
      aria-hidden
      className="atmosphere-flow"
    />
  );
}
