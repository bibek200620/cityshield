from copy import deepcopy

import pytest

from app.ml.flood_event_data import (
    FloodEventManifestError,
    load_manifest,
    validate_manifest,
)


def test_checked_in_flood_event_inventory_is_valid_but_not_evaluation_ready():
    manifest = load_manifest()

    assert len(manifest["events"]) == 1
    event = manifest["events"][0]
    assert event["event_time"]["date"] == "2022-09-04"
    assert event["location"]["geometry"] is None
    assert event["evaluation_eligible"] is False
    assert "no_verified_coordinates" in event["quality_flags"]
    assert manifest["sources"][0]["reuse_status"]


def test_duplicate_event_ids_are_rejected():
    manifest = load_manifest()
    manifest["events"].append(deepcopy(manifest["events"][0]))

    with pytest.raises(FloodEventManifestError, match="duplicate record_id"):
        validate_manifest(manifest)


def test_duplicate_source_and_date_events_are_rejected():
    manifest = load_manifest()
    duplicate = deepcopy(manifest["events"][0])
    duplicate["record_id"] = "different-id-same-source-and-date"
    manifest["events"].append(duplicate)

    with pytest.raises(FloodEventManifestError, match="duplicate source/date/location event"):
        validate_manifest(manifest)


def test_event_geometry_rejects_out_of_range_wgs84_coordinates():
    manifest = load_manifest()
    manifest["events"][0]["location"]["geometry"] = {
        "type": "Point",
        "coordinates": [200.0, 12.9],
    }

    with pytest.raises(FloodEventManifestError, match="outside WGS84"):
        validate_manifest(manifest)


def test_evaluation_eligible_record_requires_geometry_and_observed_outcome():
    manifest = load_manifest()
    event = manifest["events"][0]
    event["evaluation_eligible"] = True
    event["event_time"]["precision"] = "day"

    with pytest.raises(FloodEventManifestError, match="verified geometry"):
        validate_manifest(manifest)
