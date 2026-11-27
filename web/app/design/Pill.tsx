import type { ComponentPropsWithoutRef } from "react";

/**
 * Pill — компактная плашка-подложка поверх карты (погода, тени): радиус
 * панели, полупрозрачная поверхность с блюром, мягкая тень, двухстрочный
 * столбец. Позиционирование и содержимое — за потребителем: `className`
 * дописывается после базовых классов, `aria-*`/`data-*`/`title` проходят
 * как есть.
 */
export default function Pill({
  className = "",
  ...rest
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={`flex select-none flex-col items-start gap-0.5 rounded-plate bg-panel px-2.5 py-1.5 text-ink shadow-plate backdrop-blur transition-colors ${className}`}
      {...rest}
    />
  );
}
