// Реестр слоёв — единственное место, откуда карта узнаёт, что подключать.
// Порядок в массиве = порядок подключения; видимость по умолчанию берётся
// из `defaultVisible` (и чипа в панели слоёв, если `visibilityKey` задан).
import type { LayerPlugin } from "./contract";
import { atmosphereLayer } from "./atmosphere";
import { factsLayer } from "./facts";
import { shadowsLayer } from "./shadows";
import { weatherLayer } from "./weather";
import { worksCardLayer, worksLayer } from "./works";

export const LAYERS: readonly LayerPlugin[] = [
  weatherLayer,
  // Поток ветра живёт под чипом погоды, поэтому сразу после неё.
  atmosphereLayer,
  shadowsLayer,
  factsLayer,
  worksLayer,
  worksCardLayer,
];

/**
 * Все ключи чипов, которыми управляют слои (для панели и тестов).
 * `Set` — потому что с одним чипом может быть связано два слоя (погода и её
 * поток частиц), а ключ должен остаться один.
 */
export const LAYER_VISIBILITY_KEYS = Array.from(
  new Set(
    LAYERS.flatMap((layer) =>
      layer.visibilityKey ? [layer.visibilityKey] : [],
    ),
  ),
);
