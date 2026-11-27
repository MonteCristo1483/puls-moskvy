# RUNBOOK — как проверить за 5 команд

Чистая машина, нужен Node 24 и git. Всё из корня репозитория.

```
git status -uno                                  # 1. дерево чистое, ветка актуальна
cd web && npm ci                                 # 2. зависимости ставятся (~46 с, 130 пакетов)
npx tsc --noEmit                                 # 3. типы: 0 ошибок
npm run build                                    # 4. static export в web/dist
npm run e2e                                      # 5. смоук-тесты: 9 passed
```

## Что означает «не работает»

- **`build` упал** — смотри `next.config.ts` (`basePath` = `/puls-moskvy`, `output: export`) и импорты с абсолютными путями.
- **`e2e` даёт 7/9, падают `layers` и `theme`** — в `web/public/data` нет данных: карта не поднимается, заставка перекрывает клики. Это не регрессия. Данные качаются из Release `data` (`data.zip`).
- **`e2e` даёт 9/9, но стрелок ветра нет** — слой не создался. Проверять не глазами: в консоли браузера `__map.queryRenderedFeatures({layers:["weather-wind-arrows"]}).length` должно быть > 0.

## Прод

`https://montecristo1483.github.io/puls-moskvy/` — открывается карта, в футере «Пульс Москвы», чип «Погода и ветер» включён, внизу слева плашка «−X,X °C · ветер Y,Y м/с / Данные на ЧЧ:ММ · Open-Meteo».

Данные на проде обновляет `Deploy` (ассет `data.zip` из Release `data`). Погода — из браузера, деплой для неё не нужен.

## Настройки репозитория (один раз, руками в GitHub)

- **Settings → Actions → General → Workflow permissions** → «Allow GitHub Actions to create and approve pull requests». Без этого `Autopilot` падает на шаге «Open PR if missing»: тесты зелёные, PR не создаётся.
- **Settings → General → Default branch** = `main`. `ci.yml`/`deploy.yml` триггерятся на `main`, `schedule` (S6) ходит только с дефолтной ветки.
- **Settings → Pages** → Source: «Deploy from a branch», ветка `gh-pages`. Появляется после первого успешного `Deploy`.

## Границы

- В `web/public/data` и `dist` коммитить нечего: это артефакты, они в `.gitignore`.
- Пуш ветки = авто-мерж и деплой. Пушим только проверенное.
- Дефолтная ветка должна быть `main` — иначе cron из S6 не запустится.
