import { test, expect, type Page } from "@playwright/test";
import {
  ATMOSPHERE_PALETTE,
  WIND_COLOR,
  flightBearingDeg,
  streamCount,
  streamSpeedPx,
} from "../app/atmosphere/wind";

// Слой «Поток ветра» (замена стрелок): чистые числа ветра + UI-проверка
// канваса. Погода мокается на уровне сети — как в weather.spec.ts, чтобы
// проверка не зависела от api.open-meteo.com.
const API = "https://api.open-meteo.com/**";

const MOCK_WEATHER = {
  latitude: 55.7558,
  longitude: 37.6173,
  timezone: "Europe/Moscow",
  current: {
    time: "2026-11-27T11:00",
    temperature_2m: 3.2,
    wind_speed_10m: 6,
    wind_direction_10m: 210,
    precipitation: 0.4,
  },
};

async function mockWeather(page: Page) {
  await page.route(API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_WEATHER),
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

test("Атмосфера: скорость потока 12 + 7.5·v, азимут полёта обратен метео", () => {
  // Числа из задачи: штиль — медленный дрейф, 10 м/с — 87 px/с.
  expect(streamSpeedPx(0)).toBeCloseTo(12, 6);
  expect(streamSpeedPx(5)).toBeCloseTo(49.5, 6);
  expect(streamSpeedPx(10)).toBeCloseTo(87, 6);
  // Ветер «откуда» 210° → полёт на 30°; границы и отрицательные значения.
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
    const count = streamCount(windMs);
    expect(count).toBeGreaterThanOrEqual(2);
    // Больше четырёх струй не бывает ни при каком ветре.
    expect(count).toBeLessThanOrEqual(4);
  }
});

test("Атмосфера: палитра — лазурная днём, холоднее и приглушённее ночью", () => {
  const day = ATMOSPHERE_PALETTE.light;
  const night = ATMOSPHERE_PALETTE.dark;
  expect(day.wind.toLowerCase()).toBe(WIND_COLOR);
  expect(WIND_COLOR).toBe("#7fd3ff");
  // Ночь — тот же тон, но тёмнее (приглушённее) и с синим вперёд.
  expect(night.wind.toLowerCase()).not.toBe(day.wind.toLowerCase());
  expect(luminance(night.wind)).toBeLessThan(luminance(day.wind));
  for (const color of [day.wind, night.wind]) {
    const { r, g, b } = hexToRgb(color);
    expect(b).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(r);
  }
});

test.describe("Атмосфера: поток частиц на карте", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("на 390×844 есть канвас с частицами, стрелок нет, клики не перехвачены", async ({
    page,
  }) => {
    await mockWeather(page);
    await page.goto("./");

    const canvas = page.locator('[data-atmosphere="1"]');
    await expect(canvas).toBeVisible();

    // Частицы появляются вместе с погодой: канвас без точек — не поток.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const element = document.querySelector('[data-atmosphere="1"]');
            return Number(
              element?.getAttribute("data-atmosphere-particles") ?? 0,
            );
          }),
        { timeout: 20_000, message: "частицы ветра появились в кадре" },
      )
      .toBeGreaterThan(0);

    // Струй 2–4 (число зависит от силы ветра, больше четырёх не бывает).
    const streams = Number(
      await canvas.getAttribute("data-atmosphere-streams"),
    );
    expect(streams).toBeGreaterThanOrEqual(2);
    expect(streams).toBeLessThanOrEqual(4);
    // Направление полёта — обратное метео 210°.
    expect(
      Number(await canvas.getAttribute("data-atmosphere-bearing")),
    ).toBeCloseTo(30, 5);

    // Symbol-слоя стрелок больше нет в стиле карты. Без WebGL/данных карты
    // стиля нет — тогда проверяем только канвас (как weather.spec.ts).
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
      test.info().annotations.push({
        type: "layers",
        description: `слоёв в стиле: ${layerIds.length}`,
      });
    } else {
      test.info().annotations.push({
        type: "skip-reason",
        description: "Нет WebGL/данных карты — проверен только канвас",
      });
    }

    // Канвас не перехватывает клики: под точкой чипа «Погода и ветер» — сам
    // чип, а не частицы (иначе панель стала бы некликабельной).
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
      { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 },
    );
    expect(hit.pointerEvents).toBe("none");
    expect(hit.isAtmosphere).toBe(false);
    expect(hit.inChip).toBe(true);
  });

  test("чип «Погода и ветер» выключает поток частиц вместе с плашкой", async ({
    page,
  }) => {
    await mockWeather(page);
    await page.goto("./");

    const canvas = page.locator('[data-atmosphere="1"]');
    const pill = page.locator("[data-weather-pill]");
    await expect(canvas).toBeVisible();
    await expect(pill).toBeVisible();

    // Активируем чекбокс из DOM: пока карта не готова, заставка перекрывает
    // хит-тест (тот же приём, что в weather.spec.ts).
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
    await page.route(API, (route) => route.abort("internetdisconnected"));
    await page.goto("./");

    // Плашка честно сообщает об ошибке, а поток остаётся пустым: рисовать
    // анимацию не по чему.
    await expect(page.locator("[data-weather-pill]")).toHaveAttribute(
      "data-weather-status",
      "error",
    );
    await expect(page.locator('[data-atmosphere="1"]')).toHaveCount(0);
  });
});
