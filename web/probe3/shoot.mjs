// D2b-3 — съёмка и замеры третьей пробы.
// Запуск: cd web && node probe3/shoot.mjs
//
// 1. берёт подложку web/probe3/bg.png (если её нет — копирует из web/probe2/);
// 2. снимает 4 PNG 390x844 @ DPR2 в web/shots/;
// 3. пишет видео: спокойное -> дом -> карточка -> назад -> слои;
// 4. считает по DOM хром, шрифт, зоны нажатия, контраст пар палитры,
//    видимость баблов и transform колец;
// 5. по пикселям кадров день/вечер — среднюю яркость и долю тёплого света.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(PROBE, "..");
const SHOTS = path.join(WEB, "shots");
const BG_SRC = path.join(WEB, "probe2", "bg.png");
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

// Контраст WCAG: пары реальных цветов палитры (композит — по альфе).
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const over = (fg, alpha, bg) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));

const INK_DAY = hex("#27405c");
const INK_EVE = hex("#f0e8dc");
const MAP_DAY = hex("#cce1fc");
const MAP_EVE = hex("#1a2334");
const SURF_DAY = hex("#cfd9f2");
const SURF_EVE = hex("#141a26");
const ACC_DAY = hex("#98f8c8");
const ACC_EVE = hex("#ffc978");
const WHITE = hex("#ffffff");

const BUBBLE_DAY = over(WHITE, 0.86, MAP_DAY);
const BUBBLE_EVE = over(hex("#151b27"), 0.9, MAP_EVE);
const TAG_DAY = over(WHITE, 0.78, MAP_DAY);
const TAG_EVE = over(hex("#131924"), 0.84, MAP_EVE);
const MUTED_DAY = hex("#45607b");
const MUTED_EVE = hex("#b8c3d2");
const ICONS_DAY = ["#17704a", "#2d5a94", "#94443a", "#7a5c22", "#4f4b96"].map(hex);
const ICONS_EVE = ["#86dfae", "#a6c9f2", "#f0b6a6", "#e3ca8b", "#c3bff5"].map(hex);

const PAIRS = {
  day: {
    "ink/шторка": ratio(INK_DAY, SURF_DAY),
    "ink/бабл": ratio(INK_DAY, BUBBLE_DAY),
    "ink/подсказка": ratio(INK_DAY, TAG_DAY),
    "вторичный/бабл": ratio(MUTED_DAY, BUBBLE_DAY),
    "вторичный/шторка": ratio(MUTED_DAY, SURF_DAY),
    "текст/акцент": ratio(INK_DAY, ACC_DAY),
  },
  eve: {
    "ink/шторка": ratio(INK_EVE, SURF_EVE),
    "ink/бабл": ratio(INK_EVE, BUBBLE_EVE),
    "ink/тег": ratio(INK_EVE, TAG_EVE),
    "вторичный/бабл": ratio(MUTED_EVE, BUBBLE_EVE),
    "вторичный/шторка": ratio(MUTED_EVE, SURF_EVE),
    "текст/акцент": ratio(hex("#231a0f"), ACC_EVE),
  },
};

const ICON_MIN = {
  day: Math.min(...ICONS_DAY.map((c) => ratio(c, BUBBLE_DAY))),
  eve: Math.min(...ICONS_EVE.map((c) => ratio(c, BUBBLE_EVE))),
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
  const rings = [...document.querySelectorAll(".ring")].map((el) => getComputedStyle(el).transform);

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
    bubbles: [...document.querySelectorAll(".bubble")].filter(visible).length,
    house: document.getElementById("houseBtn")?.getAttribute("aria-pressed"),
    lights: getComputedStyle(document.getElementById("lights")).display,
    seenRings: rings.slice(0, 1),
  };
};

// Пиксельные замеры кадров: яркость сцены и доля тёплых «фонарных» пикселей.
let sharp = null;
try {
  sharp = (await import("sharp")).default;
} catch {
  // без sharp просто пропустим пиксельные замеры
}

async function pixels(file) {
  if (!sharp) return null;
  const meta = await sharp(file).metadata();
  const dpr = meta.width / 390;
  const crop = {
    left: 0,
    top: Math.round(150 * dpr),
    width: Math.round(390 * dpr),
    height: Math.round(520 * dpr),
  };
  const { data, info } = await sharp(file).extract(crop).raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let sum = 0;
  let dark = 0;
  let warm = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += y;
    if (y < 96) dark += 1;
    if (r >= 235 && g >= 170 && b <= 185 && r - b >= 60) warm += 1;
  }
  return {
    px: `${info.width}x${info.height}`,
    avg: +(sum / n).toFixed(1),
    darkPct: +((dark / n) * 100).toFixed(1),
    warmPct: +((warm / n) * 100).toFixed(2),
  };
}

fs.mkdirSync(SHOTS, { recursive: true });
if (!fs.existsSync(BG_DST)) {
  if (!fs.existsSync(BG_SRC)) throw new Error("нет подложки: " + BG_SRC);
  fs.copyFileSync(BG_SRC, BG_DST);
}

const { server, base } = await serve(PROBE);
const browser = await chromium.launch();
const results = [];
const errors = [];
let videoOut = null;

try {
  const shots = [
    { file: "d2b3-1-day.png", url: "/?s=1&m=day" },
    { file: "d2b3-1-eve.png", url: "/?s=1&m=eve" },
    { file: "d2b3-2-day.png", url: "/?s=2&m=day" },
    { file: "d2b3-3-day.png", url: "/?s=3&m=day" },
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
    await page.waitForTimeout(450);
    const out = path.join(SHOTS, shot.file);
    await page.screenshot({ path: out, animations: "disabled" });
    const m = await page.evaluate(MEASURE);
    results.push({ file: shot.file, out: path.relative(WEB, out).replace(/\\/g, "/"), ...m });
    await ctx.close();
  }

  // Видео: дом выбирается тапом, карточка закрывается, затем открываются слои.
  try {
    const vctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      locale: "ru-RU",
      recordVideo: { dir: path.join(SHOTS, ".d2b3-video"), size: { width: 390, height: 844 } },
    });
    const vpage = await vctx.newPage();
    await vpage.goto(base + "/?s=1&m=day", { waitUntil: "load" });
    await vpage.evaluate(() => document.fonts.ready);
    await vpage.waitForTimeout(500);
    await vpage.click("#houseBtn");
    await vpage.waitForTimeout(700);
    await vpage.click("#sheetClose");
    await vpage.waitForTimeout(600);
    await vpage.click("#layersBtn");
    await vpage.waitForTimeout(650);
    await vpage.click("#panelClose");
    await vpage.waitForTimeout(350);
    const video = vpage.video();
    await vpage.close();
    await vctx.close();
    if (video) {
      const target = path.join(SHOTS, "d2b3-morph.webm");
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
  console.log(`   баблы: ${r.bubbles}, дом нажат: ${r.house}, свет: ${r.lights}`);
  if (r.seenRings[0]) console.log(`   transform кольца: ${r.seenRings[0]}`);
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
console.log(`контраст иконок в бабле: день ${r2(ICON_MIN.day)}:1, вечер ${r2(ICON_MIN.eve)}:1 (норма ≥3)`);
if (ICON_MIN.day < 3 || ICON_MIN.eve < 3) ok = false;

const dayPx = results.find((r) => r.file === "d2b3-1-day.png");
const evePx = results.find((r) => r.file === "d2b3-1-eve.png");
const [dayStats, eveStats] = await Promise.all([
  dayPx ? pixels(path.join(SHOTS, dayPx.file)) : null,
  evePx ? pixels(path.join(SHOTS, evePx.file)) : null,
]);
if (dayStats && eveStats) {
  console.log(
    `сцена ${dayStats.px}: день яркость ${dayStats.avg}/255 (тёмных ${dayStats.darkPct}%, тёплых ${dayStats.warmPct}%) · ` +
    `вечер яркость ${eveStats.avg}/255 (тёмных ${eveStats.darkPct}%, тёплых ${eveStats.warmPct}%)`
  );
  if (eveStats.avg >= dayStats.avg) {
    ok = false;
    console.log("   вечер не темнее дня — FAIL");
  }
  if (eveStats.warmPct <= 0.05) {
    ok = false;
    console.log("   на вечернем кадре не видно тёплого света — FAIL");
  }
} else {
  console.log("пиксельные замеры: sharp недоступен, пропущено");
}

console.log("видео: " + (videoOut || "нет"));
if (errors.length) console.log("ошибки страницы:\n  " + errors.join("\n  "));
console.log(ok ? "ИТОГ: замеры в норме" : "ИТОГ: есть нарушения, см. FAIL выше");
process.exitCode = ok ? 0 : 1;
