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
  await page.goto("./?t=14:00");
  await toggleShadows(page);

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

  const stats = await page.evaluate(() => {
    const pill = document.querySelector("[data-shadows-pill]");
    return {
      status: pill?.getAttribute("data-shadows-status"),
      count: Number(pill?.getAttribute("data-shadows-count") ?? 0),
      ms: Number(pill?.getAttribute("data-shadows-ms") ?? 0),
      altitude: Number(pill?.getAttribute("data-shadows-sun-altitude") ?? 0),
      layer: Boolean(
        (window as unknown as { __map?: { getLayer: (id: string) => unknown } })
          .__map?.getLayer("shadows-ground-fill"),
      ),
    };
  });
  console.log(
    `тени: ${stats.count} шт, ${stats.ms.toFixed(1)} мс, солнце ${stats.altitude.toFixed(1)}°`,
  );
  expect(stats.layer, "fill-слой теней создан").toBe(true);
  expect(stats.status).toBe("ok");
  expect(stats.ms).toBeLessThan(200);
});
