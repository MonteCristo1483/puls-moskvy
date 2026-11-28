import AtmosphereOverlay from "../atmosphere/atmosphere-overlay";
import type { LayerPlugin } from "./contract";

/**
 * «Поток ветра»: частицы на canvas вместо стрелок-символов. Своего чипа нет —
 * слой живёт под чипом «Погода и ветер» (`visibilityKey: "weather"`), поэтому
 * выключение погоды гасит и поток. Данные читает из общего стека погоды, второй
 * запрос не нужен.
 */
export const atmosphereLayer: LayerPlugin = {
  id: "atmosphere",
  label: "Поток ветра",
  defaultVisible: true,
  visibilityKey: "weather",
  View: ({ context }) => <AtmosphereOverlay context={context} />,
};
