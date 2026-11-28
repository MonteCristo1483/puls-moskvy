"use client";

// Хост слоёв: единственная точка, где map.tsx встречается с реестром.
// Он собирает `LayerContext` (карта, тема, время, погода, факты), зовёт у
// плагинов `mount`/`unmount` и `on*`-хуки и рендерит `View` видимых слоёв.
// Плашки и панели слоёв остаются абсолютно позиционированными относительно
// карты: обёртка `contents` не создаёт бокс и не меняет геометрию.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { Visibility } from "../layers-panel";
import { moscowClockMinutes } from "../solar";
import type { Theme } from "../theme";
import { layerAvailable } from "./availability";
import type { LayerContext, LayerPlugin } from "./contract";
import { factsStore, initialFacts } from "./facts-store";
import { LAYERS } from "./registry";
import { weatherStore } from "./weather-store";

/** Карта создаётся движком асинхронно и живёт в window.__map. */
function readMap(): MapLibreMap | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { __map?: MapLibreMap }).__map ?? null;
}

function LayerSlot({
  layer,
  context,
}: {
  layer: LayerPlugin;
  context: LayerContext;
}) {
  // Слой подключается один раз: свежий контекст нужен mount, а дальше
  // изменения приходят через on*-хуки и перерисовку View.
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    const handle = layer.mount?.(contextRef.current);
    return () => {
      handle?.unmount();
      layer.unmount?.();
    };
  }, [layer]);

  useEffect(() => {
    layer.onTheme?.(context.theme);
  }, [layer, context.theme]);

  useEffect(() => {
    layer.onTimeChange?.(context.time.minutes);
  }, [layer, context.time.minutes]);

  useEffect(() => {
    if (!layer.onWeather) return;
    layer.onWeather(weatherStore.get());
    return weatherStore.subscribe((snapshot) => layer.onWeather?.(snapshot));
  }, [layer]);

  if (!layer.View) return null;
  return <layer.View context={context} />;
}

export default function LayerHost({
  visible,
  theme,
  minutes,
}: {
  visible: Visibility;
  theme: Theme;
  /** Выбранный час таймлайна, минуты от полуночи; null — живой режим. */
  minutes: number | null;
}) {
  // nowMinutes пересчитывается вместе с временем — слою нужен «сейчас» для
  // честной подписи «факт/прогноз», а не время последнего рендера.
  const context = useMemo<LayerContext>(
    () => ({
      getMap: readMap,
      theme,
      time: {
        minutes,
        nowMinutes: Math.floor(moscowClockMinutes(Date.now())),
      },
      weather: weatherStore,
      facts: factsStore,
    }),
    [theme, minutes],
  );

  // S9: доступность зависит от фактов, а не от видимости чипа. Подписка на
  // store перерисовывает хост, когда `meta.json` догрузился; если слой стал
  // недоступен, слот исчезает и его `mount`-cleanup снимает источники/слои.
  const facts = useSyncExternalStore(
    factsStore.subscribe,
    factsStore.get,
    () => initialFacts,
  );

  return (
    <div className="contents">
      {LAYERS.map((layer) => {
        const shown = layer.visibilityKey
          ? visible[layer.visibilityKey]
          : layer.defaultVisible;
        if (!shown) return null;
        if (!layerAvailable(layer, facts)) return null;
        return <LayerSlot key={layer.id} layer={layer} context={context} />;
      })}
    </div>
  );
}
