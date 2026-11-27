import { test, expect, type Page } from "@playwright/test";

// S3: слой «Тени и пыль» в панели слоёв. Тест не зависит от WebGL/данных:
// плашка появляется сразу после включения чипа, а время берём из `?t=`.
const toggleShadows = (page: Page) =>
  page.evaluate(() => {
    const label = [...document.querySelectorAll("label")].find((el) =>
      el.textContent?.includes("Тени и пыль"),
    );
    const input = label?.querySelector("input");
    if (!input) throw new Error("чип «Тени и пыль» не найден");
    input.click();
  });

test("Тени: чип выключен по умолчанию, включает плашку времени", async ({ page }) => {
  await page.goto("./?t=14:00");

  const chip = page.getByRole("checkbox", { name: "Тени и пыль" });
  await expect(chip).toBeVisible();
  await expect(chip).not.toBeChecked();
  await expect(page.locator("[data-shadows-pill]")).toHaveCount(0);

  await toggleShadows(page);
  await expect(chip).toBeChecked();

  const pill = page.locator("[data-shadows-pill]");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("Тени на 14:00");
  await expect(pill).toHaveAttribute("data-shadows-time", "14:00");

  await toggleShadows(page);
  await expect(chip).not.toBeChecked();
  await expect(pill).toHaveCount(0);
});

test("Тени: на карте считаются для кадра и укладываются в бюджет 200 мс", async ({
  page,
}) => {
  // Тест долгий по своей природе: poll до 25 с, прогрев до 12 с и до 6 попыток
  // по 12 с на загруженной машине (CI/параллельный билд) выходят за общий
  // лимит Playwright в 30 с. Порог бюджета (200 мс) при этом не меняется:
  // увеличиваем только собственный таймаут, чтобы измерение дошло до конца.
  test.setTimeout(120_000);
  await page.goto("./?t=14:00");
  await toggleShadows(page);

  // Карта создаётся асинхронно (движок + PMTiles). Без этой паузы проверка
  // ниже иногда «не видела» карту и тест молча уходил в ветку «нет WebGL»,
  // проходя без замера бюджета. Ждём карту, но не дольше 20 с: если её
  // действительно нет, остаётся прежняя ветка с одной плашкой.
  await page
    .waitForFunction(
      () => Boolean((window as unknown as { __map?: unknown }).__map),
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});

  const hasMap = await page.evaluate(() =>
    Boolean((window as unknown as { __map?: unknown }).__map),
  );
  if (!hasMap) {
    test.info().annotations.push({
      type: "skip-reason",
      description: "Нет WebGL/данных карты — проверена только плашка",
    });
    await expect(page.locator("[data-shadows-pill]")).toBeVisible();
    return;
  }

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const pill = document.querySelector("[data-shadows-pill]");
          if (!pill) return -1;
          return Number(pill.getAttribute("data-shadows-count") ?? 0);
        }),
      { timeout: 25_000, message: "тени посчитаны для текущего кадра" },
    )
    .toBeGreaterThan(0);

  // Бюджет меряем медианой по 3 пересчётам, а не одной холодной цифрой:
  // на общем раннере одиночный замер шумит на десятки процентов (первый кадр
  // включает парсинг тайлов и прогрев JIT). Порог при этом не меняется.
  const readState = () =>
    page.evaluate(() => {
      const pill = document.querySelector("[data-shadows-pill]");
      return {
        run: Number(pill?.getAttribute("data-shadows-run") ?? 0),
        ms: Number(pill?.getAttribute("data-shadows-ms") ?? 0),
        unionMs: Number(pill?.getAttribute("data-shadows-union-ms") ?? 0),
        count: Number(pill?.getAttribute("data-shadows-count") ?? 0),
        status: pill?.getAttribute("data-shadows-status"),
        altitude: Number(pill?.getAttribute("data-shadows-sun-altitude") ?? 0),
      };
    });

  // Ждём пересчёт, в котором union реально считался (не попал в кэш кадра):
  // именно этот путь мерил CI, и именно его мы обязаны уложить в бюджет.
  const waitForFreshCompute = async (previous: number, timeout = 12_000) => {
    await expect
      .poll(
        async () => {
          const state = await readState();
          return state.run > previous && state.unionMs > 0 && state.count >= 300
            ? state.run
            : -1;
        },
        { timeout, message: "пересчёт теней завершился (union посчитан)" },
      )
      .toBeGreaterThan(previous);
  };

  // Сдвиг на ~100 м: кадр меняется (union пересчитывается), но остаёмся в той
  // же плотной застройке — иначе можно уехать туда, где домов ещё не загрузили.
  const shiftMap = (anchors: number) =>
    page.evaluate((index) => {
      const map = (window as unknown as {
        __map: {
          getCenter: () => { lng: number; lat: number };
          jumpTo: (o: unknown) => void;
        };
      }).__map;
      const center = map.getCenter();
      map.jumpTo({
        center: [center.lng + 0.0015, center.lat + 0.0008 * index],
      });
    }, anchors);

  // Прогрев: первый пересчёт уже прошёл (poll выше), но JIT и тайлы догреваются
  // ещё одним движением карты.
  const warmupState = await readState();
  await shiftMap(1);
  await waitForFreshCompute(warmupState.run);

  const samples: number[] = [];
  let attempts = 0;
  while (samples.length < 3 && attempts < 6) {
    attempts += 1;
    const before = await readState();
    await shiftMap(attempts);
    try {
      await waitForFreshCompute(before.run);
    } catch {
      continue; // кадр попал в кэш или дома не догрузились — шагаем дальше
    }
    const state = await readState();
    expect(state.status, "пересчёт не упал в night/zoom").toBe("ok");
    expect(state.count, "тени посчитаны").toBeGreaterThanOrEqual(300);
    samples.push(state.ms);
  }
  expect(samples.length, "набрали 3 замера пересчёта").toBe(3);

  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[1];
  const stats = await readState();
  console.log(
    `тени: ${stats.count} шт, ${stats.ms.toFixed(1)} мс; прогоны ${samples
      .map((value) => value.toFixed(1))
      .join(", ")} мс; медиана ${median.toFixed(1)} мс (солнце ${stats.altitude.toFixed(1)}°)`,
  );
  expect(
    Boolean(
      await page.evaluate(() =>
        Boolean(
          (window as unknown as { __map?: { getLayer: (id: string) => unknown } })
            .__map?.getLayer("shadows-ground-fill"),
        ),
      ),
    ),
    "fill-слой теней создан",
  ).toBe(true);
  expect(median).toBeLessThan(200);
});
