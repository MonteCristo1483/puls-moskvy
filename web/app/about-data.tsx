"use client";

// Экран «О данных» (S10): откуда цифры на карте и на каких условиях.
//
// Приёмка ROADMAP: «4 источника перечислены, ссылки открываются, ODbL-атрибуция
// видна на карте, а не только в футере». Этот файл — сама панель; открывают её
// две кнопки на карте (плашка «© OpenStreetMap» и футер-строка, см. map.tsx).
//
// Дата выгрузки не запрашивается второй раз: снимок `live/meta.json` уже лежит
// в общем стеке фактов (`layers/facts-store.ts`), здесь только чтение — так же,
// как это делает бейдж `facts-badge.tsx`. Нет данных — так и пишем: «нет
// данных».
//
// Визуально это те же примитивы, что и у остальных панелей (`Panel`, `Badge`,
// токены): решение по новому стилю ещё не принято владельцем.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Badge, Panel } from "./design";
import { ABOUT_DISCLAIMER, DATA_SOURCES } from "./data-sources";
import { factsStore, initialFacts, type FactsStatus } from "./layers/facts-store";

/** «openstreetmap.org/copyright» — ссылка без протокола, читается глазом. */
function linkLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * Снимок фактов → строка про дату выгрузки. Устаревшие данные не выдаём за
 * свежие: дату оставляем, но помечаем словом «устарели». Файла нет — «нет
 * данных» (S9: обещать нечего, если источника нет). `stale` и `missing` —
 * разные машинные состояния, но для человека это по-прежнему две строки.
 */
function exportDateText(status: FactsStatus, clock: string | null): string {
  if (status === "loading") return "Выгрузка городских данных: загрузка…";
  if (clock === null) return "Выгрузка городских данных: нет данных";
  return status === "ok"
    ? `Выгрузка городских данных: ${clock} (МСК)`
    : `Выгрузка городских данных: ${clock} (МСК) · устарели`;
}

export default function AboutData({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const facts = useSyncExternalStore(
    factsStore.subscribe,
    factsStore.get,
    () => initialFacts,
  );

  // Фокус при открытии уходит в панель: клавиатура и скринридер начинают
  // диалог с него, а не блуждают по карте под оверлеем.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Escape закрывает панель, Tab не выпускает фокус наружу (диалог модальный).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const dateText = exportDateText(facts.status, facts.clock);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-3 md:items-center">
      {/* Клик мимо панели закрывает её: привычнее, чем только крестик. */}
      <div
        className="absolute inset-0 bg-ink/20"
        aria-hidden
        onClick={onClose}
      />
      <Panel
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-data-title"
        data-about-data="1"
        tabIndex={-1}
        className="relative z-10 flex max-h-[85vh] w-full max-w-[30rem] flex-col overflow-y-auto outline-none"
      >
        <div className="flex flex-col gap-3 px-1.5 py-1">
          <div className="flex items-start justify-between gap-3">
            <h2
              id="about-data-title"
              className="text-13 font-semibold leading-none text-ink"
            >
              О данных
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="rounded-pill p-0.5 text-ink-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path
                  d="M1 1l12 12M13 1L1 13"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <p
            data-about-date={facts.clock ?? "none"}
            className="text-11 leading-snug text-ink-2"
          >
            {dateText}
          </p>

          <ul className="flex flex-col gap-2.5">
            {DATA_SOURCES.map((source) => (
              <li
                key={source.id}
                data-about-source={source.id}
                className="flex flex-col gap-1 border-t border-border/60 pt-2.5 first:border-t-0 first:pt-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-12 font-semibold leading-snug text-ink">
                    {source.name}
                  </span>
                  <Badge className="shrink-0 text-10 font-semibold leading-none">
                    {source.license}
                  </Badge>
                </div>
                <span className="text-11 leading-snug text-ink-2">
                  {source.provides}
                </span>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  data-about-link={source.id}
                  className="w-fit break-all text-11 leading-snug text-accent-ink underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                >
                  {linkLabel(source.url)}
                </a>
              </li>
            ))}
          </ul>

          <p className="border-t border-border/60 pt-2.5 text-11 leading-snug text-ink-2">
            {ABOUT_DISCLAIMER}
          </p>
        </div>
      </Panel>
    </div>
  );
}
