import type { ComponentPropsWithoutRef } from "react";

/**
 * Panel — панель с радиусом, тенью и полупрозрачной поверхностью (таймлайн).
 * Внутреннюю раскладку (flex, gap, отступы между блоками) задаёт потребитель
 * через `className`; `aria-*`/`data-*`/`title` пробрасываются.
 */
export default function Panel({
  className = "",
  ...rest
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={`rounded-plate bg-panel px-2.5 py-2 text-ink shadow-plate backdrop-blur transition-colors ${className}`}
      {...rest}
    />
  );
}
