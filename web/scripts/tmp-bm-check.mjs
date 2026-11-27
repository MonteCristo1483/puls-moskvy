#!/usr/bin/env node
// ВРЕМЕННАЯ проверка (не коммитится): выражения приняты стилем, ошибок нет.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WEB_ROOT, "dist");
const ROOT = join(WEB_ROOT, ".shot");
const SITE = join(ROOT, "karta-okruzheniya");
const PORT = Number(process.env.SHOT_PORT ?? 4215);
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
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1290, height: 900 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForSelector("canvas.maplibregl-canvas");
  await page.waitForTimeout(4_000);

  const info = await page.evaluate(async () => {
    const map = window.__map;
    const out = {
      landuse: map.getLayer("bm-landuse")?.minzoom ?? "none",
      water: map.getPaintProperty("bm-water", "fill-antialias"),
      river: map.getPaintProperty("bm-river", "line-blur"),
      green: map.getLayer("bm-green").minzoom ?? "none",
    };
    const at = async (z) => {
      map.jumpTo({ center: [37.554, 55.756], zoom: z, pitch: 55, bearing: -25 });
      await new Promise((r) => setTimeout(r, 2_500));
      return {
        z,
        landuseRendered: map.getLayer("bm-landuse")
          ? map.queryRenderedFeatures({ layers: ["bm-landuse"] }).length
          : 0,
        labels: document.querySelectorAll(".maplibregl-marker").length,
        tiles: map.areTilesLoaded(),
      };
    };
    out.z10 = await at(10);
    out.z125 = await at(12.5);
    out.z13 = await at(13);
    out.z135 = await at(13.5);
    out.z16 = await at(16.6);
    return out;
  });
  console.log(JSON.stringify(info, null, 1));
  console.log("console errors/warnings:", errors.length ? errors.slice(0, 8) : "нет");
} finally {
  await browser?.close();
  server.kill();
  rmSync(SITE, { recursive: true, force: true });
}
