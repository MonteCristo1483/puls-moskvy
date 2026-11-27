import ShadowsLayer from "../shadows-layer";
import type { LayerPlugin } from "./contract";

/**
 * Слой «Тени и пыль»: fill-слой теней под домами и стрелки пыли над стройками
 * плюс плашка замера. React-слой: карта, тема и час — из контекста.
 */
export const shadowsLayer: LayerPlugin = {
  id: "shadows",
  label: "Тени и пыль",
  defaultVisible: false,
  visibilityKey: "shadows",
  View: ({ context }) => (
    <ShadowsLayer
      visible
      theme={context.theme}
      minutes={context.time.minutes}
    />
  ),
};
