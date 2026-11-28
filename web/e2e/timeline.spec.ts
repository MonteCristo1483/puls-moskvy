import { test, expect, type Browser, type Page } from "@playwright/test";
import { moscowInstantAt, sunPosition } from "../app/solar";

// S4: таймлайн «Сейчас / Было / Будет» и состояние в URL (`?t=HH:MM`).
//
// Погода мокается на уровне сети: тест не зависит от api.open-meteo.com и
// от текущей даты. Часовой ряд — как отдаёт Open-Meteo с
// `past_days=1&forecast_days=1`: вчера + сегодня по московскому времени.
// На 08:00 и 14:00 значения заведомо разные, поэтому по плашке и стрелкам
// видно, на какой час считали.
const API = "https://api.open-meteo.com/**";
const YESTERDAY = "2026-11-26";
const TODAY = "2026-11-27";
/** Опорный момент снимка: «Данные на 11:00» — так работает живой режим. */
const CURRENT = {
  time: `${TODAY}T11:00`,
  temperature_2m: 3.2,
  wind_speed_10m: 4.1,
  wind_direction_10m: 210,
  precipitation: 0.4,
};
/** Явные значения выбранных часов — их же ждём в плашке и стрелках. */
const HOUR_OVERRIDES: Record<string, { t: number; wind: number; dir: number }> =
  {
    [`${TODAY}T08:00`]: { t: 7.3, wind: 7.3, dir: 90 },
    [`${TODAY}T14:00`]: { t: 2.2, wind: 2.2, dir: 20 },
  };

function mockPayload() {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const wind_speed_10m: number[] = [];
  const wind_direction_10m: number[] = [];
  const precipitation: number[] = [];
  for (const day of [YESTERDAY, TODAY]) {
    for (let hour = 0; hour < 24; hour += 1) {
      const stamp = `${day}T${String(hour).padStart(2, "0")}:00`;
      const override = HOUR_OVERRIDES[stamp];
      time.push(stamp);
      temperature_2m.push(override ? override.t : hour / 2);
      wind_speed_10m.push(override ? override.wind : 1);
      wind_direction_10m.push(override ? override.dir : 0);
      precipitation.push(0);
    }
  }
  return {
    latitude: 55.7558,
    longitude: 37.6173,
    timezone: "Europe/Moscow",
    current: CURRENT,
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
  await page.route(API, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockPayload()),
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

/** Московские минуты от полуночи — по часам браузера, а не тестовой машины. */
function browserMoscowMinutes(page: Page) {
  return page.evaluate(() =>
    Math.floor(((Date.now() + 180 * 60 * 1000) % 86_400_000) / 60_000),
  );
}

const clockOf = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
    minutes % 60,
  ).padStart(2, "0")}`;

type MapHandle = {
  getCenter: () => { lng: number; lat: number };
};

/**
 * Показания ветра для проверки «выбранный час доехал до карты»: поток частиц
 * отдаёт силу и азимут полёта в data-атрибутах канваса, карта — центр (для
 * сверки солнца). Проверка смысла прежняя, но стрелок-символов больше нет:
 * канвас живёт независимо от готовности стиля карты.
 */
function mapHandle(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-atmosphere="1"]');
    const map = (window as unknown as { __map?: unknown }).__map;
    if (!canvas || !map || typeof (map as MapHandle).getCenter !== "function") {
      return null;
    }
    const rotate = Number(canvas.getAttribute("data-atmosphere-bearing"));
    const speed = Number(canvas.getAttribute("data-atmosphere-wind"));
    if (!Number.isFinite(rotate) || !Number.isFinite(speed)) return null;
    const center = (map as MapHandle).getCenter();
    return {
      rotate,
      speed,
      center: [center.lng, center.lat] as [number, number],
    };
  });
}

/** Классификация запросов страницы для проверки «0 запросов за состоянием». */
type SeenRequest = { url: string; method: string; type: string };

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
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`нет геометрии у ${selector}`);
  return box;
}

const STATIC_ASSET =
  /\.(?:html|js|mjs|css|map|png|jpe?g|svg|webp|ico|json(?:\.gz)?|pmtiles|webmanifest|txt|woff2?|wasm)(?:\?|$)/i;

function isStaticAsset(url: string): boolean {
  const pathname = new URL(url).pathname;
  // Корень сайта и статические файлы — это доставка приложения, не состояние.
  return pathname.endsWith("/") || STATIC_ASSET.test(pathname);
}

test("Таймлайн: ?t=08:00 переносится в чистый контекст и переживает reload", async ({
  browser,
}: {
  browser: Browser;
}) => {
  // Новый контекст = другое устройство: ни localStorage, ни кэша, ни истории.
  const context = await browser.newContext();
  const page = await context.newPage();
  await mockWeather(page);

  await page.goto("./?t=08:00");

  // В хранилище нет никакого «времени»: состояние пришло только из URL.
  const keys = await page.evaluate(() => Object.keys(window.localStorage));
  expect(keys.filter((key) => /time|clock|^t$/i.test(key))).toEqual([]);

  const timeline = page.locator("[data-timeline]");
  await expect(timeline).toBeVisible();
  await expect(timeline).toHaveAttribute("data-timeline-mode", "fixed");
  await expect(timeline).toHaveAttribute("data-timeline-value", "08:00");
  await expect(timeline).toContainText("08:00");

  const slider = page.locator("[data-timeline-slider]");
  await expect(slider).toHaveAttribute("aria-valuetext", "08:00");
  await expect(slider).toHaveAttribute("aria-valuenow", "480");

  // Плашка погоды — значения выбранного часа и честный признак «факт/прогноз».
  const pill = page.locator("[data-weather-pill]");
  await expect(pill).toHaveAttribute("data-weather-status", "ok");
  await expect(pill).toHaveAttribute("data-weather-time", `${TODAY}T08:00`);
  await expect(pill).toHaveAttribute("data-weather-temp", "7.30");
  await expect(pill).toHaveAttribute("data-weather-wind", "7.30");
  await expect(pill).toContainText("Данные на 08:00 · Open-Meteo");
  const nowMinutes = await browserMoscowMinutes(page);
  await expect(pill).toHaveAttribute(
    "data-weather-kind",
    480 <= nowMinutes ? "факт" : "прогноз",
  );

  // Тени на 08:00: таймлайн не включает слой сам, но включённый считает по
  // выбранному часу (положение солнца сверяем с solar.ts).
  const shadowsChip = page.getByRole("checkbox", { name: "Тени и пыль" });
  await expect(shadowsChip).not.toBeChecked();
  await expect(page.locator("[data-shadows-pill]")).toHaveCount(0);
  await toggleShadows(page);
  const shadowsPill = page.locator("[data-shadows-pill]");
  await expect(shadowsPill).toBeVisible();
  await expect(shadowsPill).toHaveAttribute("data-shadows-time", "08:00");

  const arrows = await (async () => {
    const hasMap = await page.evaluate(() =>
      Boolean((window as unknown as { __map?: unknown }).__map),
    );
    if (!hasMap) return null;
    await expect
      .poll(() => mapHandle(page), { timeout: 20_000 })
      .not.toBeNull();
    return mapHandle(page);
  })();
  if (arrows) {
    // Стрелки ветра — с выбранного часа: 90° «откуда» → остриё на 270°.
    expect(arrows.rotate).toBeCloseTo(270, 5);
    expect(arrows.speed).toBeCloseTo(7.3, 5);
    const expected = sunPosition(
      moscowInstantAt(480, Date.now()),
      arrows.center[1],
      arrows.center[0],
    );
    const altitude = await shadowsPill.getAttribute(
      "data-shadows-sun-altitude",
    );
    if (altitude !== null) {
      expect(Number(altitude)).toBeCloseTo(expected.altitudeDeg, 0);
    }
  } else {
    test.info().annotations.push({
      type: "skip-reason",
      description: "Нет WebGL/данных карты — проверены только плашка и шкала",
    });
  }

  // Перезагрузка не теряет состояние: оно в URL, а не в памяти.
  await page.reload();
  await expect(page.locator("[data-timeline]")).toHaveAttribute(
    "data-timeline-value",
    "08:00",
  );
  await expect(page.locator("[data-weather-pill]")).toContainText(
    "Данные на 08:00 · Open-Meteo",
  );

  await context.close();
});

test("Таймлайн: клик по шкале меняет URL на ?t=14:00, reload сохраняет его", async ({
  page,
}) => {
  await mockWeather(page);
  await page.goto("./");

  const timeline = page.locator("[data-timeline]");
  await expect(timeline).toHaveAttribute("data-timeline-mode", "live");
  expect(page.url()).not.toContain("t=");

  const slider = page.locator("[data-timeline-slider]");
  const box = await slider.boundingBox();
  if (!box) throw new Error("шкала таймлайна не отрисована");

  // Метка «14» стоит на 14/24 ширины: клик по ней — это и есть 14:00.
  await page.evaluate(() => {
    (window as unknown as { __s4NoReload?: boolean }).__s4NoReload = true;
  });
  await slider.click({
    position: { x: (box.width * 14) / 24, y: box.height / 2 },
  });

  await expect(timeline).toHaveAttribute("data-timeline-mode", "fixed");
  await expect(timeline).toHaveAttribute("data-timeline-value", "14:00");
  await expect(slider).toHaveAttribute("aria-valuetext", "14:00");
  expect(page.url()).toContain("?t=14:00");
  // replaceState, а не переход: страница не перезагружалась.
  expect(
    await page.evaluate(
      () => (window as unknown as { __s4NoReload?: boolean }).__s4NoReload,
    ),
  ).toBe(true);

  const pill = page.locator("[data-weather-pill]");
  await expect(pill).toHaveAttribute("data-weather-time", `${TODAY}T14:00`);
  await expect(pill).toHaveAttribute("data-weather-temp", "2.20");
  await expect(pill).toContainText("Данные на 14:00 · Open-Meteo");

  await page.reload();
  await expect(page.locator("[data-timeline]")).toHaveAttribute(
    "data-timeline-value",
    "14:00",
  );
  await expect(page.locator("[data-weather-pill]")).toContainText(
    "Данные на 14:00 · Open-Meteo",
  );
  expect(page.url()).toContain("?t=14:00");

  // «Сейчас» возвращает живой режим и убирает параметр из URL.
  await page.getByRole("button", { name: "Сейчас" }).click();
  await expect(page.locator("[data-timeline]")).toHaveAttribute(
    "data-timeline-mode",
    "live",
  );
  expect(page.url()).not.toContain("t=");
  await expect(page.locator("[data-weather-pill]")).toContainText(
    "Данные на 11:00 · Open-Meteo",
  );
});

test("Таймлайн: 0 серверных запросов за состоянием, погода и часы — один запрос", async ({
  page,
}) => {
  const seen: SeenRequest[] = [];
  page.on("request", (request) =>
    seen.push({
      url: request.url(),
      method: request.method(),
      type: request.resourceType(),
    }),
  );
  await mockWeather(page);

  const weatherSeen = () =>
    seen.filter((item) => item.url.startsWith("https://api.open-meteo.com/"));

  await page.goto("./?t=08:00");
  const pill = page.locator("[data-weather-pill]");
  await expect(pill).toHaveAttribute("data-weather-status", "ok");

  // Карта появляется позже первого рендера и уточняет центр камеры — без
  // этой паузы счётчик ловил бы второй (штатный) запрос S2 посреди теста.
  await page.waitForFunction(
    () => Boolean((window as unknown as { __map?: unknown }).__map),
    null,
    { timeout: 20_000 },
  );
  await expect.poll(() => weatherSeen().length, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(700);
  const baseline = weatherSeen().length;

  const origin = new URL(page.url()).origin;
  const weatherRequests = weatherSeen();
  // «Сейчас» и часовой ряд — всегда в одном ответе: нет отдельного запроса
  // за часами. И на каждую пару координат — ровно один запрос (кэш).
  for (const request of weatherRequests) {
    expect(request.url).toContain("current=");
    expect(request.url).toContain("hourly=");
    expect(request.url).toContain("past_days=1");
    expect(request.url).toContain("forecast_days=1");
  }
  const perCoordinate: Record<string, number> = {};
  for (const request of weatherRequests) {
    const url = new URL(request.url);
    const key = `${url.searchParams.get("latitude")},${url.searchParams.get("longitude")}`;
    perCoordinate[key] = (perCoordinate[key] ?? 0) + 1;
  }
  expect(Object.values(perCoordinate).every((count) => count === 1)).toBe(true);

  // Смена часа — только через history.replaceState: ни одного нового запроса.
  const slider = page.locator("[data-timeline-slider]");
  const box = await slider.boundingBox();
  if (!box) throw new Error("шкала таймлайна не отрисована");
  await slider.click({
    position: { x: (box.width * 9) / 24, y: box.height / 2 },
  });
  await expect(page.locator("[data-timeline]")).toHaveAttribute(
    "data-timeline-value",
    "09:00",
  );
  await expect(pill).toContainText("Данные на 09:00 · Open-Meteo");
  expect(weatherSeen().length).toBe(baseline);

  // Состояние приходит из URL и после reload: сервер о нём не спрашивают.
  await page.reload();
  await expect(page.locator("[data-timeline]")).toHaveAttribute(
    "data-timeline-value",
    "09:00",
  );

  const sameOrigin = seen.filter((item) => new URL(item.url).origin === origin);
  const documents = sameOrigin.filter((item) => item.type === "document");
  const assets = sameOrigin.filter(
    (item) => item.type !== "document" && isStaticAsset(item.url),
  );
  const suspicious = sameOrigin.filter(
    (item) => item.type !== "document" && !isStaticAsset(item.url),
  );
  const external = seen.filter(
    (item) =>
      new URL(item.url).origin !== origin &&
      !item.url.startsWith("https://api.open-meteo.com/"),
  );

  console.log(
    `S4 запросы страницы: всего ${seen.length}, к open-meteo ${weatherSeen().length} ` +
      `(${weatherRequests.length} на первый показ, по 1 на координаты), ` +
      `к своему origin ${sameOrigin.length} (документ ${documents.length}, статика ${assets.length}), ` +
      `внешних ${external.length}`,
  );

  // Никаких обращений к своему origin за состоянием: только документ и
  // статические ассеты (JS/CSS/PMTiles/данные). GET/HEAD — доставка файлов
  // (HEAD — замер размера PMTiles), ни одного POST/PUT за состоянием.
  expect(suspicious).toEqual([]);
  expect(
    sameOrigin.filter((item) => item.method !== "GET" && item.method !== "HEAD"),
  ).toEqual([]);
  expect(
    sameOrigin.filter(
      (item) => item.type !== "document" && /[?&]t=/.test(new URL(item.url).search),
    ),
  ).toEqual([]);
});

test("Таймлайн: клавиши ←/→ меняют час, Home/End — края суток", async ({
  page,
}) => {
  await mockWeather(page);
  await page.goto("./?t=14:00");

  const slider = page.locator("[data-timeline-slider]");
  await slider.focus();

  await slider.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "15:00");
  await expect(slider).toHaveAttribute("aria-valuenow", "900");
  expect(page.url()).toContain("?t=15:00");

  await slider.press("ArrowLeft");
  await slider.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", "13:00");
  expect(page.url()).toContain("?t=13:00");

  await slider.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", "00:00");
  expect(page.url()).toContain("?t=00:00");

  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", "23:00");
  expect(page.url()).toContain("?t=23:00");
});

test("Таймлайн: прошедший час помечен «факт», будущий — «прогноз»", async ({
  page,
}) => {
  await mockWeather(page);
  const pill = page.locator("[data-weather-pill]");

  const nowMinutes = await (async () => {
    await page.goto("./?t=12:00");
    await expect(pill).toHaveAttribute("data-weather-status", "ok");
    return browserMoscowMinutes(page);
  })();
  const nowHour = Math.floor(nowMinutes / 60);
  const pastHour = Math.max(0, nowHour - 1);
  const futureHour = nowHour + 2 <= 23 ? nowHour + 2 : null;

  // Час назад — всегда факт (или текущий час, если сутки только начались).
  await page.goto(`./?t=${clockOf(pastHour * 60)}`);
  await expect(pill).toHaveAttribute("data-weather-kind", "факт");

  if (futureHour !== null) {
    await page.goto(`./?t=${clockOf(futureHour * 60)}`);
    await expect(pill).toHaveAttribute("data-weather-kind", "прогноз");
  } else {
    test.info().annotations.push({
      type: "skip-reason",
      description: "Позже 23:00 будущих часов в сегодняшних сутках нет",
    });
  }
});

test("Таймлайн: на телефоне и десктопе не перекрывает плашки и подпись OSM", async ({
  page,
}) => {
  await mockWeather(page);

  const check = async (label: string) => {
    const timeline = await boxOf(page, "[data-timeline]");
    const weather = await boxOf(page, "[data-weather-pill]");
    const shadows = await boxOf(page, "[data-shadows-pill]");
    expect(overlaps(timeline, weather), `${label}: плашка погоды`).toBe(false);
    expect(overlaps(timeline, shadows), `${label}: плашка теней`).toBe(false);
    // Атрибуция ODbL должна оставаться читаемой (S10): таймлайн выше неё.
    const footer = await page
      .getByText("© OpenStreetMap contributors", { exact: false })
      .first()
      .boundingBox();
    if (footer) expect(overlaps(timeline, footer), `${label}: подпись OSM`).toBe(false);
  };

  // Телефон: таймлайн стоит над стопкой плашек (погода + тени).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./?t=08:00");
  await toggleShadows(page);
  await expect(page.locator("[data-shadows-pill]")).toBeVisible();
  await check("390×844");

  // Десктоп: по центру внизу, между левыми плашками и подписью справа.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  await check("1280×800");
});
