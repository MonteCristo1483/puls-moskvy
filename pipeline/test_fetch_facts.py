"""Тесты пайплайна фактов S6: нормализация и идемпотентность, без сети.

Сеть подменяется на уровне `fetch` (как в `test_mosru_api.py`): ответы портала
собираются в фикстуру, поэтому тесты не зависят от ключа и доступности
data.mos.ru, а проверяют ровно контракт выгрузки и «второй прогон не меняет
ни байта».
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_facts as ff  # noqa: E402

FIRST_AT = "2026-11-27T03:14:00Z"
SECOND_AT = "2026-11-28T03:14:05Z"


def raw_feature(
    order_number: str,
    *,
    global_id: int,
    coordinates: list,
    order_date: str = "02.10.2020",
    work_type=None,
    order_work=None,
    work_place: str = "",
    district: str = "район Гольяново",
    geometry_type: str = "MultiLineString",
) -> dict:
    """Объект в форме ответа `/datasets/2855/features` (атрибуты вложенные)."""
    attributes = {
        "global_id": global_id,
        "OrderNumber": order_number,
        "OrderDate": order_date,
        "WorkStartDate": "05.10.2020",
        "WorkEndDate": "27.05.2025",
        "CustomerConstruction": "Акционерное общество «ГЛОРИ»",
        "CustomerConstructionINN": "7718083824",  # лишнее поле: в выгрузку не идёт
        "WorkType": (
            ["1. Земляные работы", "1. Земляные работы", "2. Установка временных ограждений"]
            if work_type is None
            else work_type
        ),
        "OrderWork": (
            [
                {"global_id": 263017, "is_deleted": 0, "OrderWork": "установка ограждений"},
                {"global_id": 263018, "is_deleted": 0, "OrderWork": "установка ограждений"},
                {"global_id": 263019, "is_deleted": 1, "OrderWork": "удалённая работа"},
            ]
            if order_work is None
            else order_work
        ),
        "AddressOfNearbyBuilding": "",
        "WorkPlaceDescription": work_place,
        "District": district,
        "AdmArea": "Восточный административный округ",
    }
    if geometry_type == "GeometryCollection":
        geometry = {
            "type": "GeometryCollection",
            "geometries": [
                {"type": "MultiLineString", "coordinates": coordinates},
                {"type": "MultiPoint", "coordinates": [coordinates[0][0]]},
            ],
        }
    else:
        geometry = {"type": geometry_type, "coordinates": coordinates}
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": {
            "datasetId": 2855,
            "rowId": None,
            "attributes": attributes,
            "releaseNumber": 1,
            "versionNumber": 1,
        },
    }


def fixture() -> list[dict]:
    """Три ордера: порядок в ответе намеренно не совпадает с сортировкой."""
    return [
        raw_feature(
            "21040032",
            global_id=1081124118,
            coordinates=[[[37.75, 55.80], [37.76, 55.81]], [[37.77, 55.82], [37.75, 55.80]]],
            work_place="Амурская улица,\n владение 2А,  строение 1",
        ),
        raw_feature(
            "12010384/11",
            global_id=1060272606,
            coordinates=[[[37.60, 55.70], [37.61, 55.71]]],
            order_date="15.03.2021",
            work_type="1. Земляные работы",
            geometry_type="Polygon",
        ),
        raw_feature(
            "20090550",
            global_id=1081124912,
            coordinates=[[[37.70, 55.75], [37.71, 55.76]]],
            order_date="07.08.2019",
            district=["район Сокол", "район Аэропорт"],
            geometry_type="GeometryCollection",
        ),
    ]


class FakeMosRu:
    """Подмена `http_json`: страницы features и count без сети."""

    def __init__(self, features: list[dict], permits: int = 4019):
        self.items = features
        self.permits = permits
        self.urls: list[str] = []

    def __call__(self, url: str):
        self.urls.append(url)
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        if parsed.path.endswith("/features"):
            dataset = int(parsed.path.split("/")[-2])
            if dataset != ff.WORKS_DATASET:
                raise AssertionError(f"неожиданный набор {dataset}")
            top = int(query["$top"][0])
            skip = int(query["$skip"][0])
            return {"type": "FeatureCollection", "features": self.items[skip : skip + top]}
        if parsed.path.endswith("/count"):
            return str(self.permits)
        raise AssertionError(f"неожиданный запрос: {url}")


class TestNormalization(unittest.TestCase):
    @staticmethod
    def by_number(collection: dict, order_number: str) -> dict:
        for feature in collection["features"]:
            if feature["properties"]["order_number"] == order_number:
                return feature
        raise AssertionError(f"нет объекта {order_number}")

    def test_properties_have_fixed_keys_and_types(self):
        collection, dropped = ff.build_collection(fixture())
        self.assertEqual(dropped, 0)
        feature = self.by_number(collection, "20090550")
        self.assertEqual(list(feature["properties"]), list(ff.PROPERTY_KEYS))
        # Ни одного «сырого» поля из источника.
        self.assertNotIn("CustomerConstructionINN", feature["properties"])
        properties = feature["properties"]
        self.assertEqual(properties["order_date"], "2019-08-07")  # ISO, не ДД.ММ
        self.assertEqual(properties["work_start_date"], "2020-10-05")
        self.assertEqual(properties["customer"], "Акционерное общество «ГЛОРИ»")
        self.assertEqual(
            properties["work_type"],
            ["1. Земляные работы", "2. Установка временных ограждений"],
        )
        self.assertEqual(properties["order_work"], ["установка ограждений"])
        self.assertEqual(properties["district"], "район Сокол, район Аэропорт")
        self.assertEqual(properties["adm_area"], "Восточный административный округ")
        self.assertEqual(properties["address"], "")

    def test_work_place_whitespace_is_collapsed(self):
        raw = raw_feature(
            "21040032",
            global_id=1,
            coordinates=[[[37.75, 55.80], [37.76, 55.81]]],
            work_place="Амурская улица,\n владение 2А,  строение 1",
        )
        feature, _ = ff.build_collection([raw])
        self.assertEqual(
            feature["features"][0]["properties"]["work_place"],
            "Амурская улица, владение 2А, строение 1",
        )

    def test_dates_are_parsed_or_null(self):
        self.assertEqual(ff.iso_date("02.10.2020"), "2020-10-02")
        self.assertIsNone(ff.iso_date("31.02.2020"))
        self.assertIsNone(ff.iso_date(""))
        self.assertIsNone(ff.iso_date(None))

    def test_work_type_string_becomes_list(self):
        raw = raw_feature(
            "21040032",
            global_id=1,
            coordinates=[[[37.75, 55.80]]],
            work_type="1. Земляные работы",
        )
        feature, _ = ff.build_collection([raw])
        self.assertEqual(feature["features"][0]["properties"]["work_type"], ["1. Земляные работы"])

    def test_geometry_is_kept_as_is(self):
        collection, _ = ff.build_collection(fixture())
        geometry = self.by_number(collection, "20090550")["geometry"]
        self.assertEqual(geometry, fixture()[2]["geometry"])

    def test_broken_geometry_is_dropped_not_invented(self):
        raw = fixture()
        raw[0]["geometry"] = None
        raw[1]["geometry"] = {"type": "Nonsense", "coordinates": [[37.6, 55.7]]}
        raw[2]["geometry"] = {"type": "MultiLineString", "coordinates": [[[float("nan"), 55.7]]]}
        collection, dropped = ff.build_collection(raw)
        self.assertEqual(collection["features"], [])
        self.assertEqual(dropped, 3)

    def test_feature_without_global_id_is_dropped(self):
        raw = fixture()[0]
        raw["properties"]["attributes"]["global_id"] = None
        collection, dropped = ff.build_collection([raw])
        self.assertEqual(collection["features"], [])
        self.assertEqual(dropped, 1)


class TestDeterminism(unittest.TestCase):
    def test_sorted_by_order_number_then_coordinates(self):
        collection, _ = ff.build_collection(fixture())
        numbers = [f["properties"]["order_number"] for f in collection["features"]]
        self.assertEqual(numbers, ["12010384/11", "20090550", "21040032"])

    def test_same_input_any_order_gives_same_bytes(self):
        first = ff.dump_bytes(ff.build_collection(fixture())[0])
        reordered = list(reversed(fixture()))
        second = ff.dump_bytes(ff.build_collection(reordered)[0])
        self.assertEqual(first, second)
        self.assertTrue(first.endswith(b"\n"))

    def test_same_order_number_is_broken_by_coordinates(self):
        left = raw_feature("20030640", global_id=1, coordinates=[[[37.70, 55.75]]])
        right = raw_feature("20030640", global_id=2, coordinates=[[[37.60, 55.70]]])
        collection, _ = ff.build_collection([left, right])
        self.assertEqual(
            [f["properties"]["global_id"] for f in collection["features"]], [2, 1]
        )


class TestRun(unittest.TestCase):
    def run_once(self, out_dir: Path, items: list[dict], *, now: str, permits: bool = False):
        fake = FakeMosRu(items)
        result = ff.run(
            out_dir,
            key="test-key",
            fetch=fake,
            now=now,
            permits=permits,
        )
        return result, fake

    def test_second_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "live"
            first, _ = self.run_once(out, fixture(), now=FIRST_AT)
            self.assertTrue(first.works_changed)
            self.assertTrue(first.meta_changed)
            works = (out / "works.geojson").read_bytes()
            meta = (out / "meta.json").read_bytes()
            works_stat = (out / "works.geojson").stat().st_mtime_ns
            meta_stat = (out / "meta.json").stat().st_mtime_ns

            second, _ = self.run_once(out, fixture(), now=SECOND_AT)
            self.assertFalse(second.works_changed)
            self.assertFalse(second.meta_changed)
            self.assertFalse(second.changed)
            # Байты и время изменения файлов не сдвинулись.
            self.assertEqual((out / "works.geojson").read_bytes(), works)
            self.assertEqual((out / "meta.json").read_bytes(), meta)
            self.assertEqual((out / "works.geojson").stat().st_mtime_ns, works_stat)
            self.assertEqual((out / "meta.json").stat().st_mtime_ns, meta_stat)

    def test_generated_at_keeps_data_change_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "live"
            self.run_once(out, fixture(), now=FIRST_AT)
            self.run_once(out, fixture(), now=SECOND_AT)
            meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["generated_at"], FIRST_AT)
            self.assertEqual(meta["sources"]["works"]["fetched_at"], FIRST_AT)

    def test_changed_source_moves_generated_at(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "live"
            self.run_once(out, fixture(), now=FIRST_AT)
            changed = fixture() + [
                raw_feature(
                    "22070001",
                    global_id=1099999999,
                    coordinates=[[[37.61, 55.71]]],
                )
            ]
            second, _ = self.run_once(out, changed, now=SECOND_AT)
            self.assertTrue(second.works_changed)
            self.assertTrue(second.meta_changed)
            meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["generated_at"], SECOND_AT)
            self.assertEqual(meta["sources"]["works"]["rows"], 4)

    def test_meta_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "live"
            self.run_once(out, fixture(), now=FIRST_AT)
            meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(
                list(meta), ["generated_at", "fetched_at", "sources", "stale", "version"]
            )
            self.assertFalse(meta["stale"])
            self.assertEqual(meta["version"], ff.SCHEMA_VERSION)
            self.assertEqual(meta["sources"]["works"]["dataset"], 2855)
            self.assertEqual(meta["sources"]["works"]["rows"], 3)
            self.assertNotIn("permits", meta["sources"])

    def test_permits_count_goes_to_meta(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "live"
            result, fake = self.run_once(out, fixture(), now=FIRST_AT, permits=True)
            self.assertEqual(result.permits_rows, 4019)
            self.assertTrue(any("/count" in url for url in fake.urls))
            meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["sources"]["permits"]["dataset"], 64028)
            self.assertEqual(meta["sources"]["permits"]["rows"], 4019)

    def test_meta_is_restored_when_source_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "live"
            self.run_once(out, fixture(), now=FIRST_AT)
            (out / "meta.json").unlink()
            second, _ = self.run_once(out, fixture(), now=SECOND_AT)
            self.assertFalse(second.works_changed)
            self.assertTrue(second.meta_changed)
            meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["generated_at"], SECOND_AT)

    def test_geojson_is_valid_feature_collection(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "live"
            self.run_once(out, fixture(), now=FIRST_AT)
            payload = json.loads((out / "works.geojson").read_text(encoding="utf-8"))
            self.assertEqual(payload["type"], "FeatureCollection")
            self.assertEqual(len(payload["features"]), 3)
            for feature in payload["features"]:
                self.assertEqual(feature["type"], "Feature")
                self.assertIn(feature["geometry"]["type"], ff.GEOMETRY_TYPES | {"GeometryCollection"})


class TestFetching(unittest.TestCase):
    def test_paging_collects_everything(self):
        items = [
            raw_feature(
                f"21{index:06d}",
                global_id=1000 + index,
                coordinates=[[[37.6 + index / 1000, 55.7]]],
            )
            for index in range(25)
        ]
        fake = FakeMosRu(items)
        collected = ff.collect_features(2855, key="k", fetch=fake, page_size=10)
        self.assertEqual(len(collected), 25)
        self.assertEqual(len(fake.urls), 3)

    def test_empty_dataset_is_an_error(self):
        fake = FakeMosRu([])
        with self.assertRaises(ff.FactsError):
            ff.collect_features(2855, key="k", fetch=fake)


if __name__ == "__main__":
    unittest.main()
