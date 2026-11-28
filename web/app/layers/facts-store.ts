// Городские факты как общий ресурс слоёв (часть LayerContext).
//
// Читает `live/meta.json`, который раз в сутки обновляет
// `.github/workflows/live-data.yml`. Слой фактов — единственный писатель
// (`load`), бейдж и будущие слои только читают.
//
// S9 различает две разные беды, и машинный признак обязан их различать:
//   • `missing` — файла нет или ответ не разобрался (`meta.json` не пришёл);
//   • `stale`   — файл есть, но данные старше 24 ч (`stale: true` в нём тоже
//                 устаревание): дата честная, свежесть обещать нельзя.
// Для человека оба случая по-прежнему значат «слой работ недоступен», но
// потребитель признака видит, чего именно не хватает.
import {
  fetchLiveMeta,
  liveClock,
  liveStale,
  type LiveMeta,
} from "../live-facts";

/**
 * Состояние фактов: `loading` — до первого ответа, `ok` — свежие данные,
 * `stale` — файл есть, но данные устарели, `missing` — файла нет.
 */
export type FactsStatus = "loading" | "ok" | "stale" | "missing";

export type FactsSnapshot = {
  status: FactsStatus;
  meta: LiveMeta | null;
  /** `generated_at` из meta.json — как пришёл, без разбора. */
  generated: string | null;
  /** «27.11 09:14» — дата данных в МСК. */
  clock: string | null;
  /**
   * Данные отсутствуют или старше суток: обещать свежесть нельзя. Выводится
   * из `status` (`missing` тоже `true`), чтобы скрытие слоя и цвет бейджа
   * остались прежними для обоих случаев.
   */
  stale: boolean;
};

/** `stale` — производный признак «обещать свежесть нельзя». */
function isStaleStatus(status: FactsStatus): boolean {
  return status !== "ok" && status !== "loading";
}

/** Состояние до первого ответа: бейдж сразу что-то показывает. */
export const initialFacts: FactsSnapshot = {
  status: "loading",
  meta: null,
  generated: null,
  clock: null,
  stale: false,
};

let current: FactsSnapshot = initialFacts;
const listeners = new Set<() => void>();

export const factsStore = {
  get: (): FactsSnapshot => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  publish(next: FactsSnapshot): void {
    current = next;
    for (const listener of [...listeners]) listener();
  },
};

/** Загрузить `live/meta.json`; отмена — через `signal` (unmount слоя). */
export function loadFacts(signal: AbortSignal): void {
  fetchLiveMeta(signal)
    .then((payload) => {
      if (signal.aborted) return;
      const generated =
        payload && typeof payload.generated_at === "string"
          ? payload.generated_at
          : null;
      const status: FactsStatus =
        payload === null ? "missing" : liveStale(payload) ? "stale" : "ok";
      factsStore.publish({
        status,
        meta: payload,
        generated,
        clock: generated ? liveClock(generated) : null,
        stale: isStaleStatus(status),
      });
    })
    .catch(() => {
      if (signal.aborted) return;
      // Запрос не дошёл — файла у нас нет: это `missing`, а не `stale`.
      factsStore.publish({
        status: "missing",
        meta: null,
        generated: null,
        clock: null,
        stale: isStaleStatus("missing"),
      });
    });
}
