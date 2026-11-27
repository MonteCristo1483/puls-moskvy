# ADR-001 — как отдаём «живое» без бэкенда

**Статус:** принято (S1). **Дата:** 27.11.2026. **Владелец решения:** CTO. Заменяет: открытый вопрос №1 в CONTEXT.

## Контекст

Нужны свежие данные на статическом сайте: погода/ветер, прогноз воздуха, городские факты (ордера/разрешения). Бэкенда нет и не заводим: один человек, бюджет $0, Pages уже есть. Вопрос S1: остаёмся на статике или вводим минимальный прокси.

## Решение

| Данные | Как отдаём | Частота | Почему так |
|---|---|---|---|
| Погода, ветер | **браузер → Open-Meteo** напрямую | 15 мин, кэш браузера | CORS открыт, ключа нет, данные всегда свежие, нулевая инфраструктура |
| Прогноз воздуха (CAMS) | **браузер → Open-Meteo AQ** | 60 мин | то же |
| Ордера, разрешения (data.mos.ru) | **GitHub Actions cron → `live/*.json`** в gh-pages | 1×/сут, 06:00 MSK | ключ нельзя отдавать клиенту; 1 прогон ≈ 1–2 мин |
| POI, здания, PMTiles | статика из Release | 1×/мес | пересборка только с кодом |

**Бэкенд и Cloudflare Worker в MVP не вводим. S12 из роадмапа вырезается** (условие «S1 = нужен бэкенд» не наступило).

Контракт: `live/meta.json` = `{generated_at, stale, sources:{...}}`; версия файла в URL (`?v=<hash>`), потому что Pages не даёт `Cache-Control`. Деградация: последний валидный JSON не удаляется, слой пишет «данные от ЧЧ:ММ», при `stale >24 ч` скрывается с пояснением.

## Проверено 27.11.2026 (не выдумано)

- **CORS:** `GET api.open-meteo.com/v1/forecast` и `air-quality-api.open-meteo.com/v1/air-quality` по Москве (55.7558, 37.6173) → **200**, `access-control-allow-origin: *`, 191/220 мс, JSON с `current.temperature_2m / wind_speed_10m / wind_direction_10m / precipitation / pm2_5`. Браузерный fetch проходит без прокси.
- **Сборка без бэкенда:** `npm ci` 46 с (130 пакетов), `tsc --noEmit` — 0 ошибок, `next build` (Turbopack) — успешно, static export в `dist/` (`/`, `/r`, `404.html`).
- **Сеть:** из Node TLS работает; Windows schannel/`curl.exe` в этой среде падает (`SEC_E_NO_CREDENTIALS`) — на выводы не влияет, но локальные проверки делать через Node.

## Цена и лимиты (первоисточники — в конце)

| Узел | Бесплатно | Ключевые лимиты | Платно |
|---|---|---|---|
| Open-Meteo | **$0** | 600/мин, 5 000/ч, 10 000/сут, 300 000/мес **на IP клиента**; коммерция запрещена («non-commercial purposes»); overage нет — фиксированная цена | Standard 1M выз./мес, Professional 5M; цена в UI рендерит Stripe-виджет → **цена не подтверждена** `[не проверено]` |
| GitHub Actions | **$0** (public repo) | cron best-effort, задержки и «dropped» в пики; минимум 5 мин; только default branch; автootключение после 60 дней без активности | не нужен |
| GitHub Pages | **$0** | сайт ≤1 ГБ, 100 ГБ/мес soft, 10 сборок/ч (не действует для custom workflow), деплой ≤10 мин, своих заголовков кэша нет | не нужен |
| Cloudflare Workers | $0 | 100 000 зап./сут, Cron Triggers 5 на аккаунт, KV 100k чт./1k зап. в сут | Paid от $5/мес (10M зап./мес) |
| Cloudflare Pages | $0 | 500 сборок/мес, 20 000 файлов, 25 MiB/файл; трафик не документирован `[не проверено]` | не нужен |

**Итог по деньгам MVP: $0/мес**, пока нет монетизации. Первый платный порог — не хостинг, а лицензия Open-Meteo при коммерции.

## Следствия

1. Нагрузка на Open-Meteo = число **открытий** страницы, не число посетителей: квоты считаются на IP клиента, наш сервер не участвует. 10 000/сут на IP практически недостижимо.
2. «Живое» на клиенте не требует деплоя: погода обновляется без Actions, поэтому cron нужен только для того, что требует ключа.
3. Юридический блокер монетизации остаётся: бесплатный тариф Open-Meteo — только non-commercial. ODbL (OSM) и CC BY 4.0 (data.mos.ru) требуют видимой атрибуции — задача S10.
4. Cron может опаздывать и отключаться — значит UI обязан показывать время данных, а не обещать «реальное время» (S9).

## Когда пересматриваем

- трафик Pages >70 ГБ/мес или >8 деплоев/ч → Cloudflare Pages;
- появился источник без CORS или нужен серверный секрет, кроме data.mos.ru → Cloudflare Worker ($5);
- планируется монетизация → платный Open-Meteo, цену зафиксировать счётом, а не сайтом.

## Источники

- Open-Meteo: https://open-meteo.com/en/pricing · https://open-meteo.com/en/terms
- GitHub Pages: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- GitHub Actions: https://docs.github.com/en/billing/concepts/product-billing/github-actions · https://docs.github.com/en/actions/reference/events-that-trigger-workflows
- Cloudflare: https://developers.cloudflare.com/workers/platform/pricing/ · https://developers.cloudflare.com/pages/platform/limits/
