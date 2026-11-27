"use client";

// Карточка объекта «Стройки и работы» (S7).
//
// Показывает только поля набора 2855 и у каждого факта — провенанс: источник
// (data.mos.ru, набор 2855 ссылкой), дата данных из `live/meta.json` в МСК.
// Пустое/отсутствующее поле пишется словами «в источнике не указано», адрес
// по геометрии не восстанавливается. Особый случай набора: `address` пуст у
// 90% объектов — тогда местом служат `work_place` и `district`.
//
// Состояние открытой карточки — в URL (`?work=<global_id>`): ссылка переносится
// на другое устройство и открывает карточку. Оформление — только токены и
// примитивы из `design/` (Panel): никаких hex и произвольных кеглей.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { LayerFacts } from "./layers/contract";
import { initialFacts } from "./layers/facts-store";
import {
  closeWork,
  initialWorks,
  openWork,
  readWorkParam,
  workShareUrl,
  worksStore,
  WORK_SOURCE_DATASET,
  WORK_SOURCE_URL,
  type WorkProperties,
} from "./layers/works-store";
import { Panel } from "./design";

/** Единая формулировка для поля, которого нет в источнике. */
export const WORK_MISSING = "в источнике не указано";

type Fact = { label: string; value: string | null };

/** Непустая строка источника; пустое/не строковое — null (а не «»). */
function sourceText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Списки `work_type`/`order_work` — через «; »; пустой список — null. */
function sourceList(value: unknown): string | null {
  if (!Array.isArray(value)) return sourceText(value);
  const items = value
    .map((item) => sourceText(item))
    .filter((item): item is string => item !== null);
  return items.length ? items.join("; ") : null;
}

/** `2026-09-07` → `07.09.2026`; прочие значения — как пришли из источника. */
function formatDate(value: unknown): string | null {
  const raw = sourceText(value);
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : raw;
}

/** Срок работ: обе даты, одна или ни одной — без выдуманного второго конца. */
function workPeriod(properties: WorkProperties): string | null {
  const start = formatDate(properties.work_start_date);
  const end = formatDate(properties.work_end_date);
  if (start && end) return `${start} — ${end}`;
  if (start) return `с ${start}; окончание — ${WORK_MISSING}`;
  if (end) return `до ${end}; начало — ${WORK_MISSING}`;
  return null;
}

/** Факты карточки — ровно из properties, без подстановок. */
function factsOf(properties: WorkProperties): Fact[] {
  const address = sourceText(properties.address);
  const workPlace = sourceText(properties.work_place);
  const facts: Fact[] = [];
  if (address) facts.push({ label: "Адрес", value: address });
  facts.push({ label: "Место работ", value: workPlace });
  facts.push({ label: "Район", value: sourceText(properties.district) });
  facts.push({ label: "Округ", value: sourceText(properties.adm_area) });
  facts.push({ label: "Срок работ", value: workPeriod(properties) });
  facts.push({ label: "Что делают", value: sourceList(properties.work_type) });
  facts.push({ label: "Работы по ордеру", value: sourceList(properties.order_work) });
  facts.push({ label: "Заказчик", value: sourceText(properties.customer) });
  facts.push({ label: "Ордер", value: sourceText(properties.order_number) });
  facts.push({ label: "Дата ордера", value: formatDate(properties.order_date) });
  return facts;
}

/** Дата данных в МСК из `live/meta.json`; устаревание не скрывает дату. */
function dataDateLabel(facts: { clock: string | null; status: string }): string {
  if (facts.clock) return `данные на ${facts.clock} МСК`;
  return facts.status === "loading" ? "дата данных загружается…" : "дата данных неизвестна";
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M1 1l12 12M13 1L1 13"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function WorkCard({ facts }: { facts: LayerFacts }) {
  const state = useSyncExternalStore(
    worksStore.subscribe,
    worksStore.get,
    () => initialWorks,
  );
  const factsState = useSyncExternalStore(
    facts.subscribe,
    facts.get,
    () => initialFacts,
  );
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  // Ссылка `?work=<id>` открывает карточку без клика по карте.
  useEffect(() => {
    const id = readWorkParam();
    if (id) openWork(id, { syncUrl: false });
  }, []);

  useEffect(() => {
    setCopied("idle");
  }, [state.selectedId]);

  if (state.selectedId === null) return null;

  const id = state.selectedId;
  const feature = state.data?.byId[id] ?? null;
  const properties: WorkProperties = feature?.properties ?? {};
  const dateLabel = dataDateLabel(factsState);
  // Провенанс каждого факта: источник + дата данных (МСК), одной строкой.
  const provenance = `data.mos.ru, набор ${WORK_SOURCE_DATASET} · ${dateLabel}`;
  const factsRows = feature ? factsOf(properties) : [];
  const title =
    sourceText(properties.address) ??
    sourceText(properties.work_place) ??
    "Объект работ";
  const place = [sourceText(properties.district), sourceText(properties.adm_area)]
    .filter((value): value is string => value !== null)
    .join(" · ");

  const share = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard");
      await navigator.clipboard.writeText(workShareUrl(id));
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  };

  const body = (() => {
    if (feature) {
      return (
        <dl className="mt-2 flex flex-col">
          {factsRows.map((fact) => (
            <div
              key={fact.label}
              data-work-fact="1"
              className="flex flex-col gap-0.5 border-t border-border py-1.5 first:border-t-0 first:pt-0"
            >
              <dt className="text-10 font-medium uppercase tracking-wide text-ink-3">
                {fact.label}
              </dt>
              <dd
                className={`text-12 leading-snug ${
                  fact.value ? "text-ink" : "text-ink-3"
                }`}
              >
                {fact.value ?? WORK_MISSING}
              </dd>
              <a
                href={WORK_SOURCE_URL}
                target="_blank"
                rel="noreferrer"
                className="text-9 leading-tight text-ink-3 underline decoration-border underline-offset-2"
              >
                {provenance}
              </a>
            </div>
          ))}
        </dl>
      );
    }
    if (state.status === "loading" || state.status === "idle") {
      return (
        <p className="mt-2 text-12 leading-snug text-ink-2">
          Загружаем объект из источника…
        </p>
      );
    }
    if (state.status === "missing") {
      return (
        <p className="mt-2 text-12 leading-snug text-ink-2">
          Не удалось загрузить works.geojson — данных нет. Карточка не подставляет
          факты из воздуха.
        </p>
      );
    }
    return (
      <p className="mt-2 text-12 leading-snug text-ink-2">
        Объект с global_id {id} в наборе не найден.
      </p>
    );
  })();

  return (
    <div
      data-work-card="1"
      data-work-id={id}
      data-work-status={state.status}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-20 md:inset-x-auto md:bottom-4 md:right-4 md:top-4 md:w-[min(92vw,400px)]"
    >
      <Panel
        role="region"
        aria-label="Карточка объекта работ"
        className="pointer-events-auto mx-auto flex max-h-[70dvh] w-full max-w-md flex-col overflow-hidden md:mx-0 md:h-full md:max-h-none md:max-w-none"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-10 font-semibold uppercase tracking-wide text-ink-3">
                Стройки и работы
              </div>
              <h2 className="mt-0.5 text-15 font-bold leading-snug text-ink">
                {title}
              </h2>
              {place && (
                <div className="mt-0.5 text-11 leading-tight text-ink-2">{place}</div>
              )}
            </div>
            <button
              type="button"
              onClick={closeWork}
              aria-label="Закрыть карточку объекта"
              className="shrink-0 rounded-pill p-1 text-ink-3 transition-colors hover:bg-soft hover:text-ink-2"
            >
              <CloseIcon />
            </button>
          </div>

          <div className="mt-2 flex flex-col gap-0.5 rounded-control bg-soft px-2 py-1">
            <a
              data-work-source
              href={WORK_SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-11 font-semibold text-accent-ink underline decoration-accent/40 underline-offset-2"
            >
              data.mos.ru, набор {WORK_SOURCE_DATASET}
            </a>
            <span data-work-date className="text-10 leading-tight text-ink-2">
              {dateLabel}
            </span>
          </div>

          {body}

          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => void share()}
              className="rounded-control bg-accent px-2.5 py-1.5 text-11 font-semibold text-accent-contrast transition-colors hover:bg-accent-ink"
            >
              Скопировать ссылку
            </button>
            <span className="text-9 leading-none text-ink-3">global_id {id}</span>
          </div>
          {copied === "ok" && (
            <div className="mt-1 text-10 text-ink-2">Ссылка скопирована</div>
          )}
          {copied === "fail" && (
            <div className="mt-1 text-10 leading-snug text-warn-ink">
              Буфер обмена недоступен — скопируйте адрес из строки браузера.
            </div>
          )}

          <p className="mt-2 text-9 leading-tight text-ink-3">
            Все факты — из набора {WORK_SOURCE_DATASET} «действующие ордера»
            (data.mos.ru). Поля, которых нет в источнике, отмечены как
            «{WORK_MISSING}»; адрес по геометрии не восстанавливается.
          </p>
        </div>
      </Panel>
    </div>
  );
}
