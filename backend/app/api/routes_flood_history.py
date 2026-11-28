"""District-scale historical flood records available in the local inventory."""
from __future__ import annotations

import csv
import json
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()
EVENTS_PATH = Path(__file__).resolve().parents[2] / "data" / "flood_events" / "ifi_bengaluru_urban.csv"


@lru_cache(maxsize=1)
def _records() -> tuple[dict, ...]:
    if not EVENTS_PATH.is_file():
        return ()
    with EVENTS_PATH.open("r", encoding="utf-8-sig", newline="") as source:
        records = []
        for row in csv.DictReader(source):
            try:
                districts = json.loads(row["districts_listed_by_source"])
                flags = json.loads(row["quality_flags"])
                date_start = row["event_start_date"]
                date_end = row["event_end_date"]
                if "Bengaluru Urban" not in districts or not date_start or not date_end:
                    continue
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                continue
            records.append({
                "id": row["record_id"],
                "start_date": date_start,
                "end_date": date_end,
                "date_precision": row["event_time_precision"],
                "reported_cause": row["reported_cause"],
                "source_event_source": row["source_event_source"],
                "districts_listed": districts,
                "location_name": "Bengaluru Urban district",
                "location_precision": row["location_precision"],
                "has_coordinates": False,
                "multi_district_event": len(districts) > 1,
                "evaluation_eligible": row["evaluation_eligible"].casefold() == "true",
                "quality_flags": flags,
            })
        return tuple(sorted(records, key=lambda item: (item["start_date"], item["id"])))


@router.get("/api/flood/events")
def historical_flood_events() -> dict:
    events = list(_records())
    return {
        "status": "ready" if events else "unavailable",
        "location": "Bengaluru Urban district",
        "location_precision": "district",
        "events": events,
        "limitations": [
            "Dates are day or date-range precision; the source does not provide event time-of-day.",
            "Many records name several districts and cannot be assigned to a Bengaluru map location.",
            "No event footprints, road impacts, matched rainfall, or flood-depth observations are available.",
            "These records support historical browsing only and are excluded from model training and validation.",
        ],
        "citation": {
            "dataset": "India Flood Inventory-Impacts v3 (1967–2023), Bengaluru Urban subset",
            "doi": "10.5281/zenodo.11275211",
            "license": "CC BY 4.0",
        },
    }
