import type { ComponentPropsWithRef } from "react";

/**
 * Panel — панель с радиусом, тенью и полупрозрачной поверхностью (таймлайн).
 * Внутреннюю раскладку (flex, gap, отступы между блоками) задаёт потребитель
 * через `className`; `aria-*`/`data-*`/`title` и `ref` пробрасываются — ref
 * нужен диалогам, которые ставят на панель фокус при открытии (S10).
 */
export default function Panel({
  className = "",
  ...rest
}: ComponentPropsWithRef<"div">) {
  return (
    <div
      className={`rounded-plate bg-panel px-2.5 py-2 text-ink shadow-plate backdrop-blur transition-colors ${className}`}
      {...rest}
    />
  );
}
