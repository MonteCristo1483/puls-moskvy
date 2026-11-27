# HANDOFF — новая сессия начинается здесь

Одна страница. Всё остальное — в `docs/CONTEXT.md` (состояние), `docs/DECISIONS.md` (почему), `docs/PRODUCT.md` (что за продукт), `docs/ROADMAP.md` (план и приёмки).

## Где мы

- Старый репозиторий `karta-okruzheniya` **заморожен** — в нём ничего не делаем, прод живёт как есть.
- Новый проект: **`puls-moskvy`** (https://github.com/MonteCristo1483/puls-moskvy), публичный, ветка `master`, локальная папка `C:\Users\starg\OneDrive\Документы\GitHub\moscow-live`.
- Перенесён движок (`web/`, `pipeline/`, `config/`, CI) без данных, `node_modules` и артефактов.
- Документы готовы: BRIEF, PRODUCT, ROADMAP, ARCHITECTURE, WORKFLOW, DECISIONS, CONTEXT.
- Ничего не задеплоено, данных в проекте нет, зависимости не установлены.

## Следующий шаг

**S1 из `docs/ROADMAP.md`:** ADR на 1 страницу — как отдавать «живое» без бэкенда (GitHub Actions cron + JSON-артефакт vs Cloudflare Worker), с ценой, лимитами и тестом CORS. Результат — `docs/ADR-001-live-data.md`.

После S1 — **S2**: слой погоды и ветра (Open-Meteo) на карте.

## Правила, которые нельзя забывать

- Одна задача — один бриф — один отчёт ≤12 строк; в контекст оркестратора только цифры.
- `git status -uno`, `git commit --no-status`; пуш ветки = авто-мерж и деплой, поэтому пушим только готовое.
- Модель по умолчанию `opencode-go/deepseek-v4.1-flash#high`.
- Никаких выдуманных замеров; у каждого слоя — источник и дата.
- Данные — только OSM (ODbL), data.mos.ru (CC BY 4.0), Open-Meteo; бесплатный Open-Meteo нельзя использовать при монетизации.

## Первое сообщение новой сессии

«Прочитай `docs/HANDOFF.md` и `docs/CONTEXT.md`. Запускай S1 по роадмапу, дальше — по плану. Работаем агентами, ты оркестратор.»
