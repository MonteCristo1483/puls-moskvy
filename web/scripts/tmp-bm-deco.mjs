#!/usr/bin/env node
// ВРЕМЕННЫЙ зонд v3 (не коммитится): цена querySourceFeatures по зумам —
// именно это делает refreshBasemapDecorations на moveend/idle/sourcedata.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WEB_ROOT, "dist");
const ROOT = join(WEB_ROOT, ".shot");
const SITE = join(ROOT, "karta-okruzheniya");
const PORT = Number(process.env.SHOT_PORT ?? 4214);
const BASE_URL = `http://127.0.0.1:${PORT}/karta-okruzheniya/`;

if (!existsSync(join(DIST, "index.html"))) process.exit(1);
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
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(BASE_URL)).ok) break;
    } catch {
      if (Date.now() > deadline) throw new Error("сервер не поднялся");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await chromium.launch({ headless: false, args: ["--ignore-gpu-blocklist"] });
  const context = await browser.newContext({
    viewport: { width: 1290, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 20_000 });
  await page.waitForTimeout(4_000);

  const out = await page.evaluate(async () => {
    const map = window.__map;
    const base = { center: [37.554, 55.756], pitch: 55, bearing: -25 };
    const layers = ["landuse", "green", "water", "river", "waterway", "road"];
    const res = {};
    for (const z of [10, 11, 12.6, 13, 15.35]) {
      map.jumpTo({ ...base, zoom: z });
      await new Promise((r) => setTimeout(r, 4_000));
      const t0 = performance.now();
      let count = 0;
      let bytes = 0;
      for (const sourceLayer of layers) {
        const feats = map.querySourceFeatures("basemap", { sourceLayer });
        count += feats.length;
        for (const f of feats) bytes += JSON.stringify(f.geometry).length;
      }
      res[`z${z}`] = {
        ms: Math.round(performance.now() - t0),
        features: count,
        /** объём geometry-JSON — то, что хешируется на каждый moveend */
        json: `${Math.round(bytes / 1024)} КБ`,
      };
    }
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser?.close();
  server.kill();
  rmSync(SITE, { recursive: true, force: true });
}
