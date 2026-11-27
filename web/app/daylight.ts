// D3: тема интерфейса — не настройка пользователя, а следствие положения
// Солнца над Москвой. Здесь только правило «светло/темно»: сумеречная
// полоса и плавные пороги — задача D4.
//
// Модуль чистый (без DOM): `themeForTime` вызывают и карта, и тесты.
import { moscowInstantAt, sunPosition } from "./solar";
import type { Theme } from "./theme";

/**
 * Точка, для которой считаем свет: центр Москвы.
 * Порядок — [широта, долгота], как у `sunPosition(when, lat, lon)`.
 * Те же координаты уже используются как запасной центр погоды
 * (`FALLBACK_CENTER` в weather-layer.tsx), но там порядок [lon, lat].
 */
export const MOSCOW_CENTER: [number, number] = [55.7558, 37.6173];

/** Query-параметр детерминированной темы: `?theme=dark|light`. */
export const THEME_PARAM = "theme";

/**
 * Тема для минут от московской полуночи: тёмная, пока Солнце не поднялось
 * выше горизонта (высота ≤ 0°), иначе светлая. `reference` задаёт календарную
 * дату (по умолчанию — сегодня), чтобы `?t=23:00` не зависел от машины.
 */
export function themeForTime(
  minutesOfDay: number,
  reference: Date = new Date(),
): Theme {
  const when = moscowInstantAt(minutesOfDay, reference);
  const sun = sunPosition(when, MOSCOW_CENTER[0], MOSCOW_CENTER[1]);
  return sun.altitudeDeg <= 0 ? "dark" : "light";
}

/**
 * Оверрайд темы из query-строки: `?theme=dark` / `?theme=light`. Нужен
 * тестам и скриншотам, чтобы кадр не зависел от реального времени, и
 * обязан побеждать расчёт по Солнцу. Любое другое значение — null.
 */
export function readThemeOverride(search: string): Theme | null {
  const value = new URLSearchParams(search).get(THEME_PARAM);
  return value === "dark" || value === "light" ? value : null;
}
