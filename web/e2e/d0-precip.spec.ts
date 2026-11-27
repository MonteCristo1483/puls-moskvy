import { test, expect, type Page } from "@playwright/test";

// D0: два маленьких изменения от владельца.
//
// 1. Плашка «Тени на ЧЧ:ММ» уходит с первого экрана, но остаётся в DOM и
//    возвращается по `?shadows=1`. Прячем её только визуально (opacity: 0):
//    габариты и положение не меняются, поэтому замеры в timeline.spec.ts
//    (boxOf, toBeVisible, перекрытия) продолжают работать без правок.
// 2. В плашке погоды — прямой ответ «есть ли сейчас дождь/снег», а не только
//    «0,4 мм» или молчание.
//
// Погода мокается на уровне сети: тест не зависит от api.open-meteo.com.
const API = "https://api.open-meteo.com/**";

type WeatherState = { temperature: number; precipitation: number };

function payload(state: WeatherState) {
  return {
    latitude: 55.7558,
    longitude: 37.6173,
    timezone: "Europe/Moscow",
    current: {
      time: "2026-11-27T11:00",
      temperature_2m: state.temperature,
      wind_speed_10m: 3.1,
      wind_direction_10m: 210,
      precipitation: state.precipitation,
    },
  };
}

/** Мок отвечает текущим содержимым `state` — его можно менять между goto. */
async function mockWeather(page: Page, state: WeatherState) {
  await page.route(API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload(state)),
    }),
  );
}

const toggleShadows = (page: Page) =>
  page.evaluate(() => {
    const label = [...document.querySelectorAll("label")].find((el) =>
      el.textContent?.includes("Тени и пыль"),
    );
    const input = label?.querySelector("input");
    if (!input) throw new Error("чип «Тени и пыль» не найден");
    input.click();
  });

/** Computed-стиль и габариты плашки — то, что видит Playwright. */
function pillGeometry(page: Page, selector: string) {
  return page.evaluate((target) => {
    const el = document.querySelector(target) as HTMLElement | null;
    if (!el) return null;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      width: rect.width,
      height: rect.height,
    };
  }, selector);
}

test("D0: плашка теней по умолчанию скрыта, но остаётся в DOM прежнего размера", async ({
  page,
}) => {
  await mockWeather(page, { temperature: 3.2, precipitation: 0.4 });
  await page.goto("./?t=08:00");

  // Слой теней по умолчанию выключен — плашки нет вовсе (это поведение чипа
  // не меняется). Скрытие D0 — про включённый слой без `?shadows=1`.
  const pill = page.locator("[data-shadows-pill]");
  await expect(pill).toHaveCount(0);

  await toggleShadows(page);
  await expect(pill).toHaveCount(1);
  await expect(pill).toHaveAttribute("data-shadows-hidden", "1");
  await expect(pill).toHaveAttribute("aria-hidden", "true");

  const geometry = await pillGeometry(page, "[data-shadows-pill]");
  if (!geometry) throw new Error("плашка теней не отрисована");
  expect(geometry.opacity).toBe("0");
  expect(geometry.pointerEvents).toBe("none");
  // Ненулевые габариты: элемент не убран из разметки и потока — именно на
  // этом держатся замеры boxes в timeline.spec.ts.
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(0);

  // Измерительный прибор на месте: прежние data-атрибуты замера не потеряны.
  await expect(pill).toHaveAttribute("data-shadows-time", "08:00");
});

test("D0: ?shadows=1 возвращает плашку теней на экран", async ({ page }) => {
  await mockWeather(page, { temperature: 3.2, precipitation: 0.4 });
  await page.goto("./?shadows=1&t=08:00");
  await toggleShadows(page);

  const pill = page.locator("[data-shadows-pill]");
  await expect(pill).toHaveAttribute("data-shadows-hidden", "0");
  await expect(pill).not.toHaveAttribute("aria-hidden", "true");

  const geometry = await pillGeometry(page, "[data-shadows-pill]");
  if (!geometry) throw new Error("плашка теней не отрисована");
  expect(geometry.opacity).toBe("1");
  expect(geometry.width).toBeGreaterThan(0);

  await expect(pill).toHaveAttribute("data-shadows-time", "08:00");
  await expect(pill).toContainText("Тени на 08:00");
});

test("D0: погода без осадков так и говорит — «без осадков»", async ({ page }) => {
  await mockWeather(page, { temperature: -3.2, precipitation: 0 });
  await page.goto("./");

  const pill = page.locator("[data-weather-pill]");
  await expect(pill).toHaveAttribute("data-weather-status", "ok");
  await expect(pill).toHaveAttribute("data-weather-precip", "none");
  // Числа осадков нет — атрибут пуст, строки «0,0 мм» в плашке нет.
  await expect(pill).not.toHaveAttribute("data-weather-precip-mm", /.+/);
  await expect(pill).toContainText("−3,2 °C · ветер 3,1 м/с · без осадков");
  await expect(pill).not.toContainText("мм");
});

const PRECIP_CASES: { state: WeatherState; kind: string; line: string }[] = [
  {
    // ≥ +1 °C — дождь.
    state: { temperature: 3.2, precipitation: 0.4 },
    kind: "rain",
    line: "дождь 0,4 мм",
  },
  {
    // От −1 °C до +1 °C — мокрый снег.
    state: { temperature: 0.3, precipitation: 0.4 },
    kind: "sleet",
    line: "мокрый снег 0,4 мм",
  },
  {
    // Ниже −1 °C — снег.
    state: { temperature: -3.2, precipitation: 0.4 },
    kind: "snow",
    line: "снег 0,4 мм",
  },
];

test("D0: вид осадков в плашке погоды соответствует температуре модели", async ({
  page,
}) => {
  const state: WeatherState = { temperature: 3.2, precipitation: 0.4 };
  await mockWeather(page, state);
  await page.goto("./");

  const pill = page.locator("[data-weather-pill]");
  for (const item of PRECIP_CASES) {
    state.temperature = item.state.temperature;
    state.precipitation = item.state.precipitation;
    await page.goto("./");
    await expect(pill).toHaveAttribute("data-weather-status", "ok");
    await expect(pill).toHaveAttribute("data-weather-precip", item.kind);
    // Миллиметры — числом в атрибуте (одна цифра после запятой в тексте).
    expect(
      Number(await pill.getAttribute("data-weather-precip-mm")),
      `data-weather-precip-mm для ${item.kind}`,
    ).toBeCloseTo(item.state.precipitation, 2);
    await expect(pill).toContainText(item.line);
    await expect(pill).toContainText(" · ");
  }
});
