// Погода как общий ресурс слоёв (часть LayerContext).
//
// Слой погоды — единственный писатель (`publish`): один запрос на координаты
// живёт в кэше live-weather, поэтому читателям не нужно ходить в сеть.
import { weatherAt, type WeatherSnapshot, type WeatherValues } from "../live-weather";
import type { LayerWeather } from "./contract";

let snapshot: WeatherSnapshot | null = null;
const listeners = new Set<(next: WeatherSnapshot | null) => void>();

export const weatherStore: LayerWeather & {
  publish(next: WeatherSnapshot): void;
} = {
  get: () => snapshot,
  at: (minutes: number | null): WeatherValues | null => weatherAt(snapshot, minutes),
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  publish(next) {
    snapshot = next;
    for (const listener of [...listeners]) listener(snapshot);
  },
};
