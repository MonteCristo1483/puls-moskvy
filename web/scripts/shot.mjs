#!/usr/bin/env node
// Скриншоты и замер кадров карты в заданном DPR.
// Использование:
//   node scripts/shot.mjs <имя.png> <dpr> <ширина> <высота> [--perf] [--headless] [--t=HH:MM] [--work=<id>] [--dark]
// Примеры:
//   node scripts/shot.mjs shots/before-1290-dpr1.png 1 1290 900 --perf
//   node scripts/shot.mjs shots/before-1290-dpr2.png 2 1290 900
//   node scripts/shot.mjs shots/s4-morning.png 1 1280 800 --headless --t=08:00
//   node scripts/shot.mjs shots/s7-card.png 1 1280 800 --headless --work=5111866498
//   node scripts/shot.mjs shots/s4-dark.png 1 1280 800 --headless --dark
//
// Готовит Pages-раскладку (dist → .shot/puls-moskvy), поднимает
// статик-сервер, снимает скриншот. `--t=HH:MM` открывает карту на выбранном
// часе таймлайна (S4), `--work=<global_id>` — карточку объекта работ (S7),
// `--dark` — в тёмной теме. С --perf сначала меряет простой,
// затем 200 кадров при непрерывном зуме колесом (1.5× и обратно),
// печатает медиану, p95 и число кадров >33 мс.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WEB_ROOT, "dist");
const ROOT = join(WEB_ROOT, ".shot");
const SITE = join(ROOT, "puls-moskvy");
const PORT = Number(process.env.SHOT_PORT ?? 4199);
const BASE_URL = `http://127.0.0.1:${PORT}/puls-moskvy/`;

const [outArg, dprArg, widthArg, heightArg, ...flags] = process.argv.slice(2);
if (!outArg || !dprArg || !widthArg || !heightArg) {
  console.error("usage: node scripts/shot.mjs <out.png> <dpr> <width> <height> [--perf] [--headless] [--t=HH:MM] [--work=<id>] [--dark]");
  process.exit(1);
}
const out = resolve(WEB_ROOT, outArg);
const dpr = Number(dprArg);
const width = Number(widthArg);
const height = Number(heightArg);
const perf = flags.includes("--perf");
const headless = flags.includes("--headless");
const dark = flags.includes("--dark");
// S4: `--t=08:00` — снимок не «сейчас», а на выбранном часе таймлайна.
const clockFlag = flags.find((flag) => flag.startsWith("--t="));
const clock = clockFlag ? clockFlag.slice("--t=".length) : null;
// S7: `--work=<global_id>` — открыть карточку объекта работ по ссылке.
const workFlag = flags.find((flag) => flag.startsWith("--work="));
const work = workFlag ? workFlag.slice("--work=".length) : null;
const params = new URLSearchParams();
if (clock) params.set("t", clock);
if (work) params.set("work", work);
const query = params.toString().replace(/%3A/gi, ":");
const targetUrl = query ? `${BASE_URL}?${query}` : BASE_URL;

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {
      // сервер ещё стартует
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("сервер не поднялся");
}

if (!existsSync(join(DIST, "index.html"))) {
  console.error("Нет web/dist — сначала `npm run build`.");
  process.exit(1);
}

rmSync(SITE, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
cpSync(DIST, SITE, { recursive: true });

const server = spawn(
  process.execPath,
  [join(WEB_ROOT, "scripts", "serve-test.mjs"), ROOT, String(PORT)],
  { cwd: WEB_ROOT, stdio: ["ignore", "inherit", "inherit"] },
);

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    headless,
    args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
  });
  if (dark) {
    // Тема читается антфлеш-скриптом layout.tsx из localStorage.
    await context.addInitScript(() => {
      window.localStorage.setItem("karta-theme", "dark");
    });
  }
  const page = await context.newPage();
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 20_000 });
  await page.waitForTimeout(5_000);
  if (clock) {
    console.log(`url: ${targetUrl}`);
    const shown = await page.evaluate(() => {
      const slider = document.querySelector("[data-timeline-slider]");
      const pill = document.querySelector("[data-weather-pill]");
      return {
        timeline: slider?.getAttribute("aria-valuetext") ?? null,
        pill: pill?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      };
    });
    console.log(`таймлайн: ${shown.timeline} · плашка: ${shown.pill}`);
  }

  if (work) {
    // Карточка объекта грузит works.geojson (6,5 МБ) — ждём её, а не таймер.
    await page.waitForSelector("[data-work-card]", { timeout: 20_000 });
    console.log(`url: ${targetUrl}`);
    const card = await page.evaluate(() => {
      const node = document.querySelector("[data-work-card]");
      return {
        id: node?.getAttribute("data-work-id") ?? null,
        text: node?.textContent?.replace(/\s+/g, " ").trim().slice(0, 180) ?? null,
      };
    });
    console.log(`карточка ${card.id}: ${card.text}`);
  }

  if (perf) {
    const attrs = await page.evaluate(() => {
      const canvas = document.querySelector("canvas.maplibregl-canvas");
      const gl = canvas?.getContext("webgl2");
      return gl?.getContextAttributes() ?? null;
    });
    console.log(
      `context: antialias=${attrs?.antialias} dpr=${dpr} canvas=${await page.evaluate(
        () => `${document.querySelector("canvas.maplibregl-canvas")?.width}x${document.querySelector("canvas.maplibregl-canvas")?.height}`,
      )}`,
    );
    const measure = async (label, zooming) => {
      await page.evaluate(() => {
        window.__perfFrames = [];
        let last = performance.now();
        const tick = (t) => {
          window.__perfFrames.push(t - last);
          last = t;
          if (window.__perfFrames.length < 400) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      if (zooming) {
        await page.mouse.move(width / 2, height / 2);
        for (let i = 0; i < 24; i++) {
          await page.mouse.wheel(0, i < 12 ? -120 : 120);
          await page.waitForTimeout(70);
        }
      } else {
        await page.waitForTimeout(3_200);
      }
      const frames = await page.evaluate(() => window.__perfFrames.slice(0, 200));
      const sorted = [...frames].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const over = frames.filter((f) => f > 33).length;
      const round = (n) => Math.round(n * 10) / 10;
      console.log(
        `${label}: median=${round(median)}ms p95=${round(p95)}ms >33ms=${over}/${frames.length}`,
      );
    };
    await measure("idle", false);
    await measure("zoom 1.5x", true);
  }

  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log(`saved ${out} (${width}x${height} @${dpr}x)`);
} finally {
  await browser?.close();
  server.kill();
  rmSync(SITE, { recursive: true, force: true });
}
