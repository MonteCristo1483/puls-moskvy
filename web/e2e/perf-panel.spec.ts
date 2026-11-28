import { test, expect, type Page } from "@playwright/test";

// Панель замера (`?perf=1`) на 390×844. Замер S14 показал: отчёт высотой
// 231 px с `bottom-2` накрывал таймлайн, плашку «© OpenStreetMap» и
// строку лицензии ODbL. Панель должна стоять в свободной полосе
// y ≈ 390–638 — над таймлайном с зазором не меньше 8 px и не вылезая
// за вьюпорт. Проверяем числами, а не «на глаз».

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
test.setTimeout(120_000);

type Box = { top: number; left: number; right: number; bottom: number };

/** Прямоугольник элемента в координатах вьюпорта. */
async function rect(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `нет элемента ${selector}`).not.toBeNull();
  const value = box!;
  return {
    top: value.y,
    left: value.x,
    right: value.x + value.width,
    bottom: value.y + value.height,
  };
}

/**
 * Пересечение прямоугольников: положительно только когда обе проекции
 * положительны, иначе — не больше нуля. Ровно та формула из задачи:
 * `min(bottoms) - max(tops) > 0 && min(rights) - max(lefts) > 0`.
 */
function intersection(a: Box, b: Box): number {
  const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  // min положителен только когда положительны обе проекции — то есть при
  // настоящем пересечении; иначе число не больше нуля.
  return Math.min(vertical, horizontal);
}

test("Панель замера стоит над таймлайном и не накрывает UI", async ({ page }) => {
  await page.goto("./?perf=1");

  // Отчёт появляется после готовности карты и 3 с замера fps.
  const panel = page.locator('[data-perf-panel="1"]');
  await expect(panel).toBeVisible({ timeout: 90_000 });
  await expect(panel).toContainText("Замер S14 · это устройство");

  const SEARCH = 'input[aria-label="Поиск дома по адресу"]';
  const SLIDER = '[role="slider"]';
  const PLATE = '[data-attribution-plate="1"]';
  const FOOTER = '[data-attribution-footer="1"]';

  await expect(page.locator(SEARCH)).toBeVisible();
  await expect(page.locator(SLIDER).first()).toBeVisible();
  await expect(page.locator(PLATE)).toBeVisible();
  await expect(page.locator(FOOTER)).toBeVisible();

  const panelBox = await rect(page, '[data-perf-panel="1"]');
  const search = await rect(page, SEARCH);
  const timeline = await rect(page, SLIDER);
  const plate = await rect(page, PLATE);
  const footer = await rect(page, FOOTER);
  const viewportHeight = await page.evaluate(() => window.innerHeight);

  const overlaps = {
    search: intersection(panelBox, search),
    timeline: intersection(panelBox, timeline),
    plate: intersection(panelBox, plate),
    footer: intersection(panelBox, footer),
  };
  console.log(
    `perf-панель: top=${panelBox.top.toFixed(1)} left=${panelBox.left.toFixed(1)} ` +
      `bottom=${panelBox.bottom.toFixed(1)} right=${panelBox.right.toFixed(1)} ` +
      `h=${(panelBox.bottom - panelBox.top).toFixed(1)}; ` +
      `пересечения: ${Object.entries(overlaps)
        .map(([name, value]) => `${name}=${value.toFixed(1)}`)
        .join(", ")}; таймлайн top=${timeline.top.toFixed(1)}`,
  );

  // Панель целиком во вьюпорте.
  expect(panelBox.top, `panel.top=${panelBox.top.toFixed(1)}`).toBeGreaterThanOrEqual(0);
  expect(
    panelBox.bottom,
    `panel.bottom=${panelBox.bottom.toFixed(1)} при innerHeight=${viewportHeight}`,
  ).toBeLessThanOrEqual(viewportHeight);

  // Панель не накрывает ни один из четырёх элементов.
  expect(overlaps.search, `пересечение с поиском = ${overlaps.search.toFixed(1)}`).toBeLessThanOrEqual(0);
  expect(overlaps.timeline, `пересечение с таймлайном = ${overlaps.timeline.toFixed(1)}`).toBeLessThanOrEqual(0);
  expect(overlaps.plate, `пересечение с плашкой = ${overlaps.plate.toFixed(1)}`).toBeLessThanOrEqual(0);
  expect(overlaps.footer, `пересечение с лицензией = ${overlaps.footer.toFixed(1)}`).toBeLessThanOrEqual(0);

  // И стоит с зазором над слайдером.
  expect(
    panelBox.bottom,
    `panel.bottom=${panelBox.bottom.toFixed(1)}, timeline.top=${timeline.top.toFixed(1)}`,
  ).toBeLessThanOrEqual(timeline.top - 8);
});
