"use client";

// Бейдж «данные на ДД.ММ ЧЧ:ММ» (S6). Читает `live/meta.json`, который раз в
// сутки обновляет `.github/workflows/live-data.yml`; файла нет или данные
// старше 24 ч — пишет «нет данных» и не обещает свежесть (ARCHITECTURE §2,
// S9). Слой фактов на карте — S7, здесь только дата и источник.
//
// Плашка стоит в правом верхнем углу, но ниже кнопок карты (+/− и компас
// MapLibre занимают верхние ~100 px): внизу слева уже погода и тени, по
// центру — таймлайн, внизу справа — футер с атрибуцией, поэтому верх справа
// под контролами не перекрывает ни то, ни другое.
import { useEffect, useState } from "react";
import {
  fetchLiveMeta,
  liveClock,
  liveStale,
  type LiveMeta,
} from "./live-facts";

type Status = "loading" | "ok" | "missing";

export default function FactsBadge() {
  const [meta, setMeta] = useState<LiveMeta | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    const controller = new AbortController();
    fetchLiveMeta(controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setMeta(payload);
        setStatus(payload && !liveStale(payload) ? "ok" : "missing");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setMeta(null);
        setStatus("missing");
      });
    return () => controller.abort();
  }, []);

  const generated =
    meta && typeof meta.generated_at === "string" ? meta.generated_at : null;
  const clock = generated ? liveClock(generated) : null;
  const text =
    status === "ok" && clock
      ? `Данные на ${clock}`
      : status === "loading"
        ? "Данные · загрузка…"
        : "нет данных";
  const stale = status === "missing";

  return (
    <div
      data-facts-badge="1"
      data-facts-status={status}
      data-facts-time={generated ?? undefined}
      role="status"
      title="Городские факты: data.mos.ru, набор 2855 «действующие ордера», лицензия CC BY 4.0. Обновление раз в сутки; если данных нет или они старше 24 ч — пишем «нет данных»."
      className="absolute right-3 top-[7.5rem] z-20 flex select-none flex-col items-end gap-0.5 rounded-2xl bg-white/85 px-2.5 py-1.5 text-slate-700 shadow-sm backdrop-blur transition-colors dark:bg-slate-900/80 dark:text-slate-200"
    >
      <span
        className={`text-[11px] font-semibold leading-none ${
          stale ? "text-amber-700 dark:text-amber-400" : ""
        }`}
      >
        {text}
      </span>
      <span className="text-[10px] leading-none text-slate-500 dark:text-slate-400">
        data.mos.ru · факты
      </span>
    </div>
  );
}
