// Доступность слоя (S9): «нет данных — нет слоя».
//
// Хост спрашивает `available` с настоящим контекстом, а панель слоёв карты,
// темы и времени не имеет — ей нужен только ответ по фактам. Чтобы не
// дублировать условие скрытия, оба места зовут один и тот же `available`:
// контекст-заглушка несёт снимок фактов, а остальные поля заполнены
// безопасными значениями. Контракт S9 и подразумевает проверку по `facts`.
import type { LayerContext, LayerPlugin } from "./contract";
import type { FactsSnapshot } from "./facts-store";

export function layerAvailable(
  layer: LayerPlugin,
  facts: FactsSnapshot,
): boolean {
  if (!layer.available) return true;
  const context: LayerContext = {
    getMap: () => null,
    theme: "light",
    time: { minutes: null, nowMinutes: 0 },
    weather: { get: () => null, at: () => null, subscribe: () => () => {} },
    facts: { get: () => facts, subscribe: () => () => {} },
  };
  return layer.available(context);
}
