import type { SkySpecification } from "maplibre-gl";
import { readThemeOverride, themeForTime } from "./daylight";
import { moscowClockMinutes } from "./solar";

export type Theme = "light" | "dark";

/**
 * Тема первого клиентского рендера: `?theme=` (детерминированный оверрайд
 * для тестов и скриншотов) или свет по текущему московскому времени.
 * Ручного выбора больше нет: localStorage не читаем и не пишем, старый ключ
 * `karta-theme` игнорируется — у пользователя он может остаться в браузере.
 */
export function initialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return (
    readThemeOverride(window.location.search) ??
    themeForTime(moscowClockMinutes(Date.now()))
  );
}

export const MAP_FOG: Record<Theme, SkySpecification> = {
  light: {
    "sky-color": "#f7f2e8",
    "horizon-color": "#eee7db",
    "fog-color": "#eee7db",
    "sky-horizon-blend": 0.45,
    "horizon-fog-blend": 0.45,
    "fog-ground-blend": 0.72,
    "atmosphere-blend": 0.25,
  },
  dark: {
    "sky-color": "#111822",
    "horizon-color": "#1c2635",
    "fog-color": "#1c2635",
    "sky-horizon-blend": 0.45,
    "horizon-fog-blend": 0.45,
    "fog-ground-blend": 0.72,
    "atmosphere-blend": 0.25,
  },
};
