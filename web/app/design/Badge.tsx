import type { ComponentPropsWithoutRef } from "react";

/**
 * Badge — маленький бейдж статуса/даты (бейдж городских фактов): тот же
 * материал, что у плашки, но содержимое прижато вправо и текст мельче —
 * это задаёт потребитель. `aria-*`/`data-*`/`title` пробрасываются.
 */
export default function Badge({
  className = "",
  ...rest
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={`flex select-none flex-col items-end gap-0.5 rounded-plate bg-panel px-2.5 py-1.5 text-ink shadow-plate backdrop-blur transition-colors ${className}`}
      {...rest}
    />
  );
}
