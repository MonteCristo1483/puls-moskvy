"use client";

// Таймлайн «Сейчас / Было / Будет» (S4).
//
// Горизонтальная шкала на сутки (московское время): деления каждый час,
// подписи каждые 3 часа, ползунок, клик и перетаскивание по шкале. Выбор
// живёт в URL (`?t=HH:MM`) — ссылка переносится на другое устройство и не
// требует ни localStorage, ни сервера. «Сейчас» убирает параметр и включает
// живой режим. Разбор `?t=` — тот же `parseClockParam` из solar.ts, что у
// слоя теней (второй парсер не нужен).
//
// Компонент не знает про карту и погоду: он принимает выбранные минуты и
// отдаёт их родителю (map.tsx), а тот передаёт их слоям.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { formatClock, moscowClockMinutes, parseClockParam } from "./solar";

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = MINUTES_PER_HOUR * HOURS_PER_DAY;
/** Последний выбираемый час: «сегодня 23:00» — граница суток. */
const LAST_HOUR_MINUTES = (HOURS_PER_DAY - 1) * MINUTES_PER_HOUR;
/** Подписи на шкале — каждые 3 часа; мелкие деления — каждый час. */
const LABELED_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

/**
 * Выбранное время из `?t=HH:MM` (московское). null — параметра нет или
 * формат чужой, значит живой режим.
 */
export function readTimelineParam(search: string): number | null {
  return parseClockParam(new URLSearchParams(search).get("t"));
}

/**
 * Записать выбор в URL через `history.replaceState`: без перезагрузки,
 * без запроса к серверу и без новой записи в истории. «Сейчас» (null) —
 * убрать параметр. Остальные параметры (`building`, `perf`) сохраняются.
 */
export function writeTimelineParam(minutes: number | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  if (minutes === null) params.delete("t");
  else params.set("t", formatClock(minutes));
  // URLSearchParams кодирует `:` как %3A, а в ссылке нужен читаемый `?t=14:00`
  // (и тесты, и владелец сравнивают строку). Двоеточие в query разрешено.
  url.search = params.toString().replace(/%3A/gi, ":");
  if (url.href === window.location.href) return;
  window.history.replaceState(null, "", url);
}

function clampSelection(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0;
  if (minutes < 0) return 0;
  if (minutes > LAST_HOUR_MINUTES) return LAST_HOUR_MINUTES;
  return Math.round(minutes / MINUTES_PER_HOUR) * MINUTES_PER_HOUR;
}

function percent(minutes: number): number {
  return (Math.min(MINUTES_PER_DAY, Math.max(0, minutes)) / MINUTES_PER_DAY) * 100;
}

export function Timeline({
  minutes,
  onChange,
}: {
  /** Выбранные минуты от полуночи или null — живой режим. */
  minutes: number | null;
  /** Смена выбора; null — вернуться к «сейчас». */
  onChange: (next: number | null) => void;
}) {
  // Время «сейчас» зависит от часов машины, поэтому до монтирования его нет:
  // иначе SSR-разметка и гидрация разошлись бы на минуту.
  const [mounted, setMounted] = useState(false);
  const [nowMinutes, setNowMinutes] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const sync = () => setNowMinutes(Math.floor(moscowClockMinutes(Date.now())));
    sync();
    setMounted(true);
    const timer = window.setInterval(sync, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!mounted) return null;

  const currentMinutes =
    minutes === null ? Math.min(MINUTES_PER_DAY - 1, nowMinutes) : minutes;
  const selectedHour = Math.floor(currentMinutes / MINUTES_PER_HOUR);
  const live = minutes === null;
  // «Сейчас» — и живой режим, и выбранный текущий час: так подпись не врёт.
  const modeLabel = live
    ? `Сейчас · ${formatClock(currentMinutes)}`
    : selectedHour === Math.floor(nowMinutes / MINUTES_PER_HOUR)
      ? `Сейчас · ${formatClock(minutes)}`
      : minutes < nowMinutes
        ? `Было · ${formatClock(minutes)}`
        : `Будет · ${formatClock(minutes)}`;

  const applyClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    const clamped = Math.min(1, Math.max(0, ratio));
    const hour = Math.min(
      HOURS_PER_DAY - 1,
      Math.max(0, Math.round(clamped * HOURS_PER_DAY)),
    );
    onChange(hour * MINUTES_PER_HOUR);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const track = event.currentTarget;
    track.focus();
    draggingRef.current = true;
    try {
      track.setPointerCapture(event.pointerId);
    } catch {
      // Захват не критичен: клик всё равно обработан ниже.
    }
    applyClientX(event.clientX);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    applyClientX(event.clientX);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Указатель уже отпущен — отпускать нечего.
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // От «сейчас» шагаем от текущего часа, иначе — от выбранного.
    const base = clampSelection(
      minutes ?? Math.floor(nowMinutes / MINUTES_PER_HOUR) * MINUTES_PER_HOUR,
    );
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = base + MINUTES_PER_HOUR;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = base - MINUTES_PER_HOUR;
        break;
      case "PageUp":
        next = base + 3 * MINUTES_PER_HOUR;
        break;
      case "PageDown":
        next = base - 3 * MINUTES_PER_HOUR;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = LAST_HOUR_MINUTES;
        break;
      default:
        return;
    }
    event.preventDefault();
    onChange(clampSelection(next));
  };

  const focusRing =
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent";

  return (
    <div
      data-timeline="1"
      data-timeline-mode={live ? "live" : "fixed"}
      data-timeline-value={formatClock(currentMinutes)}
      title="Время на карте: погода, ветер и тени считаются на выбранный час. Ссылка сохраняет выбор (?t=ЧЧ:ММ)."
      className="absolute bottom-[7.2rem] left-3 right-3 z-[9] flex select-none flex-col gap-1.5 rounded-2xl bg-white/85 px-2.5 py-2 text-slate-700 shadow-sm backdrop-blur transition-colors md:bottom-[3.2rem] md:left-1/2 md:right-auto md:w-[min(58vw,560px)] md:-translate-x-1/2 dark:bg-slate-900/80 dark:text-slate-200"
    >
      <div className="flex items-center justify-between gap-2">
        <span
          data-timeline-label="1"
          className={`text-[12px] font-semibold leading-none md:text-[13px] ${
            live ? "text-slate-700 dark:text-slate-200" : "text-emerald-700 dark:text-emerald-400"
          }`}
        >
          {modeLabel}
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={live}
          title="Вернуться к текущему времени"
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium leading-none shadow-sm transition-colors ${focusRing} ${
            live
              ? "bg-emerald-500 text-white"
              : "bg-white/70 text-slate-500 hover:text-slate-700 dark:bg-slate-800/70 dark:text-slate-300 dark:hover:text-slate-100"
          }`}
        >
          Сейчас
        </button>
      </div>

      <div
        ref={trackRef}
        data-timeline-slider="1"
        role="slider"
        tabIndex={0}
        aria-label="Время суток, Москва"
        aria-valuemin={0}
        aria-valuemax={MINUTES_PER_DAY - 1}
        aria-valuenow={currentMinutes}
        aria-valuetext={formatClock(currentMinutes)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={`relative cursor-pointer touch-none rounded-full px-1 pt-1.5 pb-0.5 ${focusRing}`}
      >
        <div className="relative h-1.5 rounded-full bg-slate-200 dark:bg-slate-700">
          <div
            aria-hidden
            className="absolute inset-y-0 left-0 rounded-full bg-emerald-500"
            style={{ width: `${percent(currentMinutes)}%` }}
          />
          {Array.from({ length: HOURS_PER_DAY }, (_, hour) => hour).map((hour) => (
            <span
              key={hour}
              aria-hidden
              className={`absolute top-full w-px ${
                hour % 3 === 0
                  ? "h-2 bg-slate-400 dark:bg-slate-500"
                  : "h-1 bg-slate-300 dark:bg-slate-600"
              }`}
              style={{ left: `${percent(hour * MINUTES_PER_HOUR)}%` }}
            />
          ))}
          <span
            aria-hidden
            className="absolute -top-[5px] h-4 w-4 -translate-x-1/2 rounded-full border-2 border-white bg-emerald-500 shadow dark:border-slate-900"
            style={{ left: `${percent(currentMinutes)}%` }}
          />
        </div>
        <div aria-hidden className="relative mt-2 h-2.5">
          {LABELED_HOURS.map((hour) => (
            <span
              key={hour}
              className={`absolute top-0 text-[9px] leading-none text-slate-500 dark:text-slate-400 ${
                hour === 0 ? "" : "-translate-x-1/2"
              }`}
              style={{ left: `${percent(hour * MINUTES_PER_HOUR)}%` }}
            >
              {hour < 10 ? `0${hour}` : String(hour)}
            </span>
          ))}
          <span className="absolute right-0 top-0 -translate-x-0 text-[9px] leading-none text-slate-400 dark:text-slate-500">
            24
          </span>
        </div>
      </div>
    </div>
  );
}

export default Timeline;
