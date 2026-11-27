import type { Theme } from "./theme";
import { ICON_PATHS, type IconKey } from "./icons";
import { Chip } from "./design";
import { LAYERS } from "./layers/registry";

export type LayerKey =
  | "weather"
  | "shadows"
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
};

const ITEMS: { key: LayerKey; label: string; icon: IconKey }[] = [
  { key: "weather", label: "Погода и ветер", icon: "wind" },
  { key: "shadows", label: "Тени и пыль", icon: "shadows" },
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

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M20 13.6A8.1 8.1 0 0 1 10.4 4a8.1 8.1 0 1 0 9.6 9.6Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

export default function LayersPanel({
  visibility,
  onToggle,
  theme,
  onThemeToggle,
}: {
  visibility: Visibility;
  onToggle: (key: LayerKey) => void;
  theme: Theme;
  onThemeToggle: () => void;
}) {
  return (
    <div className="absolute left-3 top-[4.5rem] z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-1.5 xl:top-3">
      <button
        type="button"
        onClick={onThemeToggle}
        aria-label="Переключить тему"
        title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
        className="flex h-8 w-8 items-center justify-center rounded-pill bg-panel text-ink-quiet shadow-plate backdrop-blur transition-colors hover:bg-soft"
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
      <div className="flex flex-col items-start gap-1.5">
        {ITEMS.map(({ key, label, icon }) => (
          <Chip
            key={key}
            checked={visibility[key]}
            onToggle={() => onToggle(key)}
          >
            <LayerIcon d={ICON_PATHS[icon]} />
            <span>{label}</span>
          </Chip>
        ))}
      </div>
    </div>
  );
}
