"use client";

// Бейдж «данные на ДД.ММ ЧЧ:ММ» (S6). Данные приходят из общего стека фактов
// (`layers/facts-store.ts`): загрузкой владеет слой фактов, бейдж — только
// представление. Файла нет или данные старше 24 ч — пишем «нет данных» и не
// обещаем свежесть (ARCHITECTURE §2, S9).
//
// Плашка стоит в правом верхнем углу, но ниже кнопок карты (+/− и компас
// MapLibre занимают верхние ~100 px): внизу слева уже погода и тени, по
// центру — таймлайн, внизу справа — футер с атрибуцией, поэтому верх справа
// под контролами не перекрывает ни то, ни другое.
import { useSyncExternalStore } from "react";
import { Badge } from "./design";
import { factsStore, initialFacts } from "./layers/facts-store";

export default function FactsBadge() {
  const facts = useSyncExternalStore(
    factsStore.subscribe,
    factsStore.get,
    () => initialFacts,
  );

  const text =
    facts.status === "ok" && facts.clock
      ? `Данные на ${facts.clock}`
      : facts.status === "loading"
        ? "Данные · загрузка…"
        : "нет данных";

  return (
    <Badge
      data-facts-badge="1"
      data-facts-status={facts.status}
      data-facts-time={facts.generated ?? undefined}
      role="status"
      title="Городские факты: data.mos.ru, набор 2855 «действующие ордера», лицензия CC BY 4.0. Обновление раз в сутки; если данных нет или они старше 24 ч — пишем «нет данных»."
      className="absolute right-3 top-[7.5rem] z-20"
    >
      <span
        className={`text-11 font-semibold leading-none ${
          facts.stale ? "text-warn" : ""
        }`}
      >
        {text}
      </span>
      <span className="text-10 leading-none text-ink-2">data.mos.ru · факты</span>
    </Badge>
  );
}
