// Временный замер формы бабла D2b-4 (в git не идёт).
// Запуск: cd web && node probe3/_measure.mjs
//
// 1. поднимает web/probe3 как статический сервер;
// 2. для day/eve в состоянии s=3 снимает геометрию path[data-bubble-path="1"]:
//    getBBox() + points через getPointAtLength(), ширины в полосах top+3 / bottom-3;
// 3. проверяет, что текст внутри формы с отступом >= 4px;
// 4. считает контраст .b-main против реального фона бабла (--bubble поверх --map);
// 5. снимает кадры d2b4-* в web/shots/.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(PROBE, "..");
const SHOTS = path.join(WEB, "shots");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

function serve(root) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = path.join(root, url === "/" ? "index.html" : url);
    if (!file.startsWith(root)) return res.writeHead(403).end("forbidden");
    fs.readFile(file, (err, buf) => {
      if (err) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
      }).end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const MEASURE_BUBBLE = (sel) => {
  const bubble = document.querySelector(sel);
  const pathEl = bubble.querySelector('[data-bubble-path="1"]');
  const bbox = pathEl.getBBox();
  const ctm = pathEl.getScreenCTM();
  const toScreen = (x, y) => {
    const p = new DOMPoint(x, y).matrixTransform(ctm);
    return { x: p.x, y: p.y };
  };

  // точки по длине пути (шаг 0,25 px) — как требует приёмка
  const len = pathEl.getTotalLength();
  const step = 0.25;
  const pts = [];
  for (let l = 0; l <= len; l += step) {
    const p = pathEl.getPointAtLength(Math.min(l, len));
    pts.push({ x: p.x, y: p.y });
  }
  if (pts.length && (pts[0].x !== pts[pts.length - 1].x || pts[0].y !== pts[pts.length - 1].y)) {
    pts.push({ ...pts[0] });
  }

  // ширина фигуры в полосе y = Y: пересечения пути горизонталью Y
  const widthAt = (Y) => {
    const xs = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if ((a.y - Y) * (b.y - Y) > 0 || a.y === b.y) continue;
      const t = (Y - a.y) / (b.y - a.y);
      xs.push(a.x + t * (b.x - a.x));
    }
    if (!xs.length) return null;
    return Math.max(...xs) - Math.min(...xs);
  };

  const yTop = bbox.y + 3;
  const yBot = bbox.y + bbox.height - 3;
  const wTop = widthAt(yTop);
  const wBot = widthAt(yBot);

  // текст/иконка внутри контура (в экранных px)
  const tl = toScreen(bbox.x, bbox.y);
  const br = toScreen(bbox.x + bbox.width, bbox.y + bbox.height);
  const inside = {};
  for (const [name, el] of [
    ["main", bubble.querySelector(".b-main")],
    ["sub", bubble.querySelector(".b-sub")],
    ["icon", bubble.querySelector(".b-icon")],
  ]) {
    const r = el.getBoundingClientRect();
    inside[name] = {
      left: +(r.left - tl.x).toFixed(2),
      right: +(br.x - r.right).toFixed(2),
      top: +(r.top - tl.y).toFixed(2),
      bottom: +(br.y - r.bottom).toFixed(2),
      min: +Math.min(r.left - tl.x, br.x - r.right, r.top - tl.y, br.y - r.bottom).toFixed(2),
    };
  }

  return {
    bbox: { x: +bbox.x.toFixed(2), y: +bbox.y.toFixed(2), w: +bbox.width.toFixed(2), h: +bbox.height.toFixed(2) },
    wTop: +wTop.toFixed(2),
    wBot: +wBot.toFixed(2),
    ratio: +(wBot / wTop).toFixed(3),
    trueRatio: +(wBot / bbox.width).toFixed(3),
    inside,
    box: {
      w: +bubble.getBoundingClientRect().width.toFixed(2),
      h: +bubble.getBoundingClientRect().height.toFixed(2),
    },
  };
};

// Контраст WCAG: цвет .b-main против композита --bubble поверх --map.
const MEASURE_CONTRAST = () => {
  const parse = (s) => {
    s = s.trim();
    if (s.startsWith("#")) {
      const h = s.slice(1);
      if (h.length === 3) {
        return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 };
      }
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    const n = s.match(/[\d.]+/g).map(Number);
    return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
  };
  const css = (el, prop) => getComputedStyle(el).getPropertyValue(prop).trim();
  const root = document.documentElement;
  const ink = parse(css(document.querySelector(".b-main"), "color"));
  const bubble = parse(css(document.querySelector(".b-shape path"), "fill"));
  const map = parse(css(root, "--map"));
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * lin(c.r / 255) + 0.7152 * lin(c.g / 255) + 0.0722 * lin(c.b / 255);
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const bg = over(bubble, map);
  const sub = parse(css(document.querySelector(".b-sub"), "color"));
  return {
    contrast: +ratio(ink, bg).toFixed(2),
    contrastSub: +ratio(sub, bg).toFixed(2),
    ink: `rgb(${Math.round(ink.r)}, ${Math.round(ink.g)}, ${Math.round(ink.b)})`,
    bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
    bubbleRaw: css(root, "--bubble"),
    mapRaw: css(root, "--map"),
  };
};

fs.mkdirSync(SHOTS, { recursive: true });
const { server, base } = await serve(PROBE);
const browser = await chromium.launch();
const errors = [];

const SHOT_LIST = [
  { file: "d2b4-1-day.png", url: "/?s=1&m=day" },
  { file: "d2b4-1-eve.png", url: "/?s=1&m=eve" },
  { file: "d2b4-2-day.png", url: "/?s=2&m=day" },
  { file: "d2b4-2-eve.png", url: "/?s=2&m=eve" },
  { file: "d2b4-3-day.png", url: "/?s=3&m=day" },
  { file: "d2b4-3-eve.png", url: "/?s=3&m=eve" },
];

const rows = [];
let cropPath = null;

try {
  for (const shot of SHOT_LIST) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
      locale: "ru-RU",
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${shot.file}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${shot.file}: ${m.text()}`));
    await page.goto(base + shot.url, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(SHOTS, shot.file), animations: "disabled" });

    if (shot.url.includes("s=3")) {
      const mode = shot.url.includes("m=eve") ? "eve" : "day";
      const parks = await page.evaluate(MEASURE_BUBBLE, ".b-parks");
      const all = { ".b-parks": parks };
      for (const sel of [".b-schools", ".b-shops", ".b-gardens", ".b-transport"]) {
        all[sel] = await page.evaluate(MEASURE_BUBBLE, sel);
      }
      const c = await page.evaluate(MEASURE_CONTRAST);
      rows.push({ mode, parks, all, c });

      if (mode === "day") {
        const box = await page.locator(".b-parks").boundingBox();
        const clip = {
          x: Math.max(0, box.x - 20),
          y: Math.max(0, box.y - 20),
          width: Math.min(390 - Math.max(0, box.x - 20), box.width + 40),
          height: box.height + 40,
        };
        await page.screenshot({ path: path.join(SHOTS, "d2b4-bubble.png"), clip, animations: "disabled" });
        cropPath = "web/shots/d2b4-bubble.png";
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

let ok = true;
for (const row of rows) {
  const r = row.parks;
  const ratioOk = r.ratio >= 0.55 && r.ratio <= 0.65;
  const marginOk = r.inside.main.min >= 4;
  const contrastOk = row.c.contrast >= 4.5;
  if (!ratioOk || !marginOk || !contrastOk) ok = false;
  console.log(
    `${row.mode.padEnd(3)} .b-parks  w_top=${r.wTop}  w_bottom=${r.wBot}  ratio=${r.ratio} ` +
    `(true ${r.trueRatio}) ${ratioOk ? "OK" : "FAIL"}`
  );
  console.log(
    `    box ${r.box.w}x${r.box.h}  bbox ${r.bbox.w}x${r.bbox.h}  ` +
    `text margin main=${r.inside.main.min} sub=${r.inside.sub.min} icon=${r.inside.icon.min} ${marginOk ? "OK" : "FAIL"}`
  );
  console.log(
    `    контраст .b-main ${row.c.contrast}:1 ${contrastOk ? "OK" : "FAIL"}  (.b-sub ${row.c.contrastSub}:1)  ` +
    `ink ${row.c.ink} на ${row.c.bg}`
  );
  const others = Object.entries(row.all)
    .filter(([sel]) => sel !== ".b-parks")
    .map(([sel, v]) => `${sel.replace(".b-", "")} ${v.wTop}/${v.wBot}=${v.ratio}`)
    .join("  ");
  console.log(`    остальные: ${others}`);
}

console.log(`кадры: ${SHOT_LIST.map((s) => "web/shots/" + s.file).join(", ")}, ${cropPath || "кроп нет"}`);
if (errors.length) console.log("ошибки страницы:\n  " + errors.join("\n  "));
console.log(ok ? "ИТОГ: в норме" : "ИТОГ: есть нарушения, см. FAIL");
process.exitCode = ok ? 0 : 1;
