#!/usr/bin/env node
// Оркестратор смоук-тестов E1: статический экспорт → serve-test.mjs →
// Playwright → гашение сервера. Код возврата Playwright пробрасывается.
//
// Раскладка как на GitHub Pages: содержимое dist лежит в подпапке
// /puls-moskvy. Поэтому копируем dist в .pages-test/puls-moskvy
// (36 МБ, быстрее и безопаснее, чем симлинк на Windows).
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WEB_ROOT, "dist");
// Свой каталог на каждый прогон: раньше прогоны делили `.pages-test` и
// финальная уборка одного сносила файлы под ногами у другого — тесты падали
// с ERR_CONNECTION_REFUSED посреди набора. Теперь каталог уникален по PID.
const PAGES_ROOT = join(WEB_ROOT, `.pages-test-${process.pid}`);
const SITE = join(PAGES_ROOT, "puls-moskvy");
const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}/puls-moskvy/`;
const SERVER_TIMEOUT_MS = 30_000;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: WEB_ROOT,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

function prepareLayout() {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(PAGES_ROOT, { recursive: true });
  cpSync(DIST, SITE, { recursive: true });
}

async function waitForServer() {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // сервер ещё не слушает порт
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`сервер не поднялся за ${SERVER_TIMEOUT_MS / 1000} с: ${BASE_URL}`);
}

async function main() {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("Нет web/dist — сначала `npm run build`.");
    process.exitCode = 1;
    return;
  }

  // Страниц на дом больше нет: /r/ — одна страница приложения, старые
  // ссылки /r/<id>/ ловит public/404.html. Генератор в прогоне не участвует.
  prepareLayout();

  // Занятый порт — почти всегда живой сервер прошлого прогона. Если этого не
  // заметить, новый сервер не сможет привязаться, `waitForServer` увидит
  // ЧУЖОЙ сервер со старым содержимым, а тесты будут падать «на ровном месте».
  // Лучше отказаться сразу и внятно, чем получить загадочный обрыв.
  try {
    const probe = await fetch(BASE_URL, { signal: AbortSignal.timeout(1500) });
    if (probe.ok) {
      console.error(
        `Порт ${PORT} уже занят (${BASE_URL}) — вероятно, жив сервер прошлого прогона.\n` +
          "Остановите его (или задайте другой E2E_PORT) и повторите.",
      );
      process.exitCode = 1;
      rmSync(SITE, { recursive: true, force: true });
      return;
    }
  } catch {
    // никто не слушает — это то, что нам нужно
  }

  const server = spawn(
    process.execPath,
    [join(WEB_ROOT, "scripts", "serve-test.mjs"), PAGES_ROOT, String(PORT)],
    { cwd: WEB_ROOT, stdio: ["ignore", "inherit", "inherit"] },
  );
  let serverExited = false;
  // Ошибка привязки (EADDRINUSE) иначе превращается в необработанное событие
  // и непонятное падение — печатаем причину.
  server.once("error", (error) => {
    serverExited = true;
    console.error(`serve-test.mjs не запустился: ${error.message}`);
  });
  server.once("exit", () => {
    serverExited = true;
  });

  try {
    await waitForServer();
    if (serverExited) throw new Error("serve-test.mjs завершился до старта тестов");

    const require = createRequire(import.meta.url);
    const cli = require.resolve("@playwright/test/cli");
    const code = await run(
      process.execPath,
      [cli, "test", ...process.argv.slice(2)],
      { env: { ...process.env, E2E_BASE_URL: BASE_URL } },
    );
    process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    server.kill();
    rmSync(SITE, { recursive: true, force: true });
  }
}

await main();
