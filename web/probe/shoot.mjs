// D2a — съёмка дизайн-пробы. Static-сервер на web/probe + Playwright.
//   node web/probe/shoot.mjs            все 6 снимков + замеры
//   node web/probe/shoot.mjs a b        только нужные языки
//
// Что делает:
//   1. копирует web/shots/live-after-f2.png -> web/probe/bg.png;
//   2. «выпекает» из него чистые кропы bg-desk.png (1280x800) и bg-mob.png
//      (780x1688, DPR2) — так в кадр подложки не попадает чужой UI;
//   3. снимает 6 PNG в web/shots/ и печатает замеры мобильного вида
//      (площадь интерфейса, высота покрытия, минимальный шрифт, наложения).

import { chromium } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(PROBE, "..");
const SHOTS = path.join(WEB, "shots");
const BG_SRC = path.join(SHOTS, "live-after-f2.png");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// Кропы исходного снимка: [left, top, width, height] в пикселях источника.
// Берём только ту часть кадра, где нет отрисованного интерфейса приложения.
const CROP_DESK = [330, 58, 770, 600];
const CROP_MOB = [573, 58, 284, 614];

const VIEWS = {
  desktop: { width: 1280, height: 800, dpr: 1 },
  mobile: { width: 390, height: 844, dpr: 2 },
};

function serve(root) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    let file = path.join(root, url === "/" ? "index.html" : url);
    if (!file.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
      }).end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Выпечка кропа: страница-«плёнка» нужного размера, снимок только подложки.
async function bakeCrop(browser, base, crop, view, out) {
  const [L, T, W, H] = crop;
  const s = Math.max(view.width / W, view.height / H);
  const left = (view.width - W * s) / 2 - L * s;
  const top = (view.height - H * s) / 2 - T * s;
  const ctx = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.dpr,
  });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;overflow:hidden;background:#0e1013}
    img{position:absolute;width:${(1280 * s).toFixed(2)}px;left:${left.toFixed(2)}px;top:${top.toFixed(2)}px;max-width:none}
  </style></head><body><img src="${base}/bg.png" alt=""></body></html>`, { waitUntil: "load" });
  await page.waitForFunction(() => document.images[0]?.complete);
  await page.screenshot({ path: out });
  await ctx.close();
}

// Замеры: площадь «интерфейса» и высота, которую он закрывает.
const MEASURE = () => {
  const vw = innerWidth;
  const vh = innerHeight;
  const all = [...document.querySelectorAll("[data-ui]")];
  const top = all.filter((el) => !el.parentElement.closest("[data-ui]"));
  const rects = top.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      cls: el.className.split(" ").filter((c) => c !== "p").join(" "),
      x: +r.x.toFixed(1), y: +r.y.toFixed(1),
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
    };
  });

  const area = rects.reduce((s, r) => s + r.w * r.h, 0);

  // Высота, реально закрытая интерфейсом: объединение вертикальных интервалов.
  const spans = rects.map((r) => [r.y, r.y + r.h]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const covered = merged.reduce((s, [a, b]) => s + (b - a), 0);

  const overlaps = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ow > 1 && oh > 1) overlaps.push(`${a.cls} × ${b.cls} ${Math.round(ow)}×${Math.round(oh)}`);
    }
  }

  let minFont = Infinity;
  let minFontWhere = "";
  for (const el of document.querySelectorAll("body *")) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) continue;
    const fs = parseFloat(cs.fontSize);
    if (fs < minFont) {
      minFont = fs;
      minFontWhere = `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}`;
    }
  }

  const off = rects.filter((r) => r.x < -0.5 || r.y < -0.5 || r.x + r.w > vw + 0.5 || r.y + r.h > vh + 0.5);

  return {
    vw, vh,
    rects,
    areaPct: +((area / (vw * vh)) * 100).toFixed(1),
    coveredPct: +((covered / vh) * 100).toFixed(1),
    minFont,
    minFontWhere,
    overlaps,
    offscreen: off.map((r) => r.cls),
    hScroll: document.documentElement.scrollWidth - vw,
  };
};

const only = process.argv.slice(2).filter((a) => ["a", "b", "c"].includes(a));
const variants = only.length ? only : ["a", "b", "c"];

fs.mkdirSync(SHOTS, { recursive: true });
if (!fs.existsSync(BG_SRC)) throw new Error(`нет подложки: ${BG_SRC}`);
fs.copyFileSync(BG_SRC, path.join(PROBE, "bg.png"));

const { server, base } = await serve(PROBE);
const browser = await chromium.launch();

try {
  await bakeCrop(browser, base, CROP_DESK, VIEWS.desktop, path.join(PROBE, "bg-desk.png"));
  await bakeCrop(browser, base, CROP_MOB, VIEWS.mobile, path.join(PROBE, "bg-mob.png"));

  const report = [];

  for (const v of variants) {
    for (const [kind, view] of Object.entries(VIEWS)) {
      const ctx = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        deviceScaleFactor: view.dpr,
        reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      await page.goto(`${base}/?v=${v}`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      const out = path.join(SHOTS, `d2a-${v}-${kind === "desktop" ? "desk" : "mob"}.png`);
      await page.screenshot({ path: out });
      const m = await page.evaluate(MEASURE);
      report.push({ v, kind, out: path.relative(WEB, out).replace(/\\/g, "/"), ...m });
      await ctx.close();
    }
  }

  for (const r of report) {
    const tag = `${r.v}:${r.kind}`.padEnd(12);
    console.log(
      `${tag} ${r.vw}x${r.vh}  площадь ${String(r.areaPct).padStart(5)}%  ` +
      `высота ${String(r.coveredPct).padStart(5)}%  шрифт≥${r.minFont}px (${r.minFontWhere})` +
      (r.overlaps.length ? `  НАЛОЖЕНИЯ: ${r.overlaps.join("; ")}` : "") +
      (r.offscreen.length ? `  ВНЕ ЭКРАНА: ${r.offscreen.join(", ")}` : "") +
      (r.hScroll > 0 ? `  h-scroll ${r.hScroll}px` : "")
    );
    console.log(`             ${r.rects.map((x) => `${x.cls}[${x.y}..${(x.y + x.h).toFixed(0)}]`).join(" ")}`);
    console.log(`             -> ${r.out}`);
  }
} finally {
  await browser.close();
  server.close();
}
