// Очаги пыли (стройплощадки) — общий ресурс двух слоёв.
//
// Публикует слой «Тени и пыль» (у него есть доступ к redzones), читает слой
// «Поток ветра» и рисует шлейфы на общем canvas. Пока слой теней выключен,
// store пуст — пыли нет: видимость уважается без второй копии данных.
export type DustHotspot = { lon: number; lat: number };

const EMPTY: DustHotspot[] = [];

let hotspots: DustHotspot[] = EMPTY;
const listeners = new Set<() => void>();

export const dustStore = {
  get(): DustHotspot[] {
    return hotspots;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  publish(next: DustHotspot[]): void {
    hotspots = next.length > 0 ? next : EMPTY;
    for (const listener of [...listeners]) listener();
  },
  clear(): void {
    hotspots = EMPTY;
    for (const listener of [...listeners]) listener();
  },
};
