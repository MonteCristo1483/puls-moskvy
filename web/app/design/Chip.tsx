import type { ComponentPropsWithoutRef, ReactNode } from "react";

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2 6.3 4.7 9 10 3.2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type ChipProps = Omit<ComponentPropsWithoutRef<"label">, "onChange"> & {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
};

/**
 * Chip — переключатель-пилюля со галочкой (чипы слоёв). Это настоящий
 * `<label>` + `<input type="checkbox">`: клавиатура, фокус-кольцо и доступное
 * имя работают штатно, ничего не прячем от браузера и тестов. Внешний вид
 * зависит только от `checked`; содержимое (иконка, подпись) задаёт
 * потребитель, `aria-*`/`data-*` на `<label>` пробрасываются.
 *
 * В выключенном состоянии галочка остаётся видимой, но приглушённой
 * (`text-check-off-ink` на подложке `bg-check-off`) — это паритет с видом до
 * F2, а не случайность порядка классов: раньше белый и прозрачный цвет
 * конкурировали, побеждал белый. Не убирать без решения по дизайну.
 */
export default function Chip({
  checked,
  onToggle,
  children,
  className = "",
  ...rest
}: ChipProps) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-1.5 rounded-pill px-2.5 py-1 text-12 font-medium shadow-plate backdrop-blur transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/60 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-transparent md:px-3 md:py-1.5 md:text-13 ${
        checked ? "bg-panel text-ink" : "bg-chip-off text-ink-idle"
      } ${className}`}
      {...rest}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="peer sr-only"
      />
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-pill border transition-colors ${
          checked
            ? "border-accent bg-accent text-accent-contrast"
            : "border-border bg-check-off text-check-off-ink"
        }`}
        aria-hidden
      >
        <CheckIcon />
      </span>
      {children}
    </label>
  );
}
