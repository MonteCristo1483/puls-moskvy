import { test, expect } from "@playwright/test";

// D3: тема — не настройка пользователя, а следствие времени суток на
// таймлайне. Ручного тумблера и localStorage больше нет; `?theme=` остался
// только детерминированным оверрайдом для тестов и скриншотов и обязан
// побеждать расчёт по Солнцу.
test.describe("Тема из времени суток", () => {
  test("?t=23:00 — тёмная тема", async ({ page }) => {
    await page.goto("./?t=23:00");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("?t=12:00 — светлая тема", async ({ page }) => {
    await page.goto("./?t=12:00");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("?theme= побеждает время суток", async ({ page }) => {
    await page.goto("./?theme=light&t=23:00");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.goto("./?theme=dark&t=12:00");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("тумблера темы в интерфейсе нет", async ({ page }) => {
    await page.goto("./?t=12:00");
    await expect(page.locator("[data-timeline-slider]")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Переключить тему" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /тёмная тема|светлая тема/i }),
    ).toHaveCount(0);
  });

  test("смена часа таймлайна меняет тему без перезагрузки", async ({ page }) => {
    await page.goto("./?t=12:00");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");

    // 12:00 → 23:00: одиннадцать шагов по часу клавишей вправо.
    const slider = page.getByRole("slider", { name: "Время суток, Москва" });
    await slider.focus();
    for (let step = 0; step < 11; step += 1) {
      await slider.press("ArrowRight");
    }

    await expect(html).toHaveAttribute("data-theme", "dark");
    // Перезагрузки не было: URL обновлён через history.replaceState.
    await expect(page).toHaveURL(/[?&]t=23:00/);
  });
});
