// D3/D4: тема интерфейса — не настройка пользователя, а следствие положения
// Солнца над Москвой. D3 дал правило «светло/темно» (порог 0°), D4 — фазы
// неба и сумеречную полосу: пока Солнце в пределах ±6° от горизонта, карта
// проходит через рассвет или закат, а не переключается ступенькой.
//
// Модуль чистый (без DOM): `themeForTime`/`skyState` вызывают и карта, и тесты.
import { moscowInstantAt, sunPosition } from "./solar";
import type { Theme } from "./theme";

/** Полуширина сумеречной полосы: |высота Солнца| < 6° — рассвет/закат. */
export const TWILIGHT_DEG = 6;

/**
 * Фаза неба. `night` — Солнце ниже −6°, `day` — выше +6°, `dawn`/`dusk` —
 * сумерки, различаемые по знаку изменения высоты за минуту.
 */
export type SkyPhase = "night" | "dawn" | "day" | "dusk";

/** Сводка неба для минут от московской полуночи: фаза, высота, сила света. */
export type SkyState = {
  phase: SkyPhase;
  /** Высота Солнца, градусы (отрицательная — под горизонтом). */
  altitudeDeg: number;
  /** 0…1: насколько включён сумеречный свет (1 — Солнце на горизонте). */
  strength: number;
};

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
 * Высота Солнца над горизонтом (градусы) для минут от московской полуночи.
 * `reference` задаёт календарную дату — та же договорённость, что у
 * `themeForTime`: `?t=05:42` не зависит от машины.
 */
export function sunAltitude(
  minutesOfDay: number,
  reference: Date = new Date(),
): number {
  return sunAltitudeAt(minutesOfDay, reference);
}

function sunAltitudeAt(minutesOfDay: number, reference: Date): number {
  const when = moscowInstantAt(minutesOfDay, reference);
  return sunPosition(when, MOSCOW_CENTER[0], MOSCOW_CENTER[1]).altitudeDeg;
}

/**
 * Сила сумеречного света 0…1: 1 при высоте 0° (Солнце на горизонте), 0 при
 * |высоте| ≥ 6°. Линейно между — карта не «щёлкает», а проходит через свет.
 */
export function twilightStrength(
  minutesOfDay: number,
  reference: Date = new Date(),
): number {
  return strengthForAltitude(sunAltitudeAt(minutesOfDay, reference));
}

function strengthForAltitude(altitudeDeg: number): number {
  const distance = Math.abs(altitudeDeg);
  if (distance >= TWILIGHT_DEG) return 0;
  return 1 - distance / TWILIGHT_DEG;
}

/**
 * Фаза неба: ниже −6° — ночь, выше +6° — день, между — рассвет (Солнце
 * поднимается) или закат (опускается). Направление берём по разнице высот
 * через минуту, а не по времени суток: так правило одно и для утра, и для
 * вечера.
 */
export function skyPhase(
  minutesOfDay: number,
  reference: Date = new Date(),
): SkyPhase {
  return phaseFor(minutesOfDay, reference, sunAltitudeAt(minutesOfDay, reference));
}

function phaseFor(
  minutesOfDay: number,
  reference: Date,
  altitudeDeg: number,
): SkyPhase {
  if (altitudeDeg < -TWILIGHT_DEG) return "night";
  if (altitudeDeg > TWILIGHT_DEG) return "day";
  const next = sunAltitudeAt(minutesOfDay + 1, reference);
  return next > altitudeDeg ? "dawn" : "dusk";
}

/**
 * Всё небо одним расчётом (map.tsx пересчитывает его там же, где тему):
 * фаза, высота и сила сумерек из одного положения Солнца, чтобы `data-sky`,
 * `data-sun-altitude` и `--sky-tint` не могли разойтись.
 */
export function skyState(
  minutesOfDay: number,
  reference: Date = new Date(),
): SkyState {
  const altitudeDeg = sunAltitudeAt(minutesOfDay, reference);
  return {
    phase: phaseFor(minutesOfDay, reference, altitudeDeg),
    altitudeDeg,
    strength: strengthForAltitude(altitudeDeg),
  };
}

/**
 * Фаза неба при детерминированном `?theme=`: сумерки выключены, поэтому
 * тёмная тема — ночь, светлая — день. Тема остаётся оверрайдом, а не
 * следствием Солнца, иначе скриншоты зависели бы от даты.
 */
export function overrideSkyPhase(override: Theme): SkyPhase {
  return override === "light" ? "day" : "night";
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
