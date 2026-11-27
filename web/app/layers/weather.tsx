import WeatherLayer from "../weather-layer";
import type { LayerPlugin } from "./contract";

/**
 * Слой «Погода и ветер»: стрелки на карте и плашка. Живёт как React-слой —
 * карту, тему и час получает из контекста; погоду публикует в общий стек
 * (`weather-store`), поэтому другим слоям второй запрос не нужен.
 */
export const weatherLayer: LayerPlugin = {
  id: "weather",
  label: "Погода и ветер",
  defaultVisible: true,
  visibilityKey: "weather",
  View: ({ context }) => (
    <WeatherLayer
      visible
      theme={context.theme}
      minutes={context.time.minutes}
    />
  ),
};
