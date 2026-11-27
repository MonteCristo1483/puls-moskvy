// Типизированный доступ к дизайн-токенам для кода, которому нужен не
// Tailwind-класс, а значение: JS-анимации, canvas, метаданные PWA.
//
// Источник значений — `tokens.css`: здесь только имена CSS-переменных, чтобы
// смена палитры оставалась правкой одного файла. Исключение — `THEME_COLOR`:
// `<meta name="theme-color">` требует литеральный цвет, CSS-переменную туда
// подставить нельзя.

/** Цвет заставки/бренда. Дублирует `--c-splash` из tokens.css. */
export const THEME_COLOR = "#6a9d76";

export const color = {
  bgTop: "var(--bg-top)",
  bgMid: "var(--bg-mid)",
  bgBottom: "var(--bg-bottom)",
  surface: "var(--c-surface)",
  soft: "var(--c-soft)",
  panel: "var(--c-panel)",
  panelSoft: "var(--c-panel-soft)",
  chipOff: "var(--c-chip-off)",
  checkOff: "var(--c-check-off)",
  ink: "var(--c-ink)",
  inkHover: "var(--c-ink-hover)",
  ink2: "var(--c-ink-2)",
  ink3: "var(--c-ink-3)",
  inkIdle: "var(--c-ink-idle)",
  inkQuiet: "var(--c-ink-quiet)",
  icon: "var(--c-icon)",
  border: "var(--c-border)",
  track: "var(--c-track)",
  tick: "var(--c-tick)",
  tickQuiet: "var(--c-tick-quiet)",
  thumbRing: "var(--c-thumb-ring)",
  accent: "var(--c-accent)",
  accentInk: "var(--c-accent-ink)",
  accentContrast: "var(--c-accent-contrast)",
  checkOffInk: "var(--c-check-off-ink)",
  warn: "var(--c-warn)",
  warnBg: "var(--c-warn-bg)",
  warnBgStrong: "var(--c-warn-bg-strong)",
  warnInk: "var(--c-warn-ink)",
  warnInkStrong: "var(--c-warn-ink-strong)",
  warnAction: "var(--c-warn-action)",
  warnActionInk: "var(--c-warn-action-ink)",
  warnActionHover: "var(--c-warn-action-hover)",
  warnQuiet: "var(--c-warn-quiet)",
  warnQuietHover: "var(--c-warn-quiet-hover)",
  danger: "var(--c-danger)",
  dangerBg: "var(--c-danger-bg)",
  overlay: "var(--c-overlay)",
  overlayInk: "var(--c-overlay-ink)",
  splash: "var(--c-splash)",
  splashInk: "var(--c-splash-ink)",
} as const;

export const radius = {
  sm: "var(--r-sm)",
  md: "var(--r-md)",
  lg: "var(--r-lg)",
  pill: "var(--r-pill)",
} as const;

/** Отступы 2/4/6/8/12/16 px (в Tailwind — 0.5/1/1.5/2/3/4). */
export const space = {
  2: "var(--sp-2)",
  4: "var(--sp-4)",
  6: "var(--sp-6)",
  8: "var(--sp-8)",
  12: "var(--sp-12)",
  16: "var(--sp-16)",
} as const;

export const fontSize = {
  9: "var(--fs-9)",
  10: "var(--fs-10)",
  105: "var(--fs-105)",
  11: "var(--fs-11)",
  12: "var(--fs-12)",
  13: "var(--fs-13)",
  15: "var(--fs-15)",
} as const;

export const fontWeight = {
  normal: "var(--fw-normal)",
  medium: "var(--fw-medium)",
  semibold: "var(--fw-semibold)",
  bold: "var(--fw-bold)",
} as const;

export const shadow = {
  sm: "var(--shadow-sm)",
  md: "var(--shadow-md)",
  lg: "var(--shadow-lg)",
} as const;

export const alpha = {
  panel: "var(--alpha-panel)",
  soft: "var(--alpha-soft)",
  chipOff: "var(--alpha-chip-off)",
  checkOff: "var(--alpha-check-off)",
} as const;

export const duration = {
  fast: "var(--dur-fast)",
  base: "var(--dur-base)",
  slow: "var(--dur-slow)",
} as const;

export type ColorToken = keyof typeof color;
export type RadiusToken = keyof typeof radius;
export type SpaceToken = keyof typeof space;
export type FontSizeToken = keyof typeof fontSize;
export type ShadowToken = keyof typeof shadow;
export type AlphaToken = keyof typeof alpha;
export type DurationToken = keyof typeof duration;

/** `var(--c-…)` по имени токена — для inline-стилей и SVG-атрибутов. */
export function cssVar(token: ColorToken | RadiusToken | ShadowToken): string {
  return color[token as ColorToken] ?? radius[token as RadiusToken] ?? shadow[token as ShadowToken];
}
