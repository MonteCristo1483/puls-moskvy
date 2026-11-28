"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import AboutData from "./about-data";
import BuildingSheet from "./building-sheet";
import type { BuildingBreakdown, SelectedBuilding } from "./building-sheet";
import LayerHost from "./layers/host";
import LayersPanel, { DEFAULT_VISIBILITY } from "./layers-panel";
import type { Visibility } from "./layers-panel";
import SearchBox from "./search-box";
import type { SearchItem } from "./search-box";
import { readThemeOverride, themeForTime } from "./daylight";
import { initialTheme } from "./theme";
import type { Theme } from "./theme";
import { moscowClockMinutes } from "./solar";
import Timeline, { readTimelineParam, writeTimelineParam } from "./timeline";
import { readWorkParam } from "./layers/works-store";
import { mountMap } from "./map/engine";
import { ISOCHRONE_URL, fetchGzipJson } from "./map/tiles";
import type { BuildingRoutes, FlatRoutes, IsoGeometry, IsochroneData } from "./map/tiles";

// Воркер maplibre отдаём статикой из public/ — bundlers не резолвят
// его динамический URL (Turbopack и webpack одинаково).
maplibregl.setWorkerUrl("maplibre-gl-worker.mjs");

// В MapLibre v6 по умолчанию один web-воркер на страницу: декод тайлов всех
// источников (buildings/basemap/overlays) идёт в очередь. Включаем 4 на
// десктопе и 2 на мобиле (меньше памяти). Вызывать до создания Map.
if (typeof window !== "undefined") {
  const mobile =
    window.matchMedia("(pointer: coarse)").matches ||
    window.innerWidth < 768 ||
    window.devicePixelRatio >= 2;
  maplibregl.setWorkerCount(mobile ? 2 : Math.min(4, navigator.hardwareConcurrency || 1));
}

export default function Map() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<SelectedBuilding | null>(null);
  const [visible, setVisible] = useState<Visibility>(DEFAULT_VISIBILITY);
  // S4: выбранный час таймлайна (минуты от полуночи, МСК) или null — «сейчас».
  // Живёт в URL (`?t=HH:MM`); состояние начального рендера — живой режим,
  // параметр читаем в эффекте ниже (на сервере window нет).
  const [clockMinutes, setClockMinutes] = useState<number | null>(null);
  const [searchItems, setSearchItems] = useState<SearchItem[]>([]);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nonHomeNotice, setNonHomeNotice] = useState<{
    point: [number, number];
    status: "idle" | "loading" | "error" | "far";
  } | null>(null);
  // D3: тема выводится из времени, а не выбирается пользователем.
  // Начальное значение стабильно для SSR/гидрации, реальное ставит эффект.
  const [theme, setTheme] = useState<Theme>("light");
  // Текущее московское время в минутах для живого режима; null до монтирования.
  const [nowMinutes, setNowMinutes] = useState<number | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  // Splash: "show" → "fade" (карта готова или 2 с) → "gone".
  const [splash, setSplash] = useState<"show" | "fade" | "gone">("show");
  // S10: экран «О данных» открывают две кнопки — плашка «© OpenStreetMap» на
  // карте и футер-строка. Фокус возвращаем на ту, с которой открыли.
  const [aboutOpen, setAboutOpen] = useState(false);
  const aboutOpenerRef = useRef<HTMLElement | null>(null);
  // Perf-1: оверлей диагностики включается только `?perf=1` (см. эффект ниже).
  const [perfEnabled, setPerfEnabled] = useState(false);
  const perfRef = useRef<HTMLDivElement | null>(null);
  const deselectRef = useRef<(() => void) | null>(null);
  const selectRef = useRef<((id: number) => void) | null>(null);
  const loadSearchIndexRef = useRef<(() => Promise<void>) | null>(null);
  const findNearestHomeRef = useRef<((point: [number, number]) => Promise<void>) | null>(null);
  const applyVisibilityRef = useRef<((v: Visibility) => void) | null>(null);
  const applyThemeRef = useRef<((t: Theme) => void) | null>(null);
  const selectedRef = useRef<SelectedBuilding | null>(null);
  const visibleRef = useRef<Visibility>(DEFAULT_VISIBILITY);
  // Маршруты выбранного здания (Valhalla) и кэш по id.
  // TS7 (tsgo): глобальный new Map<K,V>() ломается TS7009 — Record (decisions.md).
  // undefined = не запрашивали, null = файла нет (не повторять), иначе маршруты.
  const routesRef = useRef<FlatRoutes | null>(null);
  const routesCacheRef = useRef<Record<number, FlatRoutes | null>>({});
  const routesShardCacheRef = useRef<
    Record<string, Promise<Record<string, BuildingRoutes> | null>>
  >({});
  // breakdown из routes/<id>.json (режим тайлов): undefined = не запрашивали.
  const breakdownCacheRef = useRef<Record<number, BuildingBreakdown | null>>({});
  // Изохрона: минуты выбраны в карточке, геометрия — по файлу дома.
  const [contour, setContour] = useState<number | null>(null);
  const isoShardCacheRef = useRef<
    Record<string, Promise<Record<string, IsochroneData> | null>>
  >({});
  const districtByBuildingRef = useRef<Record<number, number>>({});
  const isoGeomRef = useRef<IsoGeometry | null>(null);
  const setIsoSourceRef = useRef<((geom: IsoGeometry | null) => void) | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  // Реальная тема для карты доступна сразу (карта — клиент-only): её считает
  // тот же initialTheme(), что и эффект ниже.
  const themeRef = useRef<Theme>(initialTheme());

  const updateSelected = (b: SelectedBuilding | null) => {
    selectedRef.current = b;
    setSelected(b);
  };

  // S10: «О данных» — один диалог на две точки входа (плашка на карте и
  // футер-строка). Запоминаем открывшую кнопку, чтобы вернуть ей фокус.
  const openAbout = (event: MouseEvent<HTMLButtonElement>) => {
    aboutOpenerRef.current = event.currentTarget;
    setAboutOpen(true);
  };

  const closeAbout = () => {
    setAboutOpen(false);
    const opener = aboutOpenerRef.current;
    aboutOpenerRef.current = null;
    if (opener) window.requestAnimationFrame(() => opener.focus());
  };

  // S4: состояние таймлайна — только URL (`?t=HH:MM`). Читаем при загрузке,
  // пишем через history.replaceState: без перезагрузки и без сервера.
  useEffect(() => {
    setClockMinutes(readTimelineParam(window.location.search));
  }, []);

  // S7: ссылка на объект работ (?work=) включает слой «Стройки и работы».
  // Иначе deep link открыл бы карточку на карте без самих работ: человек не
  // видит объект, о котором читает. Слой по-прежнему живёт в реестре, здесь —
  // только синхронизация URL с общим состоянием видимости (как у `?t=`).
  useEffect(() => {
    if (readWorkParam() === null) return;
    setVisible((current) =>
      current.works ? current : { ...current, works: true },
    );
  }, []);

  const changeClockMinutes = (next: number | null) => {
    setClockMinutes(next);
    writeTimelineParam(next);
  };

  const showNotice = (message: string) => {
    setNotice(message);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice((current) => (current === message ? null : current));
      noticeTimerRef.current = null;
    }, 4000);
  };

  // Splash: после fade убираем элемент из DOM.
  useEffect(() => {
    if (splash !== "fade") return;
    const t = window.setTimeout(() => setSplash("gone"), 350);
    return () => window.clearTimeout(t);
  }, [splash]);

  useEffect(() => {
    visibleRef.current = visible;
    applyVisibilityRef.current?.(visible);
  }, [visible]);

  // Изохрона выбранного дома: файл грузим один раз, кэшируем по id.
  // null в contour — зона выключена; смена дома на том же времени просто
  // перерисовывает другую геометрию.
  useEffect(() => {
    let cancelled = false;
    const id = selected?.id ?? null;
    const apply = (data: IsochroneData | null) => {
      if (cancelled) return;
      const geom =
        id !== null && contour !== null ? data?.[String(contour)] ?? null : null;
      isoGeomRef.current = geom;
      setIsoSourceRef.current?.(geom);
    };
    if (id === null || contour === null) {
      apply(null);
      return;
    }
    const districtId = districtByBuildingRef.current[id];
    if (districtId === undefined) {
      apply(null);
      return;
    }
    const key = `${districtId}/${id % 16}`;
    const shard =
      isoShardCacheRef.current[key] ??
      (isoShardCacheRef.current[key] = fetchGzipJson<
        Record<string, IsochroneData>
      >(ISOCHRONE_URL(districtId, id % 16)).catch(() => null));
    void shard.then((data) => apply(data?.[String(id)] ?? null));
    return () => {
      cancelled = true;
    };
  }, [selected?.id, contour]);

  // D3: в живом режиме («Сейчас») тикаем раз в минуту, чтобы на рассвете
  // тема сменилась сама, без перезагрузки. При выбранном часе таймлайна
  // время фиксировано и тикать не нужно.
  useEffect(() => {
    if (clockMinutes !== null) return;
    const sync = () => setNowMinutes(Math.floor(moscowClockMinutes(Date.now())));
    sync();
    const timer = window.setInterval(sync, 60_000);
    return () => window.clearInterval(timer);
  }, [clockMinutes]);

  // Тема — следствие времени: выбранный час таймлайна, в живом режиме —
  // текущее московское время. `?theme=` — детерминированный оверрайд для
  // тестов и скриншотов, он сильнее расчёта по Солнцу.
  // applyThemeRef перекрашивает слои и 3D, поэтому зовём только при смене.
  useEffect(() => {
    const override = readThemeOverride(window.location.search);
    const minutes = clockMinutes ?? nowMinutes;
    let next: Theme;
    if (override !== null) next = override;
    else if (minutes === null) return;
    else next = themeForTime(minutes);

    document.documentElement.dataset.theme = next;
    if (themeRef.current !== next) {
      themeRef.current = next;
      applyThemeRef.current?.(next);
    }
    setTheme(next);
  }, [clockMinutes, nowMinutes]);

  // ── Перф-оверлей (?perf=1) ─────────────────────────────────────────────
  // Диагностика клиента: FPS по rAF, p95 кадра, число загруженных тайлов и
  // трафик PMTiles из PerformanceResourceTiming. В обычном режиме выключен
  // и на прод-вид не влияет: DOM создаётся только при `?perf=1`.
  useEffect(() => {
    setPerfEnabled(
      new URLSearchParams(window.location.search).get("perf") === "1",
    );
  }, []);

  useEffect(() => {
    if (!perfEnabled) return;
    const el = perfRef.current;
    if (!el) return;

    // Окно кадров ~4 с: FPS = 1000/среднее, p95 — 95-й процентиль длительности.
    const frameTimes: number[] = [];
    let lastFrame = performance.now();
    let rafId = 0;
    const onFrame = (now: number) => {
      const dt = now - lastFrame;
      lastFrame = now;
      if (dt > 0 && dt < 1000) {
        frameTimes.push(dt);
        if (frameTimes.length > 240) frameTimes.shift();
      }
      rafId = requestAnimationFrame(onFrame);
    };
    rafId = requestAnimationFrame(onFrame);

    // Загруженные тайлы: уникальные z/x/y из sourcedata для PMTiles-источников
    // (кэш и повторные события не удваивают счётчик).
    const tiles = new Set<string>();
    const onSourceData = (event: maplibregl.MapSourceDataEvent) => {
      if (event.sourceId !== "basemap" && event.sourceId !== "buildings") return;
      const canonical = (
        event.tile as
          | { tileID?: { canonical?: { z: number; x: number; y: number } } }
          | undefined
      )?.tileID?.canonical;
      if (!canonical || !event.sourceId) return;
      tiles.add(`${event.sourceId}/${canonical.z}/${canonical.x}/${canonical.y}`);
    };
    let attached: maplibregl.Map | null = null;
    const attach = () => {
      const map = (window as unknown as { __map?: maplibregl.Map }).__map;
      if (!map || attached) return;
      attached = map;
      map.on("sourcedata", onSourceData);
    };
    attach();

    const render = () => {
      attach();
      const map = (window as unknown as { __map?: maplibregl.Map }).__map;
      const sorted = frameTimes.slice().sort((a, b) => a - b);
      const avg =
        frameTimes.reduce((sum, value) => sum + value, 0) /
        Math.max(1, frameTimes.length);
      const p95 = sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
        : 0;
      let bytes = 0;
      for (const entry of performance.getEntriesByType(
        "resource",
      ) as PerformanceResourceTiming[]) {
        if (entry.name.includes(".pmtiles")) bytes += entry.transferSize || 0;
      }
      el.textContent = [
        `FPS ${frameTimes.length ? Math.round(1000 / avg) : "—"}`,
        `p95 ${p95 ? p95.toFixed(1) : "—"} мс`,
        `тайлы ${tiles.size}`,
        `PMTiles ${(bytes / 1048576).toFixed(2)} МБ`,
        `z ${(map?.getZoom() ?? 0).toFixed(2)}`,
      ].join(" · ");
    };
    render();
    const timer = window.setInterval(render, 500);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearInterval(timer);
      attached?.off("sourcedata", onSourceData);
    };
  }, [perfEnabled]);

  // Движок карты (создание карты, слои, обработчики) — см. map/engine.ts.
  // Контекст собирается при монтировании, как и раньше: зависимости пустые.
  useEffect(
    () =>
      mountMap({
        containerRef,
        selected,
        visible,
        theme,
        setSearchItems,
        setDeepLinkError,
        setNotice,
        setNonHomeNotice,
        setFatalError,
        setSplash,
        deselectRef,
        selectRef,
        loadSearchIndexRef,
        findNearestHomeRef,
        applyVisibilityRef,
        applyThemeRef,
        selectedRef,
        visibleRef,
        routesRef,
        routesCacheRef,
        routesShardCacheRef,
        breakdownCacheRef,
        districtByBuildingRef,
        isoGeomRef,
        setIsoSourceRef,
        themeRef,
        updateSelected,
        showNotice,
      }),
    [],
  );

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="map-gradient map-grade h-full w-full" />
      <div className="map-haze pointer-events-none absolute inset-x-0 top-0" aria-hidden />
      <div className="map-vignette pointer-events-none absolute inset-0" aria-hidden />
      {perfEnabled && (
        <div
          ref={perfRef}
          data-perf-overlay="1"
          className="pointer-events-none absolute left-2 top-2 z-30 max-w-[92vw] rounded-md bg-overlay px-2 py-1 font-mono text-10 leading-tight text-overlay-ink"
          aria-hidden
        />
      )}
      <LayersPanel
        visibility={visible}
        onToggle={(key) =>
          setVisible((v) => ({ ...v, [key]: !v[key] }))
        }
      />
      {/* Слои карты: реестр сам знает, что подключать и что рисовать. */}
      <LayerHost visible={visible} theme={theme} minutes={clockMinutes} />
      <Timeline minutes={clockMinutes} onChange={changeClockMinutes} />
      <SearchBox
        items={searchItems}
        onSelect={(id) => selectRef.current?.(id)}
        onSearch={() => void loadSearchIndexRef.current?.()}
      />
      <BuildingSheet
        building={selected}
        onClose={() => deselectRef.current?.()}
        contour={contour}
        onContourChange={setContour}
      />
      {deepLinkError && (
        <div className="absolute bottom-6 left-1/2 z-20 w-[min(92vw,420px)] -translate-x-1/2 rounded-plate bg-warn-bg px-4 py-3 text-sm text-warn-ink shadow-xl">
          <div className="flex items-start gap-2">
            <span className="flex-1">{deepLinkError}</span>
            <button
              type="button"
              onClick={() => setDeepLinkError(null)}
              aria-label="Закрыть"
              className="rounded-pill p-0.5 text-warn-quiet hover:bg-warn-quiet-hover"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      )}
      {nonHomeNotice && (
        <div
          className="absolute bottom-6 left-1/2 z-20 w-[min(92vw,420px)] -translate-x-1/2 rounded-plate bg-warn-bg-strong px-4 py-3 text-sm text-warn-ink shadow-xl"
          role="status"
        >
          <div>
            Нежилое здание. Индекс окружения считается только для жилых домов
          </div>
          {nonHomeNotice.status === "far" ? (
            <div className="mt-2 text-xs font-semibold text-warn-ink-strong">
              Рядом нет жилых домов
            </div>
          ) : (
            <button
              type="button"
              disabled={
                nonHomeNotice.status === "loading" ||
                nonHomeNotice.status === "error"
              }
              onClick={() => void findNearestHomeRef.current?.(nonHomeNotice.point)}
              className="mt-2.5 inline-flex items-center justify-center rounded-control bg-warn-action px-3.5 py-1.5 text-xs font-semibold text-warn-action-ink shadow-plate transition hover:bg-warn-action-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {nonHomeNotice.status === "loading"
                ? "ищу…"
                : "Ближайший жилой дом"}
            </button>
          )}
        </div>
      )}
      {notice && (
        <div
          className="absolute bottom-6 left-1/2 z-20 w-[min(92vw,420px)] -translate-x-1/2 rounded-plate bg-warn-bg px-4 py-3 text-sm text-warn-ink shadow-xl"
          role="status"
        >
          {notice}
        </div>
      )}
      {fatalError && (
        <div className="absolute inset-x-4 top-1/3 z-20 rounded-plate bg-danger-bg px-4 py-3 text-sm text-danger shadow-lg">
          {fatalError}
        </div>
      )}
      {splash !== "gone" && (
        <div
          className={`absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-splash text-splash-ink transition-opacity duration-slow ${
            splash === "fade" ? "opacity-0" : "opacity-100"
          }`}
          aria-hidden
        >
          <svg width="72" height="72" viewBox="0 0 512 512">
            <circle cx="256" cy="256" r="130" fill="none" stroke="currentColor" strokeWidth="64" />
          </svg>
          <div className="text-lg font-semibold tracking-wide">
            Пульс Москвы
          </div>
        </div>
      )}
      {/* S10: атрибуция на самой карте, а не только в футере. Плашка стоит в
          одной строке с плашкой теней (та слева), поэтому на 390 px не наезжает
          ни на погоду, ни на таймлайн, ни на футер-строку ниже.
          z-[9]: над канвасом, но под карточкой дома (z-10) — как и футер. */}
      <button
        type="button"
        data-attribution-plate="1"
        aria-haspopup="dialog"
        onClick={openAbout}
        title="Атрибуция и лицензии: OpenStreetMap, data.mos.ru, Open-Meteo"
        className="absolute bottom-[6.6rem] right-3 z-[9] cursor-pointer rounded-plate bg-panel px-2.5 py-1.5 text-10 font-medium leading-none text-ink shadow-plate backdrop-blur transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent md:bottom-[3.4rem]"
      >
        © OpenStreetMap
      </button>
      {/* Футер-строка — та же дверь в «О данных», текст и смысл прежние. */}
      <button
        type="button"
        data-attribution-footer="1"
        aria-haspopup="dialog"
        onClick={openAbout}
        title="Откуда эти данные, лицензии и дата выгрузки"
        className="absolute bottom-2 right-3 z-[9] max-w-md cursor-pointer text-right text-11 leading-tight text-ink-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      >
        © OpenStreetMap contributors, ODbL · Пульс Москвы — справочная
        информация по открытым данным, не является замером или оценкой стоимости
      </button>
      {aboutOpen && <AboutData onClose={closeAbout} />}
    </div>
  );
}
