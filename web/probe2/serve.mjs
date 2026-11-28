// Локальный показ пробы D2b: статический сервер (LAN/Tailscale) на 8808.
// Отдаёт `web/`: /probe2/?s=1&m=day — интерактивная проба, /gallery — кадры.
// Нужен только для просмотра владельцем; в продукт не входит.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const webRoot = process.argv[2] ?? ".";
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webm": "video/webm",
  ".js": "text/javascript; charset=utf-8",
};

const SHOTS = [
  ["d2b3-3-day.png", "v3 · дом выбран: баблы с иконками, дом-якорь"],
  ["d2b3-1-day.png", "v3 · без выбора: расстояний нет (день)"],
  ["d2b3-1-eve.png", "v3 · без выбора: вечер со светом в окнах"],
  ["d2b3-2-day.png", "v3 · открытые слои"],
  ["d2b-1-day.png", "v2 (для сравнения) · день, баблы без иконок"],
  ["d2b-1-eve.png", "v2 (для сравнения) · вечер как жёлтая плёнка"],
];

function galleryHtml() {
  const items = SHOTS.map(
    ([file, caption]) =>
      `<figure><img src="/shots/${file}" alt="${caption}" loading="lazy"><figcaption>${caption}</figcaption></figure>`,
  ).join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Проба D2b — кадры</title>
<style>
body{margin:0;padding:16px;background:#0f1420;color:#e8eef7;font:16px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:20px;margin:0 0 4px}p{color:#9fb0c7;margin:0 0 16px;font-size:14px}
figure{margin:0 0 20px;background:#161d2c;border-radius:16px;padding:10px}
img{width:100%;height:auto;border-radius:10px;display:block}
figcaption{margin-top:8px;font-size:14px;color:#c7d4e6}
video{width:100%;border-radius:12px;margin-top:8px}
a{color:#1fbd68}
</style></head><body>
<h1>Проба D2b — пастельная диорама</h1>
<p>Кадры 390×844. Проба v3: <a href="/probe3/?s=1&m=day">без выбора · день</a> · <a href="/probe3/?s=1&m=eve">без выбора · вечер</a> · <a href="/probe3/?s=3&m=day">дом выбран</a> · <a href="/probe3/?s=2&m=day">слои</a></p>
<p>Проба v2 (для сравнения): <a href="/probe2/?s=1&m=day">день</a> · <a href="/probe2/?s=1&m=eve">вечер</a> · <a href="/probe2/?s=3&m=day">карточка</a></p>
${items}
<figure><figcaption>Морф «Слои» → карточка</figcaption><video src="/shots/d2b-morph.webm" controls playsinline muted loop></video></figure>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/gallery") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(galleryHtml());
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(302, { location: "/gallery" });
    res.end();
    return;
  }
  const rel = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
  const file = path.join(webRoot, decodeURIComponent(rel));
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found: " + url.pathname);
      return;
    }
    res.writeHead(200, {
      "content-type": types[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(buf);
  });
});

server.listen(8808, "0.0.0.0", () => {
  console.log("probe on http://0.0.0.0:8808/gallery");
});
