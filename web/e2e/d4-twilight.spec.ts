import { test, expect, type Page } from "@playwright/test";
import {
  formatClock,
  moscowInstantAt,
  sunPosition,
  sunriseSunset,
} from "../app/solar";
import { mockFreshMeta } from "./live-meta";

// D4: сумеречные палитры. Проверяем не «как сделано», а то, что видит
// человек: фазу неба и высоту Солнца на <html>, силу света --sky-tint,
// подпись таймлайна с высотой, а также две страховки — слой сумерек не
// перехватывает клики по интерфейсу и уважает prefers-reduced-motion.
//
// Все времена вычисляются через solar.ts на сегодняшнюю дату — ту же, с
// которой работает страница. Ожидания темы выводятся из фактической высоты
// Солнца (порог 0° из D3), а не подгоняются под текущую реализацию.

// Центр Москвы и полуширина сумерек — те же числа, что в daylight.ts.
// Дублируем их здесь намеренно: тест обязан ловить расхождение с кодом,
// а не импортировать ожидание из проверяемого модуля.
const CENTER: [number, number] = [55.7558, 37.6173];
const TWILIGHT_DEG = 6;
/** Кривая силы света: `(1 − |h|/6)^0.55`, а не линейная (см. daylight.ts). */
const TWILIGHT_CURVE = 0.55;
const REFERENCE = new Date();

function altitudeAt(minutes: number): number {
  return sunPosition(moscowInstantAt(minutes, REFERENCE), CENTER[0], CENTER[1])
    .altitudeDeg;
}

/**
 * Первая минута суток, где высота Солнца пересекает `target` в нужную
 * сторону. Так времена кадров не зависят от даты: и восход, и закат, и
 * точки для проверки --sky-tint находятся по фактическому положению Солнца.
 */
function minutesAtAltitude(
  target: number,
  direction: "rising" | "falling",
): number {
  let previous = altitudeAt(0);
  for (let minutes = 1; minutes < 1440; minutes += 1) {
    const altitude = altitudeAt(minutes);
    const crossed =
      direction === "rising"
        ? previous < target && altitude >= target
        : previous > target && altitude <= target;
    if (crossed) return minutes;
    previous = altitude;
  }
  throw new Error(`нет пересечения высоты ${target}° (${direction})`);
}

const SUN_TIMES = sunriseSunset(REFERENCE, CENTER[0], CENTER[1]);
if (SUN_TIMES.polar !== "none") {
  throw new Error("D4: тест рассчитан на Москву без полярного дня");
}

// Рассвет — уже над горизонтом (+2°), закат — уже под ним (−2°): именно так
// видны обе сумеречные палитры, и тема на них по порогу 0° разная.
const DAWN = minutesAtAltitude(2, "rising");
const DUSK = minutesAtAltitude(-2, "falling");
const DAY = Math.round(SUN_TIMES.solarNoonMinutes);

const clock = (minutes: number) => formatClock(minutes);

/** «-2.1» — формат data-sun-altitude (одна цифра, минус ASCII). */
function altitudeAttr(altitudeDeg: number): string {
  return (Math.round(altitudeDeg * 10) / 10).toFixed(1);
}

/** Ожидаемая сила сумерек из высоты: 1 на 0°, 0 за пределами ±6°. */
function strengthFor(altitudeDeg: number): number {
  const distance = Math.abs(altitudeDeg);
  return distance >= TWILIGHT_DEG
    ? 0
    : Math.pow(1 - distance / TWILIGHT_DEG, TWILIGHT_CURVE);
}

async function readSkin(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const tint = getComputedStyle(root).getPropertyValue("--sky-tint").trim();
    return {
      sky: root.dataset.sky ?? null,
      theme: root.dataset.theme ?? null,
      altitude: root.dataset.sunAltitude ?? null,
      tint: tint === "" ? null : Number(tint),
    };
  });
}

test("D4: три времени — три фазы неба, а тема переключается по порогу 0°", async ({
  page,
}) => {
  // Физика кадра: рассвет — Солнце в полосе 0…+6°, закат — в полосе −6…0°.
  expect(altitudeAt(DAWN)).toBeGreaterThan(0);
  expect(altitudeAt(DAWN)).toBeLessThan(TWILIGHT_DEG);
  expect(altitudeAt(DUSK)).toBeLessThan(0);
  expect(altitudeAt(DUSK)).toBeGreaterThan(-TWILIGHT_DEG);
  expect(altitudeAt(DAY)).toBeGreaterThan(TWILIGHT_DEG);

  const cases = [
    { name: "рассвет", minutes: DAWN, phase: "dawn" },
    { name: "день", minutes: DAY, phase: "day" },
    { name: "закат", minutes: DUSK, phase: "dusk" },
  ];

  for (const item of cases) {
    const altitude = altitudeAt(item.minutes);
    await page.goto(`./?t=${clock(item.minutes)}`);

    const html = page.locator("html");
    await expect(html, `${item.name}: data-sky`).toHaveAttribute(
      "data-sky",
      item.phase,
    );
    // Тема — следствие высоты (D3): выше горизонта — светлая, на/под ним — тёмная.
    await expect(
      html,
      `${item.name} (${altitude.toFixed(2)}°): data-theme`,
    ).toHaveAttribute("data-theme", altitude > 0 ? "light" : "dark");
    await expect(
      html,
      `${item.name}: высота в data-sun-altitude`,
    ).toHaveAttribute("data-sun-altitude", altitudeAttr(altitude));
  }
});

test("D4: --sky-tint растёт к 0° и падает при удалении от него", async ({
  page,
}) => {
  // Пять точек: три подряд к горизонту (высота 4° → 2° → 0.5°) и две прочь
  // (0.5° → 3° → 5°). Одной точки для монотонности мало — проверяем шаги.
  const towardHorizon = [
    minutesAtAltitude(4, "rising"),
    minutesAtAltitude(2, "rising"),
    minutesAtAltitude(0.5, "rising"),
  ];
  const awayFromHorizon = [
    minutesAtAltitude(3, "rising"),
    minutesAtAltitude(5, "rising"),
  ];

  const strengths: number[] = [];
  let style: {
    transitionDuration: string;
    pointerEvents: string;
    position: string;
    zIndex: string;
  } | null = null;

  for (const minutes of [...towardHorizon, ...awayFromHorizon]) {
    const altitude = altitudeAt(minutes);
    const expected = strengthFor(altitude);
    await page.goto(`./?t=${clock(minutes)}`);

    const html = page.locator("html");
    // Ждём, пока эффект выставит силу: высота в разметке — тот же расчёт.
    await expect(html).toHaveAttribute("data-sun-altitude", altitudeAttr(altitude));

    const skin = await readSkin(page);
    expect(skin.tint, `${clock(minutes)} (${altitude.toFixed(2)}°)`).not.toBeNull();
    expect(
      skin.tint ?? -1,
      `${clock(minutes)} (${altitude.toFixed(2)}°): сила из высоты`,
    ).toBeCloseTo(expected, 2);
    strengths.push(skin.tint ?? -1);

    if (style === null) {
      style = await page.locator("[data-sky-layer]").evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          transitionDuration: computed.transitionDuration,
          pointerEvents: computed.pointerEvents,
          position: computed.position,
          zIndex: computed.zIndex,
        };
      });
    }
  }

  // Ближе к горизонту — сильнее: 4° < 2° < 0.5°.
  expect(strengths[0]).toBeLessThan(strengths[1]);
  expect(strengths[1]).toBeLessThan(strengths[2]);
  // Дальше от горизонта — слабее: 0.5° > 3° > 5°.
  expect(strengths[2]).toBeGreaterThan(strengths[3]);
  expect(strengths[3]).toBeGreaterThan(strengths[4]);
  // И это именно кривая, а не линейная ступенька: при 5° от горизонта
  // линейная дала бы ~0.17, кривая 0.55 — ~0.37, поэтому оттенок уже виден.
  expect(strengths[4]).toBeGreaterThan(0.3);

  // Слой света: не ловит клики, лежит ниже панелей (z-9/z-10) и переходит
  // плавно (400–600 мс), а не ступенькой.
  expect(style).not.toBeNull();
  expect(style?.pointerEvents).toBe("none");
  expect(style?.position).toBe("fixed");
  expect(Number(style?.zIndex)).toBeLessThan(9);
  const durationMs = Number.parseFloat(style?.transitionDuration ?? "0") * 1000;
  expect(durationMs).toBeGreaterThanOrEqual(400);
  expect(durationMs).toBeLessThanOrEqual(600);
});

test("D4: подпись таймлайна в сумерках — фаза и высота Солнца", async ({
  page,
}) => {
  const label = page.locator("[data-timeline-label]");

  await page.goto(`./?t=${clock(DAWN)}`);
  await expect(label).toContainText("рассвет");
  // Высота с запятой как десятичным разделителем и знаком минус:
  // «рассвет, солнце 2,1°» / «закат, солнце −2,1°».
  await expect(label).toContainText(/рассвет, солнце −?\d+,\d°/);
  await expect(label).toContainText("°");

  await page.goto(`./?t=${clock(DUSK)}`);
  await expect(label).toContainText("закат");
  await expect(label).toContainText(/закат, солнце −?\d+,\d°/);
  await expect(label).toContainText(clock(DUSK));

  // Вне сумерек подпись прежняя: фаза и высота не появляются.
  await page.goto(`./?t=${clock(DAY)}`);
  await expect(label).toContainText(clock(DAY));
  await expect(label).not.toContainText("рассвет");
  await expect(label).not.toContainText("закат");
  await expect(label).not.toContainText("солнце");
});

test("D4: сумеречный слой не перехватывает клики по чипам", async ({ page }) => {
  // Свежие факты: без них чип «Стройки и работы» законно скрыт (S9).
  await mockFreshMeta(page);
  await page.goto(`./?t=${clock(DUSK)}`);

  const chip = page.getByRole("button", { name: "Стройки и работы" });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-pressed", "false");

  // Сумерки действительно включены — иначе проверка клика ничего не докажет.
  await expect(page.locator("html")).toHaveAttribute("data-sky", "dusk");
  const skin = await readSkin(page);
  expect(skin.tint ?? 0).toBeGreaterThan(0.5);

  // В центре чипа — сам чип, а не слой света: он не перекрывает интерфейс.
  // Заставка (z-40) на время загрузки экран закрывает законно — ждём её уход.
  await expect(page.locator(".bg-splash")).toHaveCount(0);
  const hit = () =>
    chip.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const atPoint = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return atPoint !== null && element.contains(atPoint)
        ? "chip"
        : (atPoint?.className ?? "null");
    });
  await expect.poll(hit).toBe("chip");

  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
});

test("D4: ?theme= выключает сумерки и фиксирует фазу", async ({ page }) => {
  // Тёмный оверрайд — ночь, даже в разгар сумерек. Время в URL нарочно
  // сумеречное: проверяем, что побеждает ?theme=, а не расчёт по Солнцу.
  await page.goto(`./?theme=dark&t=${clock(DAWN)}`);
  let html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveAttribute("data-sky", "night");
  let skin = await readSkin(page);
  expect(skin.tint).toBe(0);

  // Светлый оверрайд — день.
  await page.goto(`./?theme=light&t=${clock(DUSK)}`);
  html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(html).toHaveAttribute("data-sky", "day");
  skin = await readSkin(page);
  expect(skin.tint).toBe(0);
});

test("D4: prefers-reduced-motion отключает переход сумеречного слоя", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`./?t=${clock(DUSK)}`);

  const layer = page.locator("[data-sky-layer]");
  await expect(layer).toBeAttached();
  await expect(page.locator("html")).toHaveAttribute("data-sky", "dusk");

  const style = await layer.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      duration: computed.transitionDuration,
      property: computed.transitionProperty,
    };
  });
  // `transition: none` даёт нулевую длительность — перехода нет.
  expect(style.duration).toBe("0s");
  expect(style.property).toBe("none");
});
