"""Prepare the licensed IFI-Impacts v3 district event subset for Bengaluru Urban.

The inventory is district-scale historical evidence. Its rows are deliberately
not exposed as road observations or eligible flood-model evaluation labels.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any


SOURCE_MD5 = "fea75a9ff9eba8fb328eaddfacd21d67"
SOURCE_URL = "https://zenodo.org/records/11275211"
SOURCE_ID = "ifi-impacts-v3-bengaluru-urban"
FIELDS = (
    "record_id",
    "source_event_id",
    "event_start_date",
    "event_end_date",
    "event_time_precision",
    "reported_cause",
    "source_event_source",
    "districts_listed_by_source",
    "location_name",
    "location_precision",
    "latitude",
    "longitude",
    "source_id",
    "source_publisher",
    "source_url",
    "source_license",
    "source_license_url",
    "source_file_md5",
    "quality_flags",
    "evaluation_eligible",
    "evaluation_exclusion_reason",
)


class IFIInventoryError(ValueError):
    """Raised when the source or derived IFI subset is invalid."""


def source_md5(path: Path) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _date(value: str, field: str, record_id: str) -> str:
    # IFI v3 encodes source dates with a 00:00 time placeholder. The
    # placeholder is discarded; it does not represent an observed time.
    for fmt in ("%d-%m-%Y %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(value.strip(), fmt).date().isoformat()
        except (ValueError, AttributeError):
            continue
    raise IFIInventoryError(f"{record_id} has invalid {field}: {value!r}")


def prepare_records(source_path: Path) -> list[dict[str, Any]]:
    """Filter and normalize rows explicitly listing Bengaluru Urban."""
    required = {"UEI", "Start Date", "End Date", "Main Cause", "Districts", "Event Source"}
    with source_path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        missing = required - set(reader.fieldnames or ())
        if missing:
            raise IFIInventoryError(f"source is missing columns: {', '.join(sorted(missing))}")
        output: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in reader:
            districts = [part.strip() for part in (row.get("Districts") or "").split(",") if part.strip()]
            if "bengaluru urban" not in {name.casefold() for name in districts}:
                continue

            record_id = (row.get("UEI") or "").strip()
            if not record_id:
                raise IFIInventoryError("Bengaluru Urban row has no UEI")
            if record_id in seen:
                raise IFIInventoryError(f"duplicate UEI: {record_id}")
            seen.add(record_id)

            start_date = _date(row.get("Start Date") or "", "Start Date", record_id)
            end_date = _date(row.get("End Date") or "", "End Date", record_id)
            if end_date < start_date:
                raise IFIInventoryError(f"{record_id} ends before it starts")

            flags = [
                "official_inventory_record",
                "district_scale_only",
                "date_only_precision",
                "no_coordinates_in_source",
                "no_localized_flood_footprint",
                "no_event_matched_rainfall",
            ]
            if len(districts) > 1:
                flags.append("source_record_covers_multiple_districts")
            if start_date != end_date:
                flags.append("source_reports_date_range")

            output.append({
                "record_id": record_id,
                "source_event_id": (row.get("Event Souce ID") or "").strip(),
                "event_start_date": start_date,
                "event_end_date": end_date,
                "event_time_precision": "date_only" if start_date == end_date else "date_range_only",
                "reported_cause": (row.get("Main Cause") or "").strip(),
                "source_event_source": (row.get("Event Source") or "").strip(),
                "districts_listed_by_source": json.dumps(districts, ensure_ascii=False, separators=(",", ":")),
                "location_name": "Bengaluru Urban district",
                "location_precision": "district",
                "latitude": "",
                "longitude": "",
                "source_id": SOURCE_ID,
                "source_publisher": "HydroSense Lab, IIT Delhi; source inventory attributed to IMD",
                "source_url": SOURCE_URL,
                "source_license": "CC BY 4.0",
                "source_license_url": "https://creativecommons.org/licenses/by/4.0/",
                "source_file_md5": SOURCE_MD5,
                "quality_flags": json.dumps(flags, separators=(",", ":")),
                "evaluation_eligible": "false",
                "evaluation_exclusion_reason": (
                    "District-scale inventory event without localized observed flood extent/depth "
                    "or matched event rainfall; not suitable for road/node model evaluation."
                ),
            })

    if not output:
        raise IFIInventoryError("source contains no exact Bengaluru Urban district records")
    return sorted(output, key=lambda item: (item["event_start_date"], item["record_id"]))


def validate_derived_records(records: list[dict[str, Any]]) -> None:
    """Validate provenance, precision, uniqueness, and evaluation exclusion."""
    if not records:
        raise IFIInventoryError("derived event inventory is empty")
    ids: set[str] = set()
    for record in records:
        for field in FIELDS:
            if field not in record:
                raise IFIInventoryError(f"record is missing {field}")
        record_id = str(record["record_id"]).strip()
        if not record_id or record_id in ids:
            raise IFIInventoryError(f"missing or duplicate record_id: {record_id!r}")
        ids.add(record_id)
        start_date = _date(str(record["event_start_date"]), "event_start_date", record_id)
        end_date = _date(str(record["event_end_date"]), "event_end_date", record_id)
        if end_date < start_date:
            raise IFIInventoryError(f"{record_id} ends before it starts")
        expected_precision = "date_only" if start_date == end_date else "date_range_only"
        if record["event_time_precision"] != expected_precision:
            raise IFIInventoryError(f"{record_id} has inconsistent event time precision")
        if not str(record["reported_cause"]).strip():
            raise IFIInventoryError(f"{record_id} has no reported cause")
        if not str(record["source_event_source"]).strip():
            raise IFIInventoryError(f"{record_id} has no source event attribution")
        districts = json.loads(record["districts_listed_by_source"])
        if not isinstance(districts, list) or "Bengaluru Urban" not in districts:
            raise IFIInventoryError(f"{record_id} is not explicitly attributed to Bengaluru Urban")
        if record["location_precision"] != "district" or record["location_name"] != "Bengaluru Urban district":
            raise IFIInventoryError(f"{record_id} has unsupported location precision")
        if record["latitude"] or record["longitude"]:
            raise IFIInventoryError(f"{record_id} must not have inferred coordinates")
        if record["source_id"] != SOURCE_ID or record["source_file_md5"] != SOURCE_MD5:
            raise IFIInventoryError(f"{record_id} has unexpected source provenance")
        if record["evaluation_eligible"] != "false" or not record["evaluation_exclusion_reason"]:
            raise IFIInventoryError(f"{record_id} must remain excluded from model evaluation")
        flags = json.loads(record["quality_flags"])
        if "district_scale_only" not in flags or "no_coordinates_in_source" not in flags:
            raise IFIInventoryError(f"{record_id} is missing district-scale quality flags")
        if (len(districts) > 1) != ("source_record_covers_multiple_districts" in flags):
            raise IFIInventoryError(f"{record_id} has inconsistent multi-district quality flag")


def write_derived_inventory(source_path: Path, output_path: Path, *, verify_checksum: bool = True) -> int:
    if verify_checksum and source_md5(source_path) != SOURCE_MD5:
        raise IFIInventoryError(f"source checksum does not match IFI v3: {SOURCE_MD5}")
    records = prepare_records(source_path)
    validate_derived_records(records)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as destination:
        writer = csv.DictWriter(destination, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(records)
    return len(records)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Downloaded IFI v3 CSV")
    parser.add_argument("--output", required=True, type=Path, help="Derived Bengaluru Urban CSV path")
    args = parser.parse_args()
    count = write_derived_inventory(args.source, args.output)
    print(f"Wrote {count} district-scale records to {args.output}")


if __name__ == "__main__":
    main()
