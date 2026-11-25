from copy import deepcopy

import pytest

from app.ml.flood_event_data import (
    FloodEventManifestError,
    load_manifest,
    partition_event_groups,
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
    event["storm_group_id"] = "storm-2022-09"

    with pytest.raises(FloodEventManifestError, match="verified geometry"):
        validate_manifest(manifest)


def test_eligible_events_require_storm_group_for_event_level_holdout():
    manifest = load_manifest()
    event = manifest["events"][0]
    event["evaluation_eligible"] = True
    event["event_time"]["precision"] = "day"
    event["location"]["geometry"] = {"type": "Point", "coordinates": [77.6, 12.9]}
    event["observation"]["reported_flooded_streets"] = ["Example Road"]
    event["observation"]["rainfall_timeseries_mm_hr"] = [10.0]

    with pytest.raises(FloodEventManifestError, match="storm_group_id"):
        validate_manifest(manifest)


def test_storm_group_holdout_is_deterministic_and_keeps_each_storm_together():
    events = [
        {"record_id": "a-2", "storm_group_id": "storm-a", "evaluation_eligible": True},
        {"record_id": "b-1", "storm_group_id": "storm-b", "evaluation_eligible": True},
        {"record_id": "a-1", "storm_group_id": "storm-a", "evaluation_eligible": True},
        {"record_id": "c-1", "storm_group_id": "storm-c", "evaluation_eligible": True},
    ]

    train, test = partition_event_groups(events, test_fraction=1 / 3, seed=17)
    train_again, test_again = partition_event_groups(events, test_fraction=1 / 3, seed=17)

    assert [event["record_id"] for event in train] == [event["record_id"] for event in train_again]
    assert [event["record_id"] for event in test] == [event["record_id"] for event in test_again]
    train_storms = {event["storm_group_id"] for event in train}
    test_storms = {event["storm_group_id"] for event in test}
    assert train_storms.isdisjoint(test_storms)
    assert len(test_storms) == 1
    assert {event["record_id"] for event in train + test} == {event["record_id"] for event in events}


def test_storm_group_holdout_rejects_ineligible_or_underpowered_data():
    eligible = {"record_id": "e-1", "storm_group_id": "storm-1", "evaluation_eligible": True}
    ineligible = {"record_id": "e-2", "storm_group_id": "storm-2", "evaluation_eligible": False}

    with pytest.raises(FloodEventManifestError, match="not evaluation eligible"):
        partition_event_groups([eligible, ineligible])
    with pytest.raises(FloodEventManifestError, match="at least two"):
        partition_event_groups([eligible])
    with pytest.raises(FloodEventManifestError, match="duplicate record_id"):
        partition_event_groups([eligible, dict(eligible, storm_group_id="storm-2")])
