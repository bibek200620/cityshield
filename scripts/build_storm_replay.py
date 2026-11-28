"""Build the browser replay from Tables S3, S5 and S6 in Davis et al. (2022)."""
from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SENSOR_SUMMARY = ROOT / "docs/data/flood_events/frontiers_2020_sensor_summary.csv"
OUTPUT = ROOT / "frontend/src/data/bengaluru-storm-2020.json"

# Table S6, p. 11 of the supplement. Published event peaks, keyed by WLS ID.
STUDY_PEAKS = {
    "100003": {
        "modelDepthM": 0.8124,
        "modelAt": "2020-10-20T19:15:00+05:30",
        "observedDepthM": 0.79,
        "observedAt": "2020-10-21T00:45:00+05:30",
    },
    "100021": {
        "modelDepthM": 0.6859,
        "modelAt": "2020-10-20T18:45:00+05:30",
        "observedDepthM": 0.9,
        "observedAt": "2020-10-21T00:45:00+05:30",
    },
}


def build_replay() -> dict:
    with SENSOR_SUMMARY.open(encoding="utf-8", newline="") as source:
        rows = list(csv.DictReader(source))
    if {row["event_id"] for row in rows} != {"BLR-2020-10-20"}:
        raise ValueError("Expected the October 2020 storm only.")
    if {row["evaluation_eligible"] for row in rows} != {"false"}:
        raise ValueError("Review replay eligibility before changing the published summary.")
    rain = {(row["event_rainfall_max_24h_mm"], row["rainfall_station"]) for row in rows}
    if len(rain) != 1:
        raise ValueError("Expected one shared 24-hour event maximum.")
    rainfall_mm, rainfall_station = rain.pop()
    sensor_ids = {row["wls_id"] for row in rows}
    if len(sensor_ids) != len(rows) or not STUDY_PEAKS.keys() <= sensor_ids:
        raise ValueError("Replay sensor IDs must be unique and match the study peak records.")

    snapshots = []
    for row in sorted(rows, key=lambda item: datetime.fromisoformat(item["observation_timestamp_local"])):
        _, _, location = row["location_as_reported"].split("_", 2)
        snapshot = {
            "sensorId": row["wls_id"],
            "valley": row["valley"],
            "location": location,
            "observedAt": row["observation_timestamp_local"],
            "observedDepthM": float(row["observed_flow_depth_m"]),
            "drainDepthM": float(row["drain_depth_m"]),
            "studyPeak": STUDY_PEAKS.get(row["wls_id"]),
        }
        snapshots.append(snapshot)

    return {
        "eventId": "BLR-2020-10-20",
        "timeZone": "Asia/Kolkata",
        "highestGaugeRainfall24hMm": float(rainfall_mm),
        "rainfallStation": rainfall_station,
        "source": {
            "authors": "Davis et al. (2022)",
            "article": "https://doi.org/10.3389/feart.2022.883842",
            "supplement": "https://ndownloader.figshare.com/files/35248909",
            "license": "https://creativecommons.org/licenses/by/4.0/",
            "model": "PCSWMM · WRF WSM6KF3",
        },
        "snapshots": snapshots,
    }


if __name__ == "__main__":
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(build_replay(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
