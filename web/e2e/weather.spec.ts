import { test, expect, type Page } from "@playwright/test";

// Слой «Погода и ветер» (S2): данные в тестах мокаются на уровне сети, чтобы
// проверка не зависела от доступности api.open-meteo.com в CI.
const API = "https://api.open-meteo.com/**";

const MOCK_WEATHER = {
  latitude: 55.7558,
  longitude: 37.6173,
  timezone: "Europe/Moscow",
  current: {
    time: "2026-11-27T11:00",
    temperature_2m: 3.2,
    wind_speed_10m: 4.1,
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

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

test("Погода: плашка показывает данные Open-Meteo, время и лицензию", async ({
  page,
}) => {
  await mockWeather(page);
  const pageErrors = collectPageErrors(page);

  await page.goto("./");
  const pill = page.locator("[data-weather-pill]");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("data-weather-status", "ok");
  await expect(pill).toContainText("+3,2 °C");
  await expect(pill).toContainText("ветер 4,1 м/с");
  await expect(pill).toContainText("0,4 мм");
  await expect(pill).toContainText("Данные на 11:00 · Open-Meteo");
  // Атрибуция CC BY 4.0 видна на карте (title плашки), а не только в футере.
  await expect(pill).toHaveAttribute("title", /CC BY 4\.0/);

  // Ветер на карте — поток частиц на canvas, а не symbol-слой стрелок.
  // Проверяем, что канвас появился и в нём есть живые точки, а слоя
  // `weather-wind-arrows` больше нет в стиле карты.
  const atmosphere = page.locator('[data-atmosphere="1"]');
  await expect(atmosphere).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const canvas = document.querySelector('[data-atmosphere="1"]');
          return Number(
            canvas?.getAttribute("data-atmosphere-particles") ?? 0,
          );
        }),
      { timeout: 20_000, message: "частицы ветра появились в кадре" },
    )
    .toBeGreaterThan(0);

  // Без WebGL/данных карты нет стиля; тогда проверяем только канвас.
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
  }

  expect(pageErrors).toEqual([]);
});

test("Погода: без сети плашка остаётся, помечает состояние и не роняет карту", async ({
  page,
}) => {
  await page.route(API, (route) => route.abort("internetdisconnected"));
  const pageErrors = collectPageErrors(page);

  await page.goto("./");
  const pill = page.locator("[data-weather-pill]");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("data-weather-status", "error");
  await expect(pill).toContainText("нет сети");
  await expect(page.getByText("Не удалось загрузить данные карты")).toHaveCount(
    0,
  );
  expect(pageErrors).toEqual([]);
});

test("Погода: чип «Погода и ветер» скрывает и возвращает плашку", async ({
  page,
}) => {
  await mockWeather(page);
  await page.goto("./");

  const pill = page.locator("[data-weather-pill]");
  const chip = page.getByRole("checkbox", { name: "Погода и ветер" });
  await expect(pill).toBeVisible();
  await expect(chip).toBeChecked();

  // Активируем чекбокс из DOM: без городских данных карта не инициализируется
  // и заставка остаётся поверх UI — обычный клик не проходит hit-test.
  const toggle = () =>
    page.evaluate(() => {
      const label = [...document.querySelectorAll("label")].find((el) =>
        el.textContent?.includes("Погода и ветер"),
      );
      const input = label?.querySelector("input");
      if (!input) throw new Error("чип «Погода и ветер» не найден");
      input.click();
    });

  await toggle();
  await expect(chip).not.toBeChecked();
  await expect(pill).toHaveCount(0);

  await toggle();
  await expect(chip).toBeChecked();
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("data-weather-status", "ok");
});
