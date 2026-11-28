import { test, expect, type Page } from "@playwright/test";
import {
  DUST_ALPHA_MAX,
  DUST_ALPHA_MIN,
  DUST_COLORS,
  DUST_MAX_SOURCES,
  dustCentroid,
  dustTrail,
  nearestDustSpots,
} from "../app/atmosphere/dust";
import {
  createFog,
  createSnow,
  flightVector,
  rainCount,
  rainSpeedPx,
  rainStreakLengthPx,
  SNOW_BUCKETS,
  snowAlphaProfile,
  snowCount,
  snowSpeedPx,
  snowSwayPx,
} from "../app/atmosphere/precip";
import { skyState } from "../app/atmosphere/sky";
import {
  createStreams,
  flowSpan,
  seededRandom,
  streamDots,
  streamRandom,
} from "../app/atmosphere/streams";
import {
  ATMOSPHERE_PALETTE,
  WIND_COLOR,
  flightBearingDeg,
  streamCount,
  streamLengthPx,
  streamSpeedPx,
} from "../app/atmosphere/wind";

// Слой «Поток ветра»: чистые числа (ветер, небо, осадки, пыль) + UI-проверки
// канваса. Погода мокается на уровне сети — как в weather.spec.ts.
const API = "https://api.open-meteo.com/**";

type MockWeather = {
  code?: number;
  temperature?: number;
  wind?: number;
  direction?: number;
  precipitation?: number;
};

async function mockWeather(
  page: Page,
  options: MockWeather = {},
): Promise<void> {
  const payload = {
    latitude: 55.7558,
    longitude: 37.6173,
    timezone: "Europe/Moscow",
    current: {
      time: "2026-11-27T11:00",
      temperature_2m: options.temperature ?? 3.2,
      wind_speed_10m: options.wind ?? 6,
      wind_direction_10m: options.direction ?? 210,
      precipitation: options.precipitation ?? 0.4,
      weather_code: options.code,
    },
  };
  await page.route(API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    }),
  );
}

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/** Относительная яркость sRGB — для сравнения «приглушённости» тем. */
function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Угол вектора в экранных координатах: 0° — вверх, 90° — вправо. */
function screenAngle(dx: number, dy: number): number {
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function streamScene() {
  const width = 390;
  const height = 844;
  const windMs = 3;
  const bearing = flightBearingDeg(210); // 30°
  const count = streamCount(windMs); // 3
  const speedPx = streamSpeedPx(windMs);
  const span = flowSpan(width, height, bearing, streamLengthPx(speedPx));
  const streams = createStreams({
    count,
    width,
    height,
    bearingDeg: bearing,
    speedPx,
    span,
    rand: streamRandom(count),
  });
  return { width, height, bearing, count, speedPx, span, streams };
}

async function openAtmosphere(page: Page, options: MockWeather = {}) {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWeather(page, options);
  await page.goto("./");
  const canvas = page.locator('[data-atmosphere="1"]');
  await expect(canvas).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Number(
            document
              .querySelector('[data-atmosphere="1"]')
              ?.getAttribute("data-atmosphere-particles") ?? 0,
          ),
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  return canvas;
}

/**
 * Кадр состояния при одной камере, теме и времени (как в D4): ждём, пока
 * карта и тайлы устоятся, затем снимаем весь экран.
 */
async function skyShot(page: Page, options: MockWeather): Promise<Buffer> {
  await page.setViewportSize({ width: 390, height: 844 });
  // Кадры снимаем в reduce-режиме: слой рисует один детерминированный кадр,
  // поэтому MAD меряет состояние неба, а не случайную фазу анимации.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.unroute(API).catch(() => {});
  await mockWeather(page, options);
  await page.goto("./?theme=light");
  await expect(page.locator('[data-atmosphere="1"]')).toBeVisible();
  await page
    .waitForFunction(
      () => {
        const map = (
          window as unknown as {
            __map?: { loaded?: () => boolean; areTilesLoaded?: () => boolean };
          }
        ).__map;
        return Boolean(
          map && map.loaded?.() && map.areTilesLoaded?.(),
        );
      },
      { timeout: 25_000 },
    )
    .catch(() => {});
  await expect(page.locator(".bg-splash")).toHaveCount(0);
  await page.waitForTimeout(800);
  return page.screenshot({ fullPage: false });
}

/**
 * MAD двух кадров (средняя абсолютная разница по каналам, 0–255) и средняя
 * яркость. Считаем в canvas страницы — без новых зависимостей. Сравниваем
 * «зону карты» (без панелей и плашек), а яркость проверяем по всему кадру.
 */
type FrameStats = {
  mad: number;
  meanFirst: number;
  meanSecond: number;
  madFull: number;
  meanFirstFull: number;
  meanSecondFull: number;
};

const MAP_ZONE = { x: 175, y: 120, width: 200, height: 460 };

async function frameDiff(
  page: Page,
  first: Buffer,
  second: Buffer,
): Promise<FrameStats> {
  return page.evaluate(
    async ({ firstData, secondData, zone }) => {
      const load = (source: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = source;
        });
      const [a, b] = await Promise.all([load(firstData), load(secondData)]);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        return {
          mad: 0,
          meanFirst: 0,
          meanSecond: 0,
          madFull: 0,
          meanFirstFull: 0,
          meanSecondFull: 0,
        };
      }

      const measure = (
        sourceA: HTMLImageElement,
        sourceB: HTMLImageElement,
        area: { x: number; y: number; width: number; height: number },
      ) => {
        canvas.width = area.width;
        canvas.height = area.height;
        ctx.drawImage(
          sourceA,
          area.x,
          area.y,
          area.width,
          area.height,
          0,
          0,
          area.width,
          area.height,
        );
        const pixelsA = ctx.getImageData(0, 0, area.width, area.height).data;
        ctx.clearRect(0, 0, area.width, area.height);
        ctx.drawImage(
          sourceB,
          area.x,
          area.y,
          area.width,
          area.height,
          0,
          0,
          area.width,
          area.height,
        );
        const pixelsB = ctx.getImageData(0, 0, area.width, area.height).data;
        let diff = 0;
        let sumA = 0;
        let sumB = 0;
        let count = 0;
        for (let index = 0; index < pixelsA.length; index += 4) {
          for (let channel = 0; channel < 3; channel += 1) {
            diff += Math.abs(
              pixelsA[index + channel] - pixelsB[index + channel],
            );
            sumA += pixelsA[index + channel];
            sumB += pixelsB[index + channel];
            count += 1;
          }
        }
        return {
          mad: diff / count,
          meanFirst: sumA / count,
          meanSecond: sumB / count,
        };
      };

      const zoneStats = measure(a, b, zone);
      const fullStats = measure(a, b, {
        x: 0,
        y: 0,
        width: a.width,
        height: a.height,
      });
      return {
        mad: zoneStats.mad,
        meanFirst: zoneStats.meanFirst,
        meanSecond: zoneStats.meanSecond,
        madFull: fullStats.mad,
        meanFirstFull: fullStats.meanFirst,
        meanSecondFull: fullStats.meanSecond,
      };
    },
    {
      firstData: `data:image/png;base64,${first.toString("base64")}`,
      secondData: `data:image/png;base64,${second.toString("base64")}`,
      zone: MAP_ZONE,
    },
  );
}

test("Атмосфера: скорость потока 12 + 7.5·v, азимут полёта обратен метео", () => {
  expect(streamSpeedPx(0)).toBeCloseTo(12, 6);
  expect(streamSpeedPx(5)).toBeCloseTo(49.5, 6);
  expect(streamSpeedPx(10)).toBeCloseTo(87, 6);
  expect(flightBearingDeg(210)).toBeCloseTo(30, 6);
  expect(flightBearingDeg(0)).toBeCloseTo(180, 6);
  expect(flightBearingDeg(90)).toBeCloseTo(270, 6);
  expect(flightBearingDeg(270)).toBeCloseTo(90, 6);
  expect(flightBearingDeg(-10)).toBeCloseTo(170, 6);
  expect(flightBearingDeg(180)).toBeCloseTo(0, 6);
});

test("Атмосфера: струй 2–4, при слабом ветре две, при сильном четыре", () => {
  expect(streamCount(0)).toBe(2);
  expect(streamCount(2)).toBe(2);
  expect(streamCount(10)).toBe(4);
  expect(streamCount(30)).toBe(4);
  for (let windMs = 0; windMs <= 40; windMs += 0.5) {
    expect(streamCount(windMs)).toBeGreaterThanOrEqual(2);
    expect(streamCount(windMs)).toBeLessThanOrEqual(4);
  }
});

test("Атмосфера: палитра — лазурная днём, холоднее и приглушённее ночью", () => {
  const day = ATMOSPHERE_PALETTE.light;
  const night = ATMOSPHERE_PALETTE.dark;
  expect(day.wind.toLowerCase()).toBe(WIND_COLOR);
  expect(WIND_COLOR).toBe("#7fd3ff");
  expect(night.wind.toLowerCase()).not.toBe(day.wind.toLowerCase());
  expect(luminance(night.wind)).toBeLessThan(luminance(day.wind));
  for (const color of [day.wind, night.wind]) {
    const { r, g, b } = hexToRgb(color);
    expect(b).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(r);
  }
});

test("Атмосфера: струи — узкие нитки во весь экран, центры не сливаются", () => {
  const { bearing, streams, span } = streamScene();
  const rad = (bearing * Math.PI) / 180;
  const dirX = Math.sin(rad);
  const dirY = -Math.cos(rad);
  const perpX = Math.cos(rad);
  const perpY = Math.sin(rad);
  const alongExtent =
    Math.abs(390 * dirX) + Math.abs(844 * dirY); // 926
  const center = 2500; // большой виртуальный холст: без обрезки кадром
  const crossCenters: number[] = [];
  let total = 0;

  for (const stream of streams) {
    total += stream.particles.length;
    const dots = streamDots(stream, bearing, 5000, 5000, span, 0);
    const across = dots.map(
      (dot) => perpX * (dot.x - center) + perpY * (dot.y - center),
    );
    const along = dots.map(
      (dot) => dirX * (dot.x - center) + dirY * (dot.y - center),
    );
    const acrossCenter =
      across.reduce((sum, value) => sum + value, 0) / across.length;
    crossCenters.push(acrossCenter);

    // Узость меряем относительно изогнутой оси: дуга не считается «шириной».
    const deviations = dots
      .filter((dot) => dot.stray === 0)
      .map((dot) => {
        const acrossAt = perpX * (dot.x - center) + perpY * (dot.y - center);
        const axis =
          stream.offset + stream.curve * Math.sin(Math.PI * dot.heat);
        return Math.abs(acrossAt - axis);
      });
    expect(Math.max(...deviations)).toBeLessThanOrEqual(20);

    // Длина: вдоль ветра разброс не короче 55 % экрана.
    expect(Math.max(...along) - Math.min(...along)).toBeGreaterThanOrEqual(
      0.55 * alongExtent,
    );
  }

  expect(total).toBeGreaterThanOrEqual(300);
  expect(streams.length).toBeGreaterThanOrEqual(2);
  expect(streams.length).toBeLessThanOrEqual(4);
  for (let index = 1; index < crossCenters.length; index += 1) {
    expect(
      Math.abs(crossCenters[index] - crossCenters[index - 1]),
    ).toBeGreaterThanOrEqual(60);
  }
});

test("Атмосфера: форма струи — дуга 6–14 px, неровный шаг, редкие выбросы", () => {
  const { streams } = streamScene();
  for (const stream of streams) {
    // Дуга: собственная амплитуда и знак у каждой струи.
    expect(Math.abs(stream.curve)).toBeGreaterThanOrEqual(6);
    expect(Math.abs(stream.curve)).toBeLessThanOrEqual(14);

    // Шаг вдоль следа неровный: коэффициент вариации промежутков ≥ 20 %.
    const us = stream.particles.map((particle) => particle.u).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let index = 1; index < us.length; index += 1) {
      gaps.push(us[index] - us[index - 1]);
    }
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const variance =
      gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length;
    expect(Math.sqrt(variance) / mean).toBeGreaterThanOrEqual(0.2);

    // Радиусы 0,8–2,6 px; изредка точки уходят с оси на 1–6 px.
    let stray = 0;
    for (const particle of stream.particles) {
      expect(particle.radius).toBeGreaterThanOrEqual(0.8);
      expect(particle.radius).toBeLessThanOrEqual(2.6);
      if (particle.stray !== 0) {
        stray += 1;
        expect(Math.abs(particle.stray)).toBeLessThanOrEqual(6);
      }
    }
    const strayShare = stray / stream.particles.length;
    expect(strayShare).toBeGreaterThanOrEqual(0.03);
    expect(strayShare).toBeLessThanOrEqual(0.12);
  }
});

test("Небо: код WMO и температура дают clear / rain / snow / fog", () => {
  expect(skyState({ weatherCode: 0, temperatureC: 3 })).toBe("clear");
  expect(skyState({ weatherCode: 1, temperatureC: 3 })).toBe("clear");
  expect(skyState({ weatherCode: 3, temperatureC: 3 })).toBe("clear");
  expect(skyState({ weatherCode: 61, temperatureC: 3 })).toBe("rain");
  expect(skyState({ weatherCode: 80, temperatureC: 2 })).toBe("rain");
  expect(skyState({ weatherCode: 51, temperatureC: 0.2 })).toBe("snow");
  expect(skyState({ weatherCode: 71, temperatureC: 3 })).toBe("snow");
  expect(skyState({ weatherCode: 85, temperatureC: -4 })).toBe("snow");
  expect(skyState({ weatherCode: 45, temperatureC: 3 })).toBe("fog");
  expect(skyState({ weatherCode: 48, temperatureC: -5 })).toBe("fog");
  expect(skyState({ weatherCode: null, temperatureC: 3 })).toBe("clear");
  expect(skyState(null)).toBe("clear");
});

test("Дождь: ≥250 капель, штрих строго по ветру, скорость ≥380 px/с", () => {
  expect(rainCount(390, 844)).toBeGreaterThanOrEqual(250);
  // Наклон штриха = азимут полёта ветра (допуск 3°).
  const bearing = flightBearingDeg(210);
  const { dx, dy } = flightVector(bearing);
  expect(angleDiff(screenAngle(dx, dy), bearing)).toBeLessThanOrEqual(3);
  // Скорость: 380–520 px/с плюс снос ветром — всегда ≥ 380.
  expect(rainSpeedPx(0, 0)).toBeGreaterThanOrEqual(380);
  expect(rainSpeedPx(3, 0)).toBeGreaterThanOrEqual(380);
  expect(rainSpeedPx(3, 1)).toBeGreaterThanOrEqual(rainSpeedPx(3, 0));
  // Длина штриха растёт с силой ветра.
  expect(rainStreakLengthPx(10)).toBeGreaterThan(rainStreakLengthPx(0));
});

test("Снег: медленный (≤110 px/с), качается ±8 px, ≥400 снежинок", () => {
  expect(snowCount(390, 844)).toBeGreaterThanOrEqual(400);
  expect(snowSpeedPx(1)).toBeLessThanOrEqual(110);
  expect(snowSpeedPx(0)).toBeGreaterThanOrEqual(70);
  const flakes = createSnow({ width: 390, height: 844, rand: seededRandom(5) });
  expect(flakes.length).toBeGreaterThanOrEqual(400);
  const buckets = [0, 0, 0];
  for (const flake of flakes) {
    const spec = SNOW_BUCKETS[flake.bucket];
    expect(flake.radius).toBeGreaterThanOrEqual(spec.minRadius);
    expect(flake.radius).toBeLessThanOrEqual(spec.maxRadius);
    expect(flake.alpha).toBeGreaterThanOrEqual(0.85);
    expect(flake.alpha).toBeLessThanOrEqual(1);
    buckets[flake.bucket] += 1;
  }
  // Крупных ~15 %, мелких ~50 % (с допуском на выборку).
  const smallShare = buckets[0] / flakes.length;
  const largeShare = buckets[2] / flakes.length;
  expect(smallShare).toBeGreaterThanOrEqual(0.4);
  expect(smallShare).toBeLessThanOrEqual(0.6);
  expect(largeShare).toBeGreaterThanOrEqual(0.08);
  expect(largeShare).toBeLessThanOrEqual(0.22);

  const flake = flakes[0];
  const swayA = snowSwayPx(flake, 0);
  const swayB = snowSwayPx(flake, 1.3);
  expect(swayA).not.toBe(swayB);
  expect(Math.abs(swayA)).toBeLessThanOrEqual(8);
  expect(Math.abs(swayB)).toBeLessThanOrEqual(8);
});

test("Снег: профиль альфы монотонно убывает к краю — без кольца", () => {
  // Шесть замеров по радиусу: 0, 0,2, 0,4, 0,6, 0,8, 1,0 доли.
  const fractions = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const alphas = fractions.map((fraction) => snowAlphaProfile(fraction));
  for (let index = 1; index < alphas.length; index += 1) {
    // Каждое следующее значение не больше предыдущего (+0,01 на шум).
    expect(alphas[index]).toBeLessThanOrEqual(alphas[index - 1] + 0.01);
  }
  // Ядро почти белое и непрозрачное, край полностью прозрачный.
  expect(alphas[0]).toBeGreaterThanOrEqual(0.9);
  expect(alphas[alphas.length - 1]).toBeLessThanOrEqual(0.01);
  expect(alphas[2]).toBeGreaterThan(0.4);
  expect(alphas[2]).toBeLessThan(0.8);
});

test("Туман: 6–9 клочьев радиусом 60–140 px, альфа 0,18–0,40", () => {
  const puffs = createFog({ width: 390, height: 844, rand: seededRandom(9) });
  expect(puffs.length).toBeGreaterThanOrEqual(6);
  expect(puffs.length).toBeLessThanOrEqual(9);
  for (const puff of puffs) {
    expect(puff.radius).toBeGreaterThanOrEqual(60);
    expect(puff.radius).toBeLessThanOrEqual(140);
    expect(puff.alpha).toBeGreaterThanOrEqual(0.18);
    expect(puff.alpha).toBeLessThanOrEqual(0.4);
  }
});

test("Пыль: ≤6 очагов, шлейф по ветру, цвет #ff6b52", () => {
  const spots = Array.from({ length: 10 }, (_, index) => ({
    x: index * 100,
    y: 400,
  }));
  const nearest = nearestDustSpots(spots, 500, 400);
  expect(nearest).toHaveLength(DUST_MAX_SOURCES);
  expect(nearest).toHaveLength(6);

  const bearing = flightBearingDeg(210);
  const trail = dustTrail({
    x: 200,
    y: 400,
    windDirectionFrom: 210,
    rand: seededRandom(42),
    timeSec: 0,
  });
  expect(trail.points.length).toBeGreaterThanOrEqual(12);
  expect(trail.points.length).toBeLessThanOrEqual(20);
  for (const point of trail.points) {
    expect(point.alpha).toBeGreaterThanOrEqual(DUST_ALPHA_MIN - 0.001);
    expect(point.alpha).toBeLessThanOrEqual(DUST_ALPHA_MAX + 0.001);
  }
  const { dx, dy } = dustCentroid(trail, 200, 400);
  expect(angleDiff(screenAngle(dx, dy), bearing)).toBeLessThanOrEqual(10);
  expect(DUST_COLORS.light).toBe("#ff6b52");
  expect(DUST_COLORS.dark).toBe("#e8604a");
});

test.describe("Атмосфера: поток частиц на карте", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("на 390×844 есть канвас с частицами, стрелок нет, клики не перехвачены", async ({
    page,
  }) => {
    const canvas = await openAtmosphere(page, { code: 0, wind: 6 });

    expect(await canvas.getAttribute("data-atmosphere-particles")).not.toBeNull();
    expect(await canvas.getAttribute("data-atmosphere-sky")).toBe("clear");

    const streams = Number(
      await canvas.getAttribute("data-atmosphere-streams"),
    );
    expect(streams).toBeGreaterThanOrEqual(2);
    expect(streams).toBeLessThanOrEqual(4);
    expect(
      Number(await canvas.getAttribute("data-atmosphere-bearing")),
    ).toBeCloseTo(30, 5);

    // Symbol-слоёв стрелок больше нет в стиле карты (ветер и пыль).
    const hasMap = await page.evaluate(() =>
      Boolean((window as unknown as { __map?: unknown }).__map),
    );
    if (hasMap) {
      type StyleMap = {
        getStyle?: () => { layers?: { id: string }[] } | undefined;
      };
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const map = (window as unknown as { __map?: StyleMap }).__map;
              return (map?.getStyle?.()?.layers ?? []).length;
            }),
          { timeout: 20_000, message: "стиль карты загружен" },
        )
        .toBeGreaterThan(0);
      const layerIds = await page.evaluate(() => {
        const map = (window as unknown as { __map?: StyleMap }).__map;
        return (map?.getStyle?.()?.layers ?? []).map((layer) => layer.id);
      });
      expect(layerIds).not.toContain("weather-wind-arrows");
      expect(layerIds).not.toContain("shadows-dust-arrows");
    }

    // Канвас не перехватывает клики: под точкой чипа — сам чип.
    await expect(page.locator(".bg-splash")).toHaveCount(0);
    const chip = page
      .locator("label")
      .filter({ hasText: "Погода и ветер" })
      .first();
    await expect(chip).toBeVisible();
    const box = await chip.boundingBox();
    expect(box).not.toBeNull();
    const hit = await page.evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        const overlay = document.querySelector('[data-atmosphere="1"]');
        return {
          inChip: Boolean(element?.closest("label")),
          isAtmosphere: Boolean(element?.closest('[data-atmosphere="1"]')),
          pointerEvents: overlay
            ? getComputedStyle(overlay).pointerEvents
            : null,
        };
      },
      {
        x: (box?.x ?? 0) + (box?.width ?? 0) / 2,
        y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
      },
    );
    expect(hit.pointerEvents).toBe("none");
    expect(hit.isAtmosphere).toBe(false);
    expect(hit.inChip).toBe(true);
  });

  test("дождь: ≥250 частиц, штрих по ветру, струи гаснут до 0,3", async ({
    page,
  }) => {
    const canvas = await openAtmosphere(page, {
      code: 61,
      temperature: 3.2,
      wind: 3,
    });
    await expect(canvas).toHaveAttribute("data-atmosphere-sky", "rain");
    expect(
      Number(await canvas.getAttribute("data-atmosphere-precip")),
    ).toBeGreaterThanOrEqual(250);
    expect(
      Number(await canvas.getAttribute("data-atmosphere-rain-speed")),
    ).toBeGreaterThanOrEqual(380);
    expect(
      Number(await canvas.getAttribute("data-atmosphere-rain-bearing")),
    ).toBeCloseTo(
      Number(await canvas.getAttribute("data-atmosphere-bearing")),
      0,
    );
    await page.waitForTimeout(600);
    expect(
      Number(await canvas.getAttribute("data-atmosphere-stream-opacity")),
    ).toBeLessThanOrEqual(0.3);
  });

  test("снег: ≥400 частиц, падение ≤110 px/с", async ({ page }) => {
    const canvas = await openAtmosphere(page, {
      code: 71,
      temperature: -3,
      wind: 3,
    });
    await expect(canvas).toHaveAttribute("data-atmosphere-sky", "snow");
    expect(
      Number(await canvas.getAttribute("data-atmosphere-precip")),
    ).toBeGreaterThanOrEqual(400);
    expect(
      Number(await canvas.getAttribute("data-atmosphere-snow-speed")),
    ).toBeLessThanOrEqual(110);
  });

  test("туман: осадков 0, 6–9 клочьев, альфа ≤0,40, струи гаснут", async ({
    page,
  }) => {
    const canvas = await openAtmosphere(page, { code: 45, wind: 3 });
    await expect(canvas).toHaveAttribute("data-atmosphere-sky", "fog");
    expect(Number(await canvas.getAttribute("data-atmosphere-precip"))).toBe(0);
    const puffs = Number(
      await canvas.getAttribute("data-atmosphere-fog-puffs"),
    );
    expect(puffs).toBeGreaterThanOrEqual(6);
    expect(puffs).toBeLessThanOrEqual(9);
    expect(
      Number(await canvas.getAttribute("data-atmosphere-fog-alpha")),
    ).toBeLessThanOrEqual(0.4);
    await page.waitForTimeout(600);
    expect(
      Number(await canvas.getAttribute("data-atmosphere-stream-opacity")),
    ).toBe(0);
  });

  test("ясно: 0 осадков, струи на месте", async ({ page }) => {
    const canvas = await openAtmosphere(page, { code: 0, wind: 3 });
    await expect(canvas).toHaveAttribute("data-atmosphere-sky", "clear");
    expect(Number(await canvas.getAttribute("data-atmosphere-precip"))).toBe(0);
    expect(
      Number(await canvas.getAttribute("data-atmosphere-streams")),
    ).toBeGreaterThanOrEqual(2);
  });

  test("кадр: туман виден — MAD ≥5, яркость растёт ≤18/255", async ({
    page,
  }) => {
    const clear = await skyShot(page, { code: 0, precipitation: 0 });
    const fog = await skyShot(page, { code: 45, precipitation: 0 });
    const stats = await frameDiff(page, clear, fog);
    console.log(`MAD fog ${JSON.stringify(stats)}`);
    // Туман — видимость, а не засветка: кадр заметно отличается, но не белеет.
    expect(stats.mad).toBeGreaterThanOrEqual(5);
    expect(stats.meanSecondFull - stats.meanFirstFull).toBeLessThanOrEqual(18);
  });

  test("кадр: снег виден — MAD ≥4", async ({ page }) => {
    const clear = await skyShot(page, { code: 0, precipitation: 0 });
    const snow = await skyShot(page, {
      code: 71,
      temperature: -3,
      precipitation: 0.4,
    });
    const stats = await frameDiff(page, clear, snow);
    console.log(`MAD snow ${JSON.stringify(stats)}`);
    expect(stats.mad).toBeGreaterThanOrEqual(4);
  });

  test("кадр: дождь виден — MAD ≥6", async ({ page }) => {
    const clear = await skyShot(page, { code: 0, precipitation: 0 });
    const rain = await skyShot(page, { code: 61, precipitation: 0.4 });
    const stats = await frameDiff(page, clear, rain);
    console.log(`MAD rain ${JSON.stringify(stats)}`);
    expect(stats.mad).toBeGreaterThanOrEqual(6);
  });

  test("чип «Погода и ветер» выключает поток частиц вместе с плашкой", async ({
    page,
  }) => {
    await mockWeather(page, { code: 0 });
    await page.goto("./");

    const canvas = page.locator('[data-atmosphere="1"]');
    const pill = page.locator("[data-weather-pill]");
    await expect(canvas).toBeVisible();
    await expect(pill).toBeVisible();

    const toggle = () =>
      page.evaluate(() => {
        const label = [...document.querySelectorAll("label")].find((element) =>
          element.textContent?.includes("Погода и ветер"),
        );
        const input = label?.querySelector("input");
        if (!input) throw new Error("чип «Погода и ветер» не найден");
        input.click();
      });

    await toggle();
    await expect(canvas).toHaveCount(0);
    await expect(pill).toHaveCount(0);

    await toggle();
    await expect(canvas).toBeVisible();
    await expect(pill).toBeVisible();
  });

  test("без данных погоды частиц нет (S9)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route(API, (route) => route.abort("internetdisconnected"));
    await page.goto("./");

    await expect(page.locator("[data-weather-pill]")).toHaveAttribute(
      "data-weather-status",
      "error",
    );
    await expect(page.locator('[data-atmosphere="1"]')).toHaveCount(0);
  });

  test("prefers-reduced-motion: статичный кадр без анимации", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const canvas = await openAtmosphere(page, { code: 0 });
    await expect(canvas).toHaveAttribute("data-atmosphere-motion", "static");
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Number(
              document
                .querySelector('[data-atmosphere="1"]')
                ?.getAttribute("data-atmosphere-particles") ?? 0,
            ),
          ),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    const checksum = () =>
      page.evaluate(() => {
        const element = document.querySelector<HTMLCanvasElement>(
          '[data-atmosphere="1"]',
        );
        const context = element?.getContext("2d");
        if (!element || !context) return -1;
        const pixels = context.getImageData(
          0,
          0,
          element.width,
          element.height,
        ).data;
        let sum = 0;
        for (let index = 0; index < pixels.length; index += 97) {
          sum = (sum + pixels[index]) % 1_000_000_007;
        }
        return sum;
      });
    const first = await checksum();
    expect(first).toBeGreaterThan(0);
    await page.waitForTimeout(800);
    expect(await checksum()).toBe(first);
  });
});
