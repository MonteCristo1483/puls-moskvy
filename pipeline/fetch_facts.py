#!/usr/bin/env python3
"""S6: городские факты data.mos.ru → `web/public/live/`.

Берёт набор 2855 «действующие ордера» (работы, перекрытия, раскопки) через
`mosru_api.py` и складывает нормализованный GeoJSON в `web/public/live/`:

  * `live/works.geojson` — FeatureCollection, свойства приведены к одному
    набору полей (см. `PROPERTY_KEYS`), даты — ISO, текст — без переводов
    строк, геометрия — как в источнике (2855 отдаёт MultiLineString,
    Polygon/MultiPolygon и MultiPoint; ничего не дорисовываем);
  * `live/meta.json` — контракт ARCHITECTURE §2:
    `{generated_at, fetched_at, sources, stale, version}`. С `--permits`
    туда же попадает счётчик набора 64028 «разрешения на ввод» (геометрии
    у него нет — см. DECISIONS, поэтому второй файл не пишем).

Главное свойство — **идемпотентность**: файлы перезаписываются только если
их содержимое изменилось байт в байт. Два прогона подряд на неизменном
источнике дают ноль изменений в git (приёмка S6). Поэтому `generated_at` —
время последнего *изменения данных*, а не последнего запуска: если
`works.geojson` не изменился, `generated_at`/`fetched_at` берутся из старого
`meta.json` и файл не переписывается.

Использование:
  python pipeline/fetch_facts.py                    # 2855 → live/
  python pipeline/fetch_facts.py --permits          # + счётчик 64028 в meta
  python pipeline/fetch_facts.py --out /tmp/live    # другая папка (проверки)
  python pipeline/fetch_facts.py --now 2026-11-27T03:00:00Z   # фиксировать время

Ключ: `MOSRU_API_KEY` в окружении или `.env` в корне (в git не попадает).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mosru_api import (  # noqa: E402
    MosRuError,
    dataset_count,
    features,
    http_json,
    require_key,
)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "web" / "public" / "live"

WORKS_DATASET = 2855  # «действующие ордера»: линии работ, геометрия есть
PERMITS_DATASET = 64028  # «разрешения на ввод»: geometry = null, только счётчик
SCHEMA_VERSION = 1
PAGE_SIZE = 1000  # ограничение портала на страницу

# Типы геометрии, которые отдаёт 2855. Point/LineString пока не встречались,
# но типы GeoJSON допустимы — не выкидываем их из-за отсутствия в выборке.
GEOMETRY_TYPES = {
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
}

# Порядок ключей в properties фиксирован: файл должен быть побайтово
# воспроизводим, а не зависеть от порядка атрибутов в ответе портала.
PROPERTY_KEYS = (
    "global_id",
    "order_number",
    "order_date",
    "work_start_date",
    "work_end_date",
    "customer",
    "work_type",
    "order_work",
    "address",
    "work_place",
    "district",
    "adm_area",
)

# Наборы, где даты приходят строкой «ДД.ММ.ГГГГ».
DATE_FIELDS = ("OrderDate", "WorkStartDate", "WorkEndDate")


class FactsError(RuntimeError):
    """Данные источника не соответствуют ожидаемому контракту."""


@dataclass
class RunResult:
    out_dir: Path
    rows: int
    dropped: int
    works_changed: bool
    meta_changed: bool
    permits_rows: int | None = None
    generated_at: str = ""

    @property
    def changed(self) -> bool:
        return self.works_changed or self.meta_changed


def utc_now(now: str | None = None) -> str:
    """Метка времени в UTC с «Z» (её разбирает JS `Date.parse`)."""
    if now:
        return now
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean_text(value: Any) -> str:
    """Текст без переводов строк и двойных пробелов (в источнике они есть)."""
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ", ".join(part for part in (clean_text(item) for item in value) if part)
    if isinstance(value, bool):
        return "да" if value else "нет"
    return " ".join(str(value).split())


def iso_date(value: Any) -> str | None:
    """«02.10.2020» → «2020-10-02». Пустое или битое значение → None."""
    text = clean_text(value)
    if not text:
        return None
    try:
        return datetime.strptime(text, "%d.%m.%Y").date().isoformat()
    except ValueError:
        return None


def text_list(value: Any, *, item_key: str | None = None) -> list[str]:
    """Список строк из значения API: строка, список строк или список объектов.

    Порядок источника сохраняется (в нём заложен смысл «1., 2., 3.»), дубли
    убираются: в 225 ордерах одна и та же работа приходит дважды.
    Элементы с `is_deleted = 1` пропускаются — портал помечает так удалённые.
    """
    if value is None:
        return []
    items = value if isinstance(value, (list, tuple)) else [value]
    result: list[str] = []
    for item in items:
        if isinstance(item, dict):
            if item.get("is_deleted"):
                continue
            item = item.get(item_key) if item_key else None
        text = clean_text(item)
        if text and text not in result:
            result.append(text)
    return result


def _finite(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def normalize_geometry(geometry: Any) -> dict | None:
    """Геометрия как в источнике, но без лишних ключей и с проверкой чисел.

    Возвращает None, если геометрии нет или она битая: такой объект нельзя
    класть на карту, а выдумывать координаты запрещено (ARCHITECTURE §6).
    """
    if not isinstance(geometry, dict):
        return None
    kind = geometry.get("type")
    if kind == "GeometryCollection":
        parts = geometry.get("geometries")
        if not isinstance(parts, list):
            return None
        clean = [part for part in (normalize_geometry(item) for item in parts) if part]
        return {"type": "GeometryCollection", "geometries": clean} if clean else None
    if kind not in GEOMETRY_TYPES:
        return None
    coordinates = geometry.get("coordinates")
    if not _valid_positions(coordinates):
        return None
    return {"type": kind, "coordinates": coordinates}


def _valid_positions(node: Any) -> bool:
    """Рекурсивная проверка: все листья — пары конечных чисел."""
    if not isinstance(node, (list, tuple)) or not node:
        return False
    if _finite(node[0]):
        return len(node) >= 2 and _finite(node[1])
    return all(_valid_positions(child) for child in node)


def first_position(geometry: dict | None) -> tuple[float, float] | tuple[()]:
    """Первая точка геометрии — вторичный ключ сортировки."""
    if not isinstance(geometry, dict):
        return ()
    node: Any = geometry.get("coordinates")
    if geometry.get("type") == "GeometryCollection":
        parts = geometry.get("geometries") or []
        if not parts:
            return ()
        node = parts[0].get("coordinates")
    while isinstance(node, (list, tuple)) and node:
        if _finite(node[0]) and len(node) >= 2 and _finite(node[1]):
            return (float(node[0]), float(node[1]))
        node = node[0]
    return ()


def normalize_feature(feature: dict) -> dict | None:
    """Один объект 2855 → Feature с фиксированным набором свойств."""
    if not isinstance(feature, dict):
        return None
    geometry = normalize_geometry(feature.get("geometry"))
    if geometry is None:
        return None
    attributes = (feature.get("properties") or {}).get("attributes")
    if not isinstance(attributes, dict):
        return None

    values: dict[str, Any] = {
        "global_id": attributes.get("global_id"),
        "order_number": clean_text(attributes.get("OrderNumber")),
        "order_date": iso_date(attributes.get("OrderDate")),
        "work_start_date": iso_date(attributes.get("WorkStartDate")),
        "work_end_date": iso_date(attributes.get("WorkEndDate")),
        "customer": clean_text(attributes.get("CustomerConstruction")),
        "work_type": text_list(attributes.get("WorkType")),
        "order_work": text_list(attributes.get("OrderWork"), item_key="OrderWork"),
        "address": clean_text(attributes.get("AddressOfNearbyBuilding")),
        "work_place": clean_text(attributes.get("WorkPlaceDescription")),
        "district": clean_text(attributes.get("District")),
        "adm_area": clean_text(attributes.get("AdmArea")),
    }
    # global_id — единственный стабильный идентификатор объекта в источнике.
    if not isinstance(values["global_id"], int):
        return None
    if not values["order_number"]:
        return None
    # Порядок ключей задаёт PROPERTY_KEYS, а не порядок в ответе портала.
    properties = {name: values[name] for name in PROPERTY_KEYS}
    return {"type": "Feature", "geometry": geometry, "properties": properties}


def sort_key(feature: dict) -> tuple:
    """Порядок объектов: номер ордера, затем координаты, затем global_id.

    Номер ордера в источнике уникален (проверено: 4109 записей, 0 дублей),
    global_id — страховка от полного совпадения: порядок обязан быть
    тотальным, иначе два прогона могут дать разные байты.
    """
    properties = feature["properties"]
    return (
        properties["order_number"],
        first_position(feature.get("geometry")),
        properties["global_id"],
    )


def build_collection(raw_features: list[dict]) -> tuple[dict, int]:
    """Собрать FeatureCollection: нормализация + сортировка."""
    normalized: list[dict] = []
    dropped = 0
    for feature in raw_features:
        clean = normalize_feature(feature)
        if clean is None:
            dropped += 1
            continue
        normalized.append(clean)
    normalized.sort(key=sort_key)
    return {"type": "FeatureCollection", "features": normalized}, dropped


def dump_bytes(payload: Any, *, pretty: bool = False) -> bytes:
    """Байты JSON: без NaN, с завершающим переводом строки, стабильно."""
    text = json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=False,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    )
    return (text + "\n").encode("utf-8")


def collect_features(
    dataset_id: int,
    *,
    key: str | None = None,
    fetch: Callable[[str], Any] = http_json,
    page_size: int = PAGE_SIZE,
) -> list[dict]:
    """Все объекты набора: портал отдаёт не больше `page_size` за запрос."""
    collected: list[dict] = []
    skip = 0
    while True:
        payload = features(dataset_id, key=key, top=page_size, skip=skip, fetch=fetch)
        batch = (payload or {}).get("features") or []
        if not isinstance(batch, list):
            raise FactsError(f"набор {dataset_id}: features — не список")
        collected.extend(batch)
        skip += len(batch)
        if len(batch) < page_size:
            break
    if not collected:
        raise FactsError(f"набор {dataset_id}: портал вернул 0 объектов")
    return collected


def build_meta(
    *,
    rows: int,
    generated_at: str,
    fetched_at: str,
    permits_rows: int | None = None,
) -> dict:
    """Контракт `live/meta.json` (ARCHITECTURE §2, ADR-001)."""
    sources: dict[str, dict] = {
        "works": {
            "dataset": WORKS_DATASET,
            "rows": rows,
            "fetched_at": fetched_at,
        }
    }
    if permits_rows is not None:
        sources["permits"] = {
            "dataset": PERMITS_DATASET,
            "rows": permits_rows,
            "fetched_at": fetched_at,
        }
    return {
        "generated_at": generated_at,
        "fetched_at": fetched_at,
        "sources": sources,
        "stale": False,
        "version": SCHEMA_VERSION,
    }


def read_meta(path: Path) -> dict | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def write_if_changed(path: Path, payload: bytes) -> bool:
    """Записать файл, только если его содержимое отличается байт в байт.

    Это и есть приёмка S6 (diff=0): повторный прогон на неизменном источнике
    не трогает ни байта, поэтому git не видит изменений.
    """
    try:
        if path.read_bytes() == payload:
            return False
    except FileNotFoundError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return True


def run(
    out_dir: Path = DEFAULT_OUT,
    *,
    key: str | None = None,
    fetch: Callable[[str], Any] = http_json,
    now: str | None = None,
    permits: bool = False,
    log: Callable[[str], None] | None = None,
) -> RunResult:
    """Один прогон пайплайна. Ничего не пишет, если данные не изменились."""
    say = log or (lambda _message: None)
    api_key = require_key(key)
    stamp = utc_now(now)

    raw = collect_features(WORKS_DATASET, key=api_key, fetch=fetch)
    collection, dropped = build_collection(raw)
    rows = len(collection["features"])
    if rows == 0:
        raise FactsError("после нормализации не осталось ни одного объекта")

    permits_rows = None
    if permits:
        permits_rows = dataset_count(PERMITS_DATASET, key=api_key, fetch=fetch)

    out_dir = Path(out_dir)
    works_path = out_dir / "works.geojson"
    meta_path = out_dir / "meta.json"
    previous = read_meta(meta_path)

    works_changed = write_if_changed(works_path, dump_bytes(collection))
    # generated_at — время последнего изменения данных. Данные не изменились —
    # сохраняем прежние метки, иначе meta.json менялся бы каждый прогон.
    if works_changed:
        generated_at, fetched_at = stamp, stamp
    else:
        generated_at = _text(previous, "generated_at") or stamp
        fetched_at = _text(previous, "fetched_at") or generated_at

    meta = build_meta(
        rows=rows,
        generated_at=generated_at,
        fetched_at=fetched_at,
        permits_rows=permits_rows,
    )
    meta_changed = write_if_changed(meta_path, dump_bytes(meta, pretty=True))

    say(f"works.geojson: {rows} объектов, пропущено {dropped}")
    say(f"works.geojson: {'записан' if works_changed else 'без изменений'}")
    say(f"meta.json: {'записан' if meta_changed else 'без изменений'}")
    return RunResult(
        out_dir=out_dir,
        rows=rows,
        dropped=dropped,
        works_changed=works_changed,
        meta_changed=meta_changed,
        permits_rows=permits_rows,
        generated_at=generated_at,
    )


def _text(meta: dict | None, name: str) -> str | None:
    if not isinstance(meta, dict):
        return None
    value = meta.get(name)
    return value if isinstance(value, str) and value else None


def _fail(message: str) -> None:
    print(f"Ошибка: {message}", file=sys.stderr)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::error::{message}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass  # подменённый поток (тесты) или уже закрытый

    parser = argparse.ArgumentParser(
        description="Факты data.mos.ru → web/public/live/ (S6)"
    )
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="папка выгрузки")
    parser.add_argument(
        "--permits",
        action="store_true",
        help="добавить в meta.json счётчик набора 64028 (без геометрии)",
    )
    parser.add_argument(
        "--now",
        default=None,
        help="зафиксировать время, ISO UTC (для проверок воспроизводимости)",
    )
    args = parser.parse_args(argv)

    try:
        result = run(
            Path(args.out),
            now=args.now,
            permits=args.permits,
            log=lambda line: print(line),
        )
    except (MosRuError, FactsError) as exc:
        _fail(str(exc))
        return 1

    print(f"Данные на {result.generated_at} · {result.out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
