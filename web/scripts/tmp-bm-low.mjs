#!/usr/bin/env node
// ВРЕМЕННЫЙ замер BM-LOW (не коммитится): FPS/p95 на обзоре z10 и паритет z13.
//   node scripts/tmp-bm-low.mjs <label> [--headless]
// Снимает кадры DPR1 light: z10, z13, z16.6 и печатает метрики.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WEB_ROOT, "dist");
const ROOT = join(WEB_ROOT, ".shot");
const SITE = join(ROOT, "karta-okruzheniya");
const PORT = Number(process.env.SHOT_PORT ?? 4211);
const BASE_URL = `http://127.0.0.1:${PORT}/karta-okruzheniya/`;

const label = process.argv[2] ?? "run";
const headless = process.argv.includes("--headless");
const W = 1290;
const H = 900;

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

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {
      // стартует
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("сервер не поднялся");
}

const BASE = { center: [37.554, 55.756], pitch: 55, bearing: -25 };
const round = (n) => Math.round(n * 10) / 10;

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    headless,
    args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
  });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 20_000 });
  await page.waitForTimeout(4_000);

  const measure = async (zoom) => {
    const result = await page.evaluate(
      async ({ z, base }) => {
        const map = window.__map;
        map.jumpTo({ ...base, zoom: z });
        await new Promise((r) => setTimeout(r, 4_000)); // тайлы досели
        return await new Promise((resolve) => {
          const frames = [];
          let last = performance.now();
          let n = 0;
          const step = () => {
            const t = performance.now();
            frames.push(t - last);
            last = t;
            n++;
            // Небольшой сдвиг центра каждый кадр: полный рендер сцены,
            // как при панорамировании, но без ухода из района.
            map.jumpTo({
              ...base,
              zoom: z,
              center: [base.center[0] + Math.sin(n / 18) * 0.004, base.center[1]],
            });
            if (n < 260) requestAnimationFrame(step);
            else {
              const s = frames.slice(20).sort((a, b) => a - b);
              resolve({
                median: s[Math.floor(s.length / 2)],
                p95: s[Math.floor(s.length * 0.95)],
                over33: s.filter((v) => v > 33).length,
                total: s.length,
              });
            }
          };
          requestAnimationFrame(step);
        });
      },
      { z: zoom, base: BASE },
    );
    console.log(
      `${label} z${zoom}: FPS=${round(1000 / result.median)} median=${round(result.median)}ms p95=${round(result.p95)}ms >33ms=${result.over33}/${result.total}`,
    );
    return result;
  };

  const shot = async (zoom) => {
    await page.evaluate(
      ({ z, base }) => {
        window.__map.jumpTo({ ...base, zoom: z });
      },
      { z: zoom, base: BASE },
    );
    await page.waitForTimeout(3_000);
    const path = join(WEB_ROOT, ".shot", `bm-low-${label}-z${zoom}.png`);
    await page.screenshot({ path });
    console.log(`saved ${path}`);
  };

  await measure(10);
  await measure(13);
  await shot(10);
  await shot(13);
  await shot(16.6);
} finally {
  await browser?.close();
  server.kill();
  rmSync(SITE, { recursive: true, force: true });
}
