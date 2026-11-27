import { ICON_PATHS, type IconKey } from "./icons";
import { Chip, ChipButton } from "./design";
import { LAYERS } from "./layers/registry";

export type LayerKey =
  | "weather"
  | "shadows"
  | "works"
  | "schools"
  | "kindergartens"
  | "parks"
  | "metro"
  | "shops"
  | "redzones"
  | "routes";

export type Visibility = Record<LayerKey, boolean>;

/** «Включён по умолчанию» для чипов, чей слой живёт в движке карты. */
const ENGINE_DEFAULTS = {
  schools: true,
  kindergartens: true,
  parks: true,
  metro: true,
  shops: false,
  redzones: true,
  routes: false,
} as const;

/** Состояние чипа по умолчанию объявляет сам слой (`defaultVisible`). */
function layerDefault(key: LayerKey): boolean {
  const layer = LAYERS.find((item) => item.visibilityKey === key);
  if (!layer) throw new Error(`чип «${key}» не привязан к слою в реестре`);
  return layer.defaultVisible;
}

export const DEFAULT_VISIBILITY: Visibility = {
  ...ENGINE_DEFAULTS,
  weather: layerDefault("weather"),
  // Тени — тяжёлый слой (пересчёт по кадру), поэтому по умолчанию выключен.
  shadows: layerDefault("shadows"),
  // Работы — 4109 объектов из набора 2855: по умолчанию не грузим их всем.
  works: layerDefault("works"),
};

const ITEMS: {
  key: LayerKey;
  label: string;
  icon: IconKey;
  /** Переключать кнопкой-пилюлей, а не настоящим чекбоксом. */
  button?: boolean;
}[] = [
  { key: "weather", label: "Погода и ветер", icon: "wind" },
  { key: "shadows", label: "Тени и пыль", icon: "shadows" },
  { key: "works", label: "Стройки и работы", icon: "works", button: true },
  { key: "schools", label: "Школы", icon: "school" },
  { key: "kindergartens", label: "Сады", icon: "kindergarten" },
  { key: "parks", label: "Парки", icon: "park" },
  { key: "metro", label: "Метро", icon: "subway_entrance" },
  { key: "shops", label: "Магазины", icon: "shop" },
  { key: "redzones", label: "Красные зоны", icon: "redzones" },
  { key: "routes", label: "Маршруты", icon: "routes" },
];

function LayerIcon({ d }: { d: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-icon"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

export default function LayersPanel({
  visibility,
  onToggle,
}: {
  visibility: Visibility;
  onToggle: (key: LayerKey) => void;
}) {
  return (
    <div className="absolute left-3 top-[4.5rem] z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-1.5 xl:top-3">
      <div className="flex flex-col items-start gap-1.5">
        {ITEMS.map(({ key, label, icon, button }) => {
          const content = (
            <>
              <LayerIcon d={ICON_PATHS[icon]} />
              <span>{label}</span>
            </>
          );
          // Слой работ — кнопка-переключатель: он не чекбокс формы, а
          // включение слоя по клику (ChipButton, тот же материал, aria-pressed).
          return button ? (
            <ChipButton
              key={key}
              checked={visibility[key]}
              onToggle={() => onToggle(key)}
            >
              {content}
            </ChipButton>
          ) : (
            <Chip
              key={key}
              checked={visibility[key]}
              onToggle={() => onToggle(key)}
            >
              {content}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
