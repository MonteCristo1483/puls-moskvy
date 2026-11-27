import FactsBadge from "../facts-badge";
import type { LayerPlugin } from "./contract";
import { loadFacts } from "./facts-store";

/**
 * Слой «Городские факты»: без слоя на карте — только бейдж даты и источник.
 * Императивная часть (загрузка `live/meta.json`) — в `mount`: по контракту
 * слой сам владеет своими запросами и отменяет их в `unmount`.
 */
export const factsLayer: LayerPlugin = {
  id: "facts",
  label: "Городские факты",
  defaultVisible: true,
  mount() {
    const controller = new AbortController();
    loadFacts(controller.signal);
    return { unmount: () => controller.abort() };
  },
  View: () => <FactsBadge />,
};
