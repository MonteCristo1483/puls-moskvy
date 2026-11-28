// Временный статик-сервер для локальной проверки GitHub Pages-раскладки
// (сайт в подпапке /puls-moskvy). Имитирует поведение Pages:
// подпапка → корень ветки gh-pages.
// Использование: node scripts/serve-test.mjs <корень-где-лежит-подпапка> [порт]
import { createServer } from "node:http";
import { open, readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const root = process.argv[2] ?? ".";
const port = Number(process.argv[3] ?? 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

// GitHub Pages на неизвестный путь отдаёт 404.html, ближайший вверх по дереву
// (на проде — из корня опубликованной ветки, т.е. <root>/<basePath>/404.html).
// Без этого старые ссылки /r/<id>/ в e2e проверять нечем.
async function readNotFoundPage(urlPath) {
  let dir = urlPath.endsWith("/") ? urlPath : urlPath.replace(/\/[^/]*$/, "/");
  for (;;) {
    const candidate = normalize(join(root, dir, "404.html"));
    if (candidate.startsWith(normalize(root))) {
      try {
        return await readFile(candidate);
      } catch {
        // 404.html на этом уровне нет — поднимаемся выше
      }
    }
    if (dir === "" || dir === "/") return null;
    dir = dir.replace(/\/[^/]+\/$/, "/");
  }
}

// Сервер тестовый, но обязан быть устойчивым: Playwright регулярно отменяет
// загрузки (уход со страницы, закрытие контекста), а крупных файлов у нас
// хватает — geojson работ 4.5 МБ, PMTiles, чанки. Раньше обрыв клиентом давал
// необработанную ошибку потока, процесс падал, и остальные тесты получали
// `ERR_CONNECTION_REFUSED` (флак, который дважды ломал прогон). Поэтому:
// • любая ошибка ответа гасится обработчиком `error` на res;
// • тело запроса обрабатывается в async-функции, чей reject не всплывает;
// • `clientError` (битый HTTP от клиента) закрывает сокет, а не процесс.
const server = createServer((req, res) => {
  // Клиент ушёл — не считаем это ошибкой сервера.
  res.on("error", () => {});
  req.on("error", () => {});

  const handle = async () => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    /** Отправка ответа с проверкой: после обрыва писать уже некуда. */
    const send = (status, headers, body) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, headers);
      res.end(body);
    };
    try {
      let path = urlPath;
      if (path.endsWith("/")) path += "index.html";
      const file = normalize(join(root, path));
      if (!file.startsWith(normalize(root))) {
        send(403, {}, "forbidden");
        return;
      }
      const fileStat = await stat(file);
      const headers = {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "content-length": fileStat.size,
        "accept-ranges": "bytes",
        "cache-control": "no-cache",
      };
      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (!match || fileStat.size === 0) {
          send(416, { "content-range": `bytes */${fileStat.size}` });
          return;
        }
        let start = match[1] ? Number(match[1]) : 0;
        let end = match[2] ? Number(match[2]) : fileStat.size - 1;
        if (!match[1] && match[2]) {
          const suffixLength = Number(match[2]);
          start = Math.max(0, fileStat.size - suffixLength);
          end = fileStat.size - 1;
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start >= fileStat.size ||
          end < start
        ) {
          send(416, { "content-range": `bytes */${fileStat.size}` });
          return;
        }
        end = Math.min(end, fileStat.size - 1);
        const body = Buffer.alloc(end - start + 1);
        const handleFile = await open(file, "r");
        try {
          await handleFile.read(body, 0, body.length, start);
        } finally {
          await handleFile.close();
        }
        send(
          206,
          {
            ...headers,
            "content-length": body.length,
            "content-range": `bytes ${start}-${end}/${fileStat.size}`,
          },
          body,
        );
        return;
      }
      if (req.method === "HEAD") {
        send(200, headers);
        return;
      }
      send(200, headers, await readFile(file));
    } catch {
      const page = await readNotFoundPage(urlPath).catch(() => null);
      if (page) {
        send(
          404,
          {
            "content-type": "text/html; charset=utf-8",
            "content-length": page.length,
            "cache-control": "no-cache",
          },
          page,
        );
        return;
      }
      send(404, {}, "not found");
    }
  };

  // Reject не должен всплывать наружу: он убивает процесс сервера.
  void handle().catch(() => {
    if (!res.writableEnded && !res.destroyed) {
      try {
        res.writeHead(500, {});
        res.end();
      } catch {
        // сокет уже закрыт — молча выходим
      }
    }
  });
});

server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  socket.destroy();
});

server.listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
