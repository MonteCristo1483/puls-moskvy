import WeatherLayer from "../weather-layer";
import type { LayerPlugin } from "./contract";

/**
 * Слой «Погода и ветер»: плашка. Живёт как React-слой — час получает из
 * контекста; погоду публикует в общий стек (`weather-store`), поэтому другим
 * слоям (включая поток частиц) второй запрос не нужен.
 */
export const weatherLayer: LayerPlugin = {
  id: "weather",
  label: "Погода и ветер",
  defaultVisible: true,
  visibilityKey: "weather",
  View: ({ context }) => (
    <WeatherLayer visible minutes={context.time.minutes} />
  ),
};
