// Состояние неба из кода WMO (weather_code) — чистые функции, без DOM.
//
// Коды Open-Meteo: 0–1 ясно, 45/48 туман, 51–67 морось и дождь, 71–77 снег,
// 80–82 ливни, 85–86 снежные заряды. Отдельно решаем дождь или снег по
// температуре: одна и та же морось при −3 °C — это снег.
export type SkyKind = "clear" | "rain" | "snow" | "fog";

const FOG_CODES = new Set([45, 48]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const RAIN_CODES = new Set([
  51, 52, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82,
]);

/** Длительность перехода состояния неба: только прозрачностью. */
export const SKY_TRANSITION_MS = 350;

/** Насколько гаснут лазурные струи ветра в каждом состоянии. */
export const STREAM_OPACITY: Record<SkyKind, number> = {
  clear: 1,
  rain: 0.3,
  snow: 0.3,
  fog: 0,
};

/** Осадки рисуем только в этих состояниях. */
export function hasPrecipitation(kind: SkyKind): boolean {
  return kind === "rain" || kind === "snow";
}

export type SkyInput = {
  weatherCode: number | null;
  temperatureC: number;
};

/**
 * Состояние неба: fog / snow / rain / clear. Нет кода (старый ответ или мок) —
 * «ясно»: молчаливое отсутствие данных не должно включать осадки.
 */
export function skyState(values: SkyInput | null | undefined): SkyKind {
  if (!values) return "clear";
  const code = values.weatherCode;
  if (code === null || !Number.isFinite(code)) return "clear";
  if (FOG_CODES.has(code)) return "fog";
  if (SNOW_CODES.has(code)) return "snow";
  if (RAIN_CODES.has(code)) {
    return values.temperatureC >= 1 ? "rain" : "snow";
  }
  return "clear";
}
