# RUNBOOK — как проверить за 5 команд

Чистая машина, нужен Node 24 и git. Всё из корня репозитория.

```
git status -uno                                  # 1. дерево чистое, ветка актуальна
cd web && npm ci                                 # 2. зависимости ставятся (~46 с, 130 пакетов)
npx tsc --noEmit                                 # 3. типы: 0 ошибок
npm run build                                    # 4. static export в web/dist
npm run e2e                                      # 5. смоук-тесты: 28 passed
```

## Что означает «не работает»

- **`build` упал** — смотри `next.config.ts` (`basePath` = `/puls-moskvy`, `output: export`) и импорты с абсолютными путями.
- **`e2e` красный на `layers` и `theme`** — в `web/public/data` нет данных: карта не поднимается, заставка перекрывает клики. Это не регрессия. Данные качаются из Release `data` (`data.zip`).
- **`e2e` зелёный, но стрелок ветра нет** — слой не создался. Проверять не глазами: в консоли браузера `__map.queryRenderedFeatures({layers:["weather-wind-arrows"]}).length` должно быть > 0.
- **`?t=HH:MM` не переживает перезагрузку** — значит `history.replaceState` не сработал (или параметр чужого формата: нужен `HH:MM`, МСК). Разбор — `parseClockParam` в `app/solar.ts`, чтение/запись — `app/timeline.tsx`; localStorage в этом не участвует вообще.

## Данные города (S6)

```
pip install -r pipeline/requirements.txt        # osmium, psycopg, shapely — нужны и старым тестам пайплайна
python pipeline/fetch_facts.py --permits        # тянет data.mos.ru по MOSRU_API_KEY из .env
git status --short web/public/live              # второй прогон подряд обязан быть пустым (приёмка S6)
```

`web/public/live/` — сгенерированные файлы: они коммитятся в `main` (скрипт или Action), потому что Deploy публикует только содержимое `web/dist`. `web/public/data/` — снапшот карты, в git не попадает.

## Прод

`https://montecristo1483.github.io/puls-moskvy/` — открывается карта, в футере «Пульс Москвы», чип «Погода и ветер» включён, внизу слева плашка «−X,X °C · ветер Y,Y м/с / Данные на ЧЧ:ММ · Open-Meteo», внизу по центру шкала «Сейчас / Было / Будет» (на телефоне — над плашками), справа сверху — «Данные на ДД.ММ ЧЧ:ММ · data.mos.ru · факты». `?t=08:00` открывает то же состояние на любом устройстве.

Данные на проде обновляет `Deploy` (ассет `data.zip` из Release `data`). Погода — из браузера, деплой для неё не нужен.

## Настройки репозитория (один раз, руками в GitHub)

- **Settings → Actions → General → Workflow permissions** → «Allow GitHub Actions to create and approve pull requests». Без этого `Autopilot` падает на шаге «Open PR if missing»: тесты зелёные, PR не создаётся.
- **Settings → General → Default branch** = `main`. `ci.yml`/`deploy.yml` триггерятся на `main`, `schedule` (S6) ходит только с дефолтной ветки.
- **Settings → Pages** → Source: «Deploy from a branch», ветка `gh-pages`. Появляется после первого успешного `Deploy`.

## Границы

- В `web/public/data` и `dist` коммитить нечего: это артефакты, они в `.gitignore`.
- Пуш ветки = авто-мерж и деплой. Пушим только проверенное.
- Дефолтная ветка должна быть `main` — иначе cron из S6 не запустится.
