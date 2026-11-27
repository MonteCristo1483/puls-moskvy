#!/usr/bin/env node
// ВРЕМЕННЫЙ зонд v2 (не коммитится): стоимость кадра при панорамировании
// (move-анимация, без moveend на каждый кадр).
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WEB_ROOT, "dist");
const ROOT = join(WEB_ROOT, ".shot");
const SITE = join(ROOT, "karta-okruzheniya");
const PORT = Number(process.env.SHOT_PORT ?? 4213);
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
  browser = await chromium.launch({
    headless: false,
    args: [
      "--ignore-gpu-blocklist",
      "--disable-frame-rate-limit",
      "--disable-gpu-vsync",
    ],
  });
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
    const base = { center: [37.554, 55.756], zoom: 10, pitch: 55, bearing: -25 };
    // 3 секунды анимации панорамы, кадры собираем через rAF.
    const pan = () =>
      new Promise((resolve) => {
        const arr = [];
        let last = performance.now();
        let done = false;
        const tick = () => {
          const t = performance.now();
          arr.push(t - last);
          last = t;
          if (!done) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        map.panBy([220, 0], { duration: 3000 });
        const finish = () => {
          if (done) return;
          done = true;
          const s = arr.slice(10).sort((a, b) => a - b);
          resolve({
            median: Math.round(s[Math.floor(s.length / 2)] * 10) / 10,
            p95: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10,
            frames: s.length,
          });
        };
        map.once("moveend", finish);
        setTimeout(finish, 6000);
      });

    // Один jumpTo = «шаг» движения: moveend + querySourceFeatures + подписи.
    const jumpCost = () =>
      new Promise((resolve) => {
        const t0 = performance.now();
        const done = () => {
          let n = 0;
          const wait = () => {
            n++;
            if (n < 6) requestAnimationFrame(wait);
            else resolve(Math.round((performance.now() - t0) * 10) / 10);
          };
          requestAnimationFrame(wait);
        };
        map.once("moveend", done);
        map.jumpTo({ ...base, center: [base.center[0] + 0.0008, base.center[1]] });
        setTimeout(() => resolve(Math.round((performance.now() - t0) * 10) / 10), 5000);
      });

    const ids = map.getStyle().layers.map((l) => l.id);
    const groups = {
      baseline: [],
      "no landuse": ["bm-landuse"],
      "no green": ["bm-green"],
      "no landuse+green": ["bm-landuse", "bm-green"],
      "no water group": ["bm-water", "bm-river", "bm-waterway"],
      "no roads": ids.filter((id) => id.startsWith("bm-road")),
      "no basemap": ids.filter((id) => id.startsWith("bm-")),
      nothing: ids.filter((id) => id !== "bm-land"),
    };
    map.jumpTo(base);
    await new Promise((r) => setTimeout(r, 3_500));
    const result = {};
    for (const [label, off] of Object.entries(groups)) {
      for (const id of off) map.setLayoutProperty(id, "visibility", "none");
      await new Promise((r) => setTimeout(r, 700));
      result[label] = { pan: await pan(), jump: await jumpCost() };
      map.jumpTo(base);
      await new Promise((r) => setTimeout(r, 900));
      for (const id of off) map.setLayoutProperty(id, "visibility", "visible");
      await new Promise((r) => setTimeout(r, 300));
    }
    result.layerCount = ids.length;
    return result;
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser?.close();
  server.kill();
  rmSync(SITE, { recursive: true, force: true });
}
