// D2b — съёмка и замеры пробы «пастельная диорама».
// Запуск: cd web && node probe2/shoot.mjs
//
// 1. копирует web/shots/live-after-f2.png -> web/probe2/bg.png (подложка);
// 2. снимает 4 PNG 390x844 @ DPR2 в web/shots/;
// 3. пишет короткое видео морфа (бабл -> панель -> шторка -> назад), если выйдет;
// 4. считает по DOM высоту хрома (объединение видимых [data-chrome]),
//    минимальный шрифт, зоны нажатия, переполнения и контраст пар из палитры.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(PROBE, "..");
const SHOTS = path.join(WEB, "shots");
const BG_SRC = path.join(SHOTS, "live-after-f2.png");
const BG_DST = path.join(PROBE, "bg.png");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

function serve(root) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = path.join(root, url === "/" ? "index.html" : url);
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

// Контраст WCAG: считаем реальные пары цветов из палитры (без анализа картинки).
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const over = (fg, alpha, bg) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));

const INK_DAY = hex("#27405c");
const INK_EVE = hex("#2a2118");
const MAP_DAY = hex("#cce1fc");
const SURF_DAY = hex("#cfd9f2");
const ACC_DAY = hex("#98f8c8");
const SURF_EVE = hex("#e5d6cf");
const FLOOR_EVE = hex("#cda568");
const ACC_EVE = hex("#2bb270");
const WHITE = hex("#ffffff");

const BUBBLE_DAY = over(WHITE, 0.82, MAP_DAY);
const BUBBLE_EVE = over(hex("#fff9f3"), 0.88, FLOOR_EVE);
const MUTED_DAY = over(INK_DAY, 0.8, SURF_DAY);
const MUTED_EVE = over(INK_EVE, 0.8, SURF_EVE);
const MUTED_BUB_DAY = over(INK_DAY, 0.8, BUBBLE_DAY);
const MUTED_BUB_EVE = over(INK_EVE, 0.8, BUBBLE_EVE);

const PAIRS = {
  day: {
    "ink/карта": ratio(INK_DAY, MAP_DAY),
    "ink/шторка": ratio(INK_DAY, SURF_DAY),
    "ink/бабл": ratio(INK_DAY, BUBBLE_DAY),
    "ink/акцент": ratio(INK_DAY, ACC_DAY),
    "вторичный/бабл": ratio(MUTED_BUB_DAY, BUBBLE_DAY),
    "вторичный/шторка": ratio(MUTED_DAY, SURF_DAY),
  },
  eve: {
    "ink/шторка": ratio(INK_EVE, SURF_EVE),
    "ink/бабл": ratio(INK_EVE, BUBBLE_EVE),
    "ink/акцент": ratio(INK_EVE, ACC_EVE),
    "вторичный/бабл": ratio(MUTED_BUB_EVE, BUBBLE_EVE),
    "вторичный/шторка": ratio(MUTED_EVE, SURF_EVE),
  },
};

const r2 = (n) => Math.round(n * 100) / 100;

const MEASURE = () => {
  const vh = innerHeight;
  const vw = innerWidth;
  const toggleSupported = typeof Element.prototype.checkVisibility === "function";
  const visible = (el) => {
    if (!el) return false;
    if (toggleSupported) {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0;
  };

  const chrome = [...document.querySelectorAll("[data-chrome]")].filter(visible);
  const parts = chrome.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      cls: el.className.split(" ").filter(Boolean)[0] || el.id,
      top: +r.top.toFixed(1),
      bottom: +r.bottom.toFixed(1),
      h: +r.height.toFixed(1),
    };
  });
  const spans = parts.map((p) => [p.top, p.bottom]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 0.5) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const covered = merged.reduce((s, [a, b]) => s + (b - a), 0);

  let minFont = Infinity;
  let minFontWhere = "";
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < minFont) {
      minFont = fs;
      minFontWhere = el.tagName.toLowerCase() + "." + (el.className || "").toString().split(" ")[0];
    }
  }

  const targets = [];
  for (const el of document.querySelectorAll("button, a[href], [role=switch], input, select")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    targets.push({ label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
  }
  const small = targets.filter((t) => Math.min(t.w, t.h) < 44);

  const panel = document.querySelector("#layersPanel");
  const panelOverflow = panel ? panel.scrollHeight - panel.clientHeight : 0;

  return {
    vw,
    vh,
    state: document.documentElement.dataset.state,
    mode: document.documentElement.dataset.mode,
    chromePx: +covered.toFixed(1),
    chromePct: +((covered / vh) * 100).toFixed(1),
    parts,
    minFont,
    minFontWhere,
    targets: targets.length,
    minTarget: targets.length ? Math.min(...targets.map((t) => Math.min(t.w, t.h))) : null,
    smallTargets: small,
    panelOverflow,
    hScroll: document.documentElement.scrollWidth - vw,
  };
};

fs.mkdirSync(SHOTS, { recursive: true });
if (!fs.existsSync(BG_SRC)) throw new Error("нет подложки: " + BG_SRC);
fs.copyFileSync(BG_SRC, BG_DST);

const { server, base } = await serve(PROBE);
const browser = await chromium.launch();
const results = [];
const errors = [];

try {
  const shots = [
    { file: "d2b-1-day.png", url: "/?s=1&m=day" },
    { file: "d2b-1-eve.png", url: "/?s=1&m=eve" },
    { file: "d2b-2-day.png", url: "/?s=2&m=day" },
    { file: "d2b-3-day.png", url: "/?s=3&m=day" },
  ];

  for (const shot of shots) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
      locale: "ru-RU",
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${shot.file}: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`${shot.file}: console ${m.text()}`);
    });
    await page.goto(base + shot.url, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(320);
    const out = path.join(SHOTS, shot.file);
    await page.screenshot({ path: out });
    const m = await page.evaluate(MEASURE);
    results.push({ file: shot.file, out: path.relative(WEB, out).replace(/\\/g, "/"), ...m });
    await ctx.close();
  }

  // Видео: один подход, дальше не настаиваем.
  let videoOut = null;
  try {
    const vctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      locale: "ru-RU",
      recordVideo: { dir: path.join(SHOTS, ".d2b-video"), size: { width: 390, height: 844 } },
    });
    const vpage = await vctx.newPage();
    await vpage.goto(base + "/?s=1&m=day", { waitUntil: "load" });
    await vpage.evaluate(() => document.fonts.ready);
    await vpage.waitForTimeout(400);
    await vpage.click("#layersBtn");
    await vpage.waitForTimeout(450);
    await vpage.click('[data-cat="works"]');
    await vpage.waitForTimeout(600);
    await vpage.click("#sheetClose");
    await vpage.waitForTimeout(450);
    await vpage.click("#panelClose");
    await vpage.waitForTimeout(300);
    const video = vpage.video();
    await vpage.close();
    await vctx.close();
    if (video) {
      const target = path.join(SHOTS, "d2b-morph.webm");
      await video.saveAs(target);
      videoOut = path.relative(WEB, target).replace(/\\/g, "/");
    }
  } catch (e) {
    errors.push("video: " + e.message);
    console.log("ВИДЕО: не вышло — " + e.message);
  }
} finally {
  await browser.close();
  server.close();
}

// Отчёт в консоль.
let ok = true;
for (const r of results) {
  const chromeOk = r.chromePct <= 40;
  const fontOk = r.minFont >= 11;
  const targetOk = r.minTarget >= 44;
  if (!chromeOk || !fontOk || !targetOk || r.hScroll > 0 || r.panelOverflow > 0) ok = false;
  console.log(
    `${r.file.padEnd(14)} s=${r.state} m=${r.mode}  хром ${r.chromePx}px = ${r.chromePct}% ${chromeOk ? "OK" : "FAIL"}  ` +
    `шрифт≥${r.minFont}px ${fontOk ? "OK" : "FAIL"}  тап≥${r.minTarget}px ${targetOk ? "OK" : "FAIL"}`
  );
  console.log(`   ${r.parts.map((p) => `${p.cls}[${p.top}..${p.bottom}]`).join(" ")}`);
  if (r.smallTargets.length) console.log("   мелкие зоны: " + r.smallTargets.map((t) => `${t.label} ${t.w}x${t.h}`).join("; "));
  if (r.panelOverflow > 0) console.log(`   панель переполнена на ${r.panelOverflow}px`);
  if (r.hScroll > 0) console.log(`   h-scroll ${r.hScroll}px`);
}

for (const [mode, pairs] of Object.entries(PAIRS)) {
  const min = Math.min(...Object.values(pairs));
  console.log(
    `контраст ${mode === "day" ? "день" : "вечер"}: мин ${r2(min)}:1 — ` +
    Object.entries(pairs).map(([k, v]) => `${k} ${r2(v)}`).join(", ")
  );
  if (min < 4.5) ok = false;
}

console.log("видео: " + (videoOut || "нет"));
if (errors.length) console.log("ошибки страницы:\n  " + errors.join("\n  "));
console.log(ok ? "ИТОГ: замеры в норме" : "ИТОГ: есть нарушения, см. FAIL выше");
process.exitCode = ok ? 0 : 1;
