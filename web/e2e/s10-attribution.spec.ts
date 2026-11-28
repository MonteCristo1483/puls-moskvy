import { test, expect, type Page } from "@playwright/test";
import { mockFreshMeta, mskClock } from "./live-meta";

// S10: атрибуция и лицензии. Приёмка ROADMAP: «4 источника перечислены,
// ссылки открываются, ODbL-атрибуция видна на карте, а не только в футере».
//
// Здесь проверяется то, что видит человек, а не разметка:
//   • плашка «© OpenStreetMap» стоит на карте и открывает «О данных»;
//     футер-строка — вторая дверь в ту же панель;
//   • в панели ровно 4 источника, у каждого живая https-ссылка (target=_blank,
//     rel=noreferrer), лицензии ODbL и CC BY 4.0 и дата выгрузки из
//     `live/meta.json` (мок `live-meta.ts` — тест не зависит от календаря);
//   • панель закрывается крестиком и по Escape, фокус возвращается на плашку;
//   • на 390×844 плашка не пересекается с погодой и таймлайном, а футер-строка
//     не перекрыта погодой (прежний техдолг: «погода перекрывает подпись ODbL»).
//
// Погода мокается на уровне сети (как в timeline.spec.ts): геометрия плашки
// должна быть настоящей — из двух строк, а не из «Погода · загрузка…».

const WEATHER_API = "https://api.open-meteo.com/**";

/** Дата в МСК как `YYYY-MM-DD`; `offsetDays` — сдвиг от сегодня. */
function moscowDay(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

/** Ответ Open-Meteo в той же форме, что у слоя погоды: вчера + сегодня. */
function weatherPayload() {
  const today = moscowDay(0);
  const yesterday = moscowDay(-1);
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const wind_speed_10m: number[] = [];
  const wind_direction_10m: number[] = [];
  const precipitation: number[] = [];
  for (const day of [yesterday, today]) {
    for (let hour = 0; hour < 24; hour += 1) {
      time.push(`${day}T${String(hour).padStart(2, "0")}:00`);
      temperature_2m.push(hour / 2);
      wind_speed_10m.push(1);
      wind_direction_10m.push(0);
      precipitation.push(0);
    }
  }
  const nowHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Moscow",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date()),
  );
  return {
    latitude: 55.7558,
    longitude: 37.6173,
    timezone: "Europe/Moscow",
    current: {
      time: `${today}T${String(nowHour).padStart(2, "0")}:00`,
      temperature_2m: 3.2,
      wind_speed_10m: 4.1,
      wind_direction_10m: 210,
      precipitation: 0.4,
    },
    hourly: {
      time,
      temperature_2m,
      wind_speed_10m,
      wind_direction_10m,
      precipitation,
    },
  };
}

async function mockWeather(page: Page) {
  await page.route(WEATHER_API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(weatherPayload()),
    }),
  );
}

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`нет геометрии у ${selector}`);
  return box;
}

const PLATE = "[data-attribution-plate]";
const FOOTER = "[data-attribution-footer]";
const DIALOG = "[data-about-data]";

test("S10: плашка атрибуции на карте открывает «О данных»", async ({ page }) => {
  await mockWeather(page);
  await page.goto("./");

  const plate = page.locator(PLATE);
  await expect(plate).toBeVisible();
  await expect(plate).toContainText("OpenStreetMap");

  await plate.click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("О данных");
  // Фокус при открытии уходит в панель, а не остаётся на кнопке под оверлеем.
  await expect(dialog).toBeFocused();

  // Футер-строка — та же дверь, текст прежний.
  await page.keyboard.press("Escape");
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(FOOTER)).toContainText(
    "© OpenStreetMap contributors, ODbL",
  );
  await page.locator(FOOTER).click();
  await expect(page.locator(DIALOG)).toBeVisible();
});

test("S10: в панели 4 источника, https-ссылки, лицензии и дата выгрузки", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const generated = await mockFreshMeta(page);
  await mockWeather(page);
  await page.goto("./");

  await page.locator(PLATE).click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();

  const sources = dialog.locator("[data-about-source]");
  await expect(sources).toHaveCount(4);
  expect(
    await sources.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-about-source")),
    ),
  ).toEqual(["osm", "works", "permits", "open-meteo"]);

  // У каждого источника ровно одна ссылка: https, новая вкладка, без referrer.
  for (let index = 0; index < 4; index += 1) {
    const link = sources.nth(index).locator("a[data-about-link]");
    await expect(link).toHaveCount(1);
    const href = await link.getAttribute("href");
    expect(href, `ссылка источника №${index}`).toMatch(/^https:\/\//);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noreferrer");
  }

  const hrefs = await dialog
    .locator("a[data-about-link]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
  expect(new Set(hrefs).size).toBe(4);

  // Лицензии названы явно: ODbL у OpenStreetMap, CC BY 4.0 — у города и погоды.
  await expect(sources.nth(0)).toContainText("ODbL 1.0");
  await expect(dialog).toContainText("CC BY 4.0");
  await expect(dialog).toContainText("ODbL");
  await expect(dialog).toContainText("Open-Meteo");

  // Дата выгрузки — из общего снимка `live/meta.json`, а не второй загрузкой.
  await expect(dialog.locator("[data-about-date]")).toHaveAttribute(
    "data-about-date",
    mskClock(generated),
  );
  await expect(dialog.locator("[data-about-date]")).toContainText(
    mskClock(generated),
  );

  // Оговорка про расчёт по модели — одна строка.
  await expect(dialog).toContainText(
    "Погода и тени — расчёт по модели, а не замер",
  );
});

test("S10: панель закрывается крестиком и по Escape", async ({ page }) => {
  await mockWeather(page);
  await page.goto("./");

  const plate = page.locator(PLATE);
  await plate.click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();

  await page.getByRole("button", { name: "Закрыть" }).click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  // Фокус возвращается на кнопку, с которой открыли панель.
  await expect(plate).toBeFocused();

  await plate.click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(plate).toBeFocused();
});

test("S10: 390×844 — плашка, погода и таймлайн не пересекаются", async ({
  page,
}) => {
  await mockWeather(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");

  await expect(page.locator("[data-timeline]")).toBeVisible();
  await expect(page.locator("[data-weather-pill]")).toBeVisible();
  await expect(page.locator(PLATE)).toBeVisible();

  const plate = await boxOf(page, PLATE);
  const weather = await boxOf(page, "[data-weather-pill]");
  const timeline = await boxOf(page, "[data-timeline]");
  const footer = await boxOf(page, FOOTER);

  const boxes = { plate, weather, timeline, footer };
  const label = JSON.stringify(boxes);

  expect(overlaps(plate, weather), `плашка наезжает на погоду: ${label}`).toBe(
    false,
  );
  expect(
    overlaps(plate, timeline),
    `плашка наезжает на таймлайн: ${label}`,
  ).toBe(false);
  expect(
    overlaps(footer, weather),
    `погода перекрывает подпись ODbL: ${label}`,
  ).toBe(false);

  // Плашка целиком в экране: не свисает за край и не уезжает под таймлайн.
  expect(plate.x).toBeGreaterThanOrEqual(0);
  expect(plate.y).toBeGreaterThanOrEqual(0);
  expect(plate.x + plate.width).toBeLessThanOrEqual(390);
  expect(plate.y + plate.height).toBeLessThanOrEqual(844);

  // Клик по плашке не ломается раскладкой — панель открывается.
  await page.locator(PLATE).click();
  await expect(page.locator(DIALOG)).toBeVisible();
});
