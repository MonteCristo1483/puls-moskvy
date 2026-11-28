// Контракт слоя (F3): слой — плагин, а не набор импортов в map.tsx.
//
// Слой получает `LayerContext` (карта, тема, время таймлайна, погода, факты),
// ставит на карту свои источники/фильтры и отдаёт `LayerHandle` для снятия.
// Изменения приходят двумя путями:
//   • React-слои (погода, тени, бейдж фактов) перерисовываются хостом —
//     `context` меняется, `View` получает новые значения;
//   • императивные слои подписываются на `onTimeChange` / `onWeather` /
//     `onTheme` — хост зовёт их при каждом изменении.
// Подробное описание и порядок добавления слоя — docs/ARCHITECTURE.md §2.5.
import type { Map as MapLibreMap } from "maplibre-gl";
import type { ReactNode } from "react";
import type { FactsSnapshot } from "./facts-store";
import type { LayerKey } from "../layers-panel";
import type { WeatherSnapshot, WeatherValues } from "../live-weather";
import type { Theme } from "../theme";

/** Идентификатор слоя: строка, но известные собраны для автодополнения. */
export type LayerId = "weather" | "shadows" | "facts" | (string & {});

/**
 * Погода, доступная любому слою: снимок «сейчас» (с часовым рядом) и значение
 * на выбранный час. Наполняет её слой погоды; остальные только читают.
 */
export type LayerWeather = {
  get(): WeatherSnapshot | null;
  at(minutes: number | null): WeatherValues | null;
  subscribe(listener: (snapshot: WeatherSnapshot | null) => void): () => void;
};

/**
 * Городские факты (`live/meta.json`): дата данных и признак устаревания.
 * Слой фактов их загружает, остальные слои читают.
 */
export type LayerFacts = {
  get(): FactsSnapshot;
  subscribe(listener: () => void): () => void;
};

/** Всё, что хост даёт слою при подключении. */
export type LayerContext = {
  /** Карта MapLibre; null — карта ещё создаётся (ждите `load`). */
  getMap(): MapLibreMap | null;
  readonly theme: Theme;
  readonly time: {
    /** Выбранный час таймлайна, минуты от полуночи; null — живой режим. */
    readonly minutes: number | null;
    /** Текущие московские минуты от полуночи. */
    readonly nowMinutes: number;
  };
  readonly weather: LayerWeather;
  readonly facts: LayerFacts;
};

/** Дескриптор подключённого слоя: хост зовёт `unmount` при отключении. */
export type LayerHandle = { unmount(): void };

export type LayerViewProps = { context: LayerContext };

/**
 * Слой. `mount`/`unmount`/`on*` — для императивной части (источники и слои
 * MapLibre, слушатели, таймеры); `View` — React-часть поверх карты (плашка,
 * бейдж). Минимум — одно из двух.
 */
export type LayerPlugin = {
  readonly id: LayerId;
  /** Подпись для панели слоёв и документации. */
  readonly label: string;
  /** Состояние чипа по умолчанию (и видимость, если чипа нет). */
  readonly defaultVisible: boolean;
  /** Ключ чипа в панели слоёв; undefined — чипа нет (факты). */
  readonly visibilityKey?: LayerKey;
  /**
   * S9: можно ли показывать слой. `false` — данных нет или они устарели:
   * хост не монтирует слой (и снимает уже смонтированный), панель прячет чип.
   * Пока факты загружаются (`status === "loading"`), слой считается доступным,
   * иначе чип мигал бы на каждой загрузке.
   */
  available?(context: LayerContext): boolean;
  /** Подключение: источники, слои карты, слушатели. */
  mount?(context: LayerContext): LayerHandle | void;
  /** Освобождение ресурсов, не привязанных к дескриптору. */
  unmount?(): void;
  /** Сменился час таймлайна (null — живой режим). */
  onTimeChange?(minutes: number | null): void;
  /** Пришла/обновилась погода (null — данных нет). */
  onWeather?(snapshot: WeatherSnapshot | null): void;
  /** Сменилась тема `data-theme`. */
  onTheme?(theme: Theme): void;
  /** UI слоя поверх карты. */
  readonly View?: (props: LayerViewProps) => ReactNode;
};
