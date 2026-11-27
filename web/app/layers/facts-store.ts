// Городские факты как общий ресурс слоёв (часть LayerContext).
//
// Читает `live/meta.json`, который раз в сутки обновляет
// `.github/workflows/live-data.yml`; файла нет или данные старше 24 ч —
// «нет данных» (ARCHITECTURE §2, S9). Слой фактов — единственный писатель
// (`load`), бейдж и будущие слои только читают.
import {
  fetchLiveMeta,
  liveClock,
  liveStale,
  type LiveMeta,
} from "../live-facts";

export type FactsStatus = "loading" | "ok" | "missing";

export type FactsSnapshot = {
  status: FactsStatus;
  meta: LiveMeta | null;
  /** `generated_at` из meta.json — как пришёл, без разбора. */
  generated: string | null;
  /** «27.11 09:14» — дата данных в МСК. */
  clock: string | null;
  /** Данные отсутствуют или старше суток: обещать свежесть нельзя. */
  stale: boolean;
};

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
        payload && !liveStale(payload) ? "ok" : "missing";
      factsStore.publish({
        status,
        meta: payload,
        generated,
        clock: generated ? liveClock(generated) : null,
        stale: status === "missing",
      });
    })
    .catch(() => {
      if (signal.aborted) return;
      factsStore.publish({
        status: "missing",
        meta: null,
        generated: null,
        clock: null,
        stale: true,
      });
    });
}
