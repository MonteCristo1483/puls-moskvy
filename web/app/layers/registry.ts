// Реестр слоёв — единственное место, откуда карта узнаёт, что подключать.
// Порядок в массиве = порядок подключения; видимость по умолчанию берётся
// из `defaultVisible` (и чипа в панели слоёв, если `visibilityKey` задан).
import type { LayerPlugin } from "./contract";
import { factsLayer } from "./facts";
import { shadowsLayer } from "./shadows";
import { weatherLayer } from "./weather";

export const LAYERS: readonly LayerPlugin[] = [
  weatherLayer,
  shadowsLayer,
  factsLayer,
];

/** Все ключи чипов, которыми управляют слои (для панели и тестов). */
export const LAYER_VISIBILITY_KEYS = LAYERS.flatMap((layer) =>
  layer.visibilityKey ? [layer.visibilityKey] : [],
);
