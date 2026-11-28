"use client";

// Замер производительности на реальном устройстве (S14).
// Включается только параметром `?perf=1`; в обычной работе не монтируется
// и ничего не считает. Живёт отдельно от карты специально: это инструмент
// проверки, а не часть продукта.
//
// Почему не через iframe: LCP браузер отдаёт только верхнему документу,
// поэтому измерять надо со страницы, а не из рамки.

import { useEffect, useRef, useState } from "react";

type Report = {
  device: string;
  screen: string;
  cores: string;
  net: string;
  lcp: number | null;
  fcp: number | null;
  ttfb: number | null;
  dcl: number | null;
  jsKb: number | null;
  totalKb: number | null;
  fps: number | null;
  worstMs: number | null;
  p95Ms: number | null;
};

const PAN_SECONDS = 3;
const LCP_WAIT_MS = 1200;

function kb(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / 1024);
}

function describeDevice(): Pick<Report, "device" | "screen" | "cores" | "net"> {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const model =
    /;\s*([^;)]+?)\s*Build/.exec(ua)?.[1] ??
    /Android[^;]*;\s*([^)]+)\)/.exec(ua)?.[1] ??
    (/iPhone/.test(ua) ? "iPhone" : "браузер");
  const connection = (
    navigator as unknown as { connection?: { effectiveType?: string; downlink?: number } }
  ).connection;
  return {
    device: String(model).trim().slice(0, 32),
    screen: `${window.screen.width}×${window.screen.height} @${window.devicePixelRatio || 1}x`,
    cores: navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : "—",
    net: connection?.effectiveType
      ? `${connection.effectiveType.toUpperCase()}${
          connection.downlink ? ` · ~${connection.downlink} Мбит/с` : ""
        }`
      : "—",
  };
}

function resourceBytes(): { js: number; total: number } {
  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  let js = 0;
  let total = 0;
  for (const entry of entries) {
    const size = entry.transferSize || entry.encodedBodySize || 0;
    total += size;
    if (/\.js(\?|$)/.test(entry.name)) js += size;
  }
  return { js, total };
}

function measureFps(map: { panBy: (delta: [number, number], options?: { duration: number }) => void }): Promise<{
  fps: number;
  worst: number;
  p95: number;
}> {
  return new Promise((resolve) => {
    const frames: number[] = [];
    let last = 0;
    const stopAt = performance.now() + PAN_SECONDS * 1000;
    const step = (now: number) => {
      if (last) frames.push(now - last);
      last = now;
      try {
        map.panBy([2.6, 1.2], { duration: 0 });
      } catch {
        // карта могла размонтироваться — считаем то, что успели
      }
      if (now < stopAt) {
        requestAnimationFrame(step);
        return;
      }
      frames.sort((a, b) => a - b);
      const sum = frames.reduce((acc, value) => acc + value, 0);
      const average = frames.length ? sum / frames.length : 0;
      resolve({
        fps: average > 0 ? 1000 / average : 0,
        worst: frames.length ? frames[frames.length - 1] : 0,
        p95: frames.length ? frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))] : 0,
      });
    };
    requestAnimationFrame(step);
  });
}

export default function PerfProbe() {
  // Параметр читаем после монтирования: на сервере `window` нет, а серверная
  // и клиентская разметка должны совпасть, иначе гидратация ругается.
  const [enabled, setEnabled] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [phase, setPhase] = useState("Считаю метрики…");
  const [collapsed, setCollapsed] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("perf")) setEnabled(true);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (startedRef.current) return;
    startedRef.current = true;

    let lcp: number | null = null;
    try {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) lcp = last.startTime;
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
      window.setTimeout(() => observer.disconnect(), LCP_WAIT_MS + 800);
    } catch {
      // Safari старых версий не умеет — останется «—»
    }

    let cancelled = false;

    const waitForMap = async (timeoutMs: number) => {
      const startedAt = performance.now();
      while (performance.now() - startedAt < timeoutMs) {
        const map = (window as unknown as { __map?: { panBy: (d: [number, number], o?: { duration: number }) => void } })
          .__map;
        if (map) return map;
        await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
      return null;
    };

    const run = async () => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const paint = performance.getEntriesByType("paint");
      const fcpEntry = paint.find((entry) => entry.name === "first-contentful-paint");
      const map = await waitForMap(45_000);
      if (cancelled) return;
      setPhase("Измеряю плавность (3 секунды)…");
      const pan = map ? await measureFps(map) : null;
      if (cancelled) return;
      const bytes = resourceBytes();
      setReport({
        ...describeDevice(),
        lcp,
        fcp: fcpEntry ? fcpEntry.startTime : null,
        ttfb: nav ? nav.responseStart : null,
        dcl: nav ? nav.domContentLoadedEventEnd : null,
        jsKb: kb(bytes.js),
        totalKb: kb(bytes.total),
        fps: pan ? pan.fps : null,
        worstMs: pan ? pan.worst : null,
        p95Ms: pan ? pan.p95 : null,
      });
      setPhase("Готово");
    };

    run().catch((error) => setPhase(`Не удалось: ${String(error)}`));

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  if (!enabled) return null;

  if (!report) {
    return (
      <div className="pointer-events-none fixed bottom-[14rem] left-1/2 z-[60] -translate-x-1/2 rounded-full bg-slate-900/85 px-4 py-2 text-xs text-white shadow-lg">
        Замер S14 · {phase}
      </div>
    );
  }

  const ms = (value: number | null) => (value === null ? "—" : `${Math.round(value)} мс`);
  const rows: Array<[string, string, boolean | null]> = [
    ["LCP", ms(report.lcp), report.lcp !== null ? report.lcp <= 2500 : null],
    ["fps карты", report.fps === null ? "—" : `${report.fps.toFixed(1)}`, report.fps !== null ? report.fps >= 30 : null],
    // S14: бюджет пересогласован 28.11 — потолок на весь JS 700 КБ, свой код
    // считается отдельно от движка карты (см. docs/DECISIONS.md).
    ["JS", report.jsKb === null ? "—" : `${report.jsKb} КБ`, report.jsKb !== null ? report.jsKb <= 700 : null],
    ["худший кадр", ms(report.worstMs), null],
    ["p95 кадра", ms(report.p95Ms), null],
    ["FCP", ms(report.fcp), null],
    ["TTFB", ms(report.ttfb), null],
    ["JS всего", report.totalKb === null ? "—" : `${report.totalKb} КБ`, null],
    ["устройство", report.device, null],
    ["экран", report.screen, null],
    ["ядер", report.cores, null],
    ["сеть", report.net, null],
  ];

  return (
    <div
      data-perf-panel="1"
      className="fixed inset-x-2 bottom-[14rem] z-[60] max-h-[38dvh] overflow-y-auto rounded-2xl bg-slate-900/95 px-3 py-2.5 text-white shadow-2xl"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">Замер S14 · это устройство</span>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="rounded-full bg-white/10 px-3 py-1 text-xs"
        >
          {collapsed ? "раскрыть" : "свернуть"}
        </button>
      </div>
      {!collapsed && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[13px]">
          {rows.map(([label, value, ok]) => (
            <div key={label} className="flex items-baseline justify-between gap-2">
              <dt className="text-white/55">{label}</dt>
              <dd
                className={`font-semibold tabular-nums ${
                  ok === null ? "text-white" : ok ? "text-emerald-400" : "text-orange-400"
                }`}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-1.5 text-[11px] leading-snug text-white/55">
        Бюджет: LCP &lt; 2500 мс, карта &gt; 30 fps, весь JS &lt; 700 КБ (свой код
        считается отдельно от движка). Сделайте скриншот экрана.
      </p>
    </div>
  );
}
