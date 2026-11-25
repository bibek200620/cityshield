import csv
import json
from pathlib import Path

import pytest

from app.ml.ifi_inventory import (
    FIELDS,
    IFIInventoryError,
    SOURCE_ID,
    prepare_records,
    source_md5,
    validate_derived_records,
    write_derived_inventory,
)
from app.ml.flood_event_data import load_manifest


SOURCE_HEADERS = ["UEI", "Event Souce ID", "Start Date", "End Date", "Main Cause", "Districts", "Event Source"]


def _write_source(path: Path, rows: list[list[str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.writer(output)
        writer.writerow(SOURCE_HEADERS)
        writer.writerows(rows)


def test_source_subset_is_checksum_pinned_and_contains_53_ineligible_city_district_records():
    source_path = Path(__file__).parents[1] / "data/flood_events/ifi_bengaluru_urban.csv"
    with source_path.open(encoding="utf-8", newline="") as source:
        records = list(csv.DictReader(source))

    assert len(records) == 53
    assert len({record["record_id"] for record in records}) == 53
    assert {record["source_id"] for record in records} == {SOURCE_ID}
    assert {record["source_file_md5"] for record in records} == {"fea75a9ff9eba8fb328eaddfacd21d67"}
    assert all(record["location_precision"] == "district" for record in records)
    assert all(not record["latitude"] and not record["longitude"] for record in records)
    assert all(record["evaluation_eligible"] == "false" for record in records)
    assert all("district_scale_only" in json.loads(record["quality_flags"]) for record in records)
    validate_derived_records(records)


def test_manifest_documents_the_matching_source_version_and_license():
    manifest = load_manifest()
    source = next(item for item in manifest["sources"] if item["source_id"] == SOURCE_ID)

    assert source["url"] == "https://zenodo.org/records/11275211"
    assert source["license"] == "CC BY 4.0"
    assert source["source_file_md5"] == "fea75a9ff9eba8fb328eaddfacd21d67"
    assert source["derived_file"] == "backend/data/flood_events/ifi_bengaluru_urban.csv"
    assert source["derived_record_count"] == 53


def test_prepare_filters_exact_district_and_keeps_source_date_precision(tmp_path):
    source = tmp_path / "source.csv"
    _write_source(source, [
        ["UEI-1", "", "01-02-2020 00:00", "02-02-2020 00:00", "flood", "Bengaluru Urban, Mysuru", "IMD"],
        ["UEI-2", "", "03-02-2020 00:00", "03-02-2020 00:00", "heavy rain", "Bengaluru Rural", "IMD"],
    ])

    records = prepare_records(source)

    assert len(records) == 1
    assert records[0]["record_id"] == "UEI-1"
    assert records[0]["event_start_date"] == "2020-02-01"
    assert records[0]["event_end_date"] == "2020-02-02"
    assert records[0]["event_time_precision"] == "date_range_only"
    assert "source_record_covers_multiple_districts" in json.loads(records[0]["quality_flags"])
    assert records[0]["evaluation_eligible"] == "false"


def test_prepare_rejects_duplicate_source_event_ids(tmp_path):
    source = tmp_path / "source.csv"
    row = ["UEI-1", "", "01-02-2020 00:00", "01-02-2020 00:00", "flood", "Bengaluru Urban", "IMD"]
    _write_source(source, [row, row])

    with pytest.raises(IFIInventoryError, match="duplicate UEI"):
        prepare_records(source)


def test_derived_validation_rejects_inferred_coordinates(tmp_path):
    source = tmp_path / "source.csv"
    _write_source(source, [["UEI-1", "", "01-02-2020 00:00", "01-02-2020 00:00", "flood", "Bengaluru Urban", "IMD"]])
    records = prepare_records(source)
    records[0]["latitude"] = "12.97"

    with pytest.raises(IFIInventoryError, match="must not have inferred coordinates"):
        validate_derived_records(records)


def test_derived_validation_rejects_reversed_dates_and_inaccurate_precision(tmp_path):
    source = tmp_path / "source.csv"
    _write_source(source, [["UEI-1", "", "01-02-2020 00:00", "02-02-2020 00:00", "flood", "Bengaluru Urban", "IMD"]])
    records = prepare_records(source)
    records[0]["event_end_date"] = "2020-01-31"
    with pytest.raises(IFIInventoryError, match="ends before it starts"):
        validate_derived_records(records)

    records = prepare_records(source)
    records[0]["event_time_precision"] = "date_only"
    with pytest.raises(IFIInventoryError, match="inconsistent event time precision"):
        validate_derived_records(records)


def test_cli_writer_requires_published_source_checksum(tmp_path):
    source = tmp_path / "source.csv"
    output = tmp_path / "derived.csv"
    _write_source(source, [["UEI-1", "", "01-02-2020 00:00", "01-02-2020 00:00", "flood", "Bengaluru Urban", "IMD"]])

    with pytest.raises(IFIInventoryError, match="source checksum does not match"):
        write_derived_inventory(source, output)

    assert source_md5(source)
    assert not output.exists()


def test_csv_header_is_explicit_and_stable():
    assert len(FIELDS) == len(set(FIELDS))
    assert FIELDS[0] == "record_id"
    assert FIELDS[-2:] == ("evaluation_eligible", "evaluation_exclusion_reason")
