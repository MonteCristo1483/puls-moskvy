#!/usr/bin/env node
// ВРЕМЕННЫЙ пиксель-дифф двух PNG (не коммитится): node scripts/tmp-diff.mjs a.png b.png
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const [a, b] = process.argv.slice(2).map((p) => join(WEB_ROOT, p));
if (!a || !b) {
  console.error("usage: node scripts/tmp-diff.mjs a.png b.png");
  process.exit(1);
}
const toUrl = (p, type) =>
  `data:image/png;base64,${readFileSync(p).toString("base64")}#${type}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const res = await page.evaluate(
    async ([ua, ub]) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
      const [ia, ib] = await Promise.all([load(ua), load(ub)]);
      if (ia.width !== ib.width || ia.height !== ib.height) {
        return { error: `size ${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
      }
      const grab = (img) => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const da = grab(ia);
      const db = grab(ib);
      let diff = 0;
      let max = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(
          Math.abs(da[i] - db[i]),
          Math.abs(da[i + 1] - db[i + 1]),
          Math.abs(da[i + 2] - db[i + 2]),
        );
        if (d > 2) diff++;
        if (d > max) max = d;
      }
      return {
        pixels: da.length / 4,
        changed: diff,
        changedPct: Math.round((diff / (da.length / 4)) * 10000) / 100,
        maxChannelDelta: max,
      };
    },
    [toUrl(a, "a"), toUrl(b, "b")],
  );
  console.log(JSON.stringify(res));
} finally {
  await browser.close();
}
