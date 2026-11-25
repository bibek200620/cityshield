from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CARD_PATH = ROOT / "docs/model-cards/v1.0.0.json"
FLOOD_RUN_PATH = ROOT / "docs/model-cards/flood-gnn-experiment-2026-11-26.json"


def _cards() -> tuple[dict, dict]:
    inventory = json.loads(CARD_PATH.read_text())
    cards = {card["id"]: card for card in inventory["cards"]}
    return inventory, cards


def test_versioned_model_card_inventory_has_complete_unique_records():
    inventory, cards = _cards()

    assert inventory["schema_version"] == "1.0.0"
    assert len(cards) == len(inventory["cards"]) == 6
    required = {
        "version", "name", "workflow", "purpose", "not_intended_for", "output", "data",
        "preprocessing", "spatial", "model_configuration", "evaluation", "reproduction",
        "artifact_status", "limitations", "licence_and_attribution",
    }
    for card in cards.values():
        assert required <= card.keys()
        assert card["version"]
        assert card["evaluation"]["observed_validation"]["status"] == "unavailable"
        assert card["evaluation"]["observed_validation"]["reason"]
        assert card["reproduction"].get("command")


def test_flood_gnn_card_matches_reproducible_run_and_labels_surrogate_only():
    _, cards = _cards()
    card = cards["flood-gnn-physics-surrogate"]
    run = json.loads(FLOOD_RUN_PATH.read_text())

    assert card["data"]["dataset_sha256"] == run["data"]["dataset_sha256"]
    assert card["data"]["scenario_ids"] == run["data"]["scenario_ids"]
    assert card["split"]["training_scenarios"] == run["split"]["training_scenarios"]
    assert card["split"]["validation_scenarios"] == run["split"]["validation_scenarios"]
    assert set(card["split"]["training_scenarios"]).isdisjoint(card["split"]["validation_scenarios"])
    assert card["evaluation"]["status"] == "computed_surrogate_agreement"
    assert card["evaluation"]["metric_provenance"] == run["metrics"]["metric_scope"]
    assert card["evaluation"]["metrics"]["mae_m"] == run["metrics"]["mae_m"]
    assert card["evaluation"]["metrics"]["rmse_m"] == run["metrics"]["rmse_m"]
    assert run["metrics"]["metric_kind"] == "surrogate_agreement"
    assert "unavailable" in run["metrics"]["observed_event_validation"]


def test_heat_cards_keep_lst_reanalysis_and_observation_claims_separate():
    _, cards = _cards()
    single = cards["heat-bellandur-single-scene-lst"]
    city = cards["heat-bengaluru-multidate-lst"]
    reanalysis = cards["heat-era5land-next-day-tmax"]

    assert "surface temperature" in single["output"]["target"].lower()
    assert "air temperature" in single["not_intended_for"]
    assert city["evaluation"]["status"] == "computed_remote_sensing_holdouts"
    assert len(city["evaluation"]["chronological_test_metrics_by_date"]) == 4
    assert "not a future forecast" in " ".join(city["limitations"])
    assert reanalysis["data"]["provenance_class"] == ["reanalysis_model_derived"]
    assert "reanalysis-derived" in reanalysis["evaluation"]["metric_provenance"]
    assert reanalysis["split"]["training_targets"] == 7671
    assert reanalysis["split"]["test_targets"] == 1826


def test_station_baseline_reports_same_site_metrics_without_city_forecast_claim():
    _, cards = _cards()
    station = cards["heat-ghcnh-hal-next-day-tmax"]

    assert station["data"]["provenance_class"] == ["observed_station_data", "derived_relative_humidity"]
    assert station["data"]["station_id"] == "INM00043296"
    assert station["data"]["raw_file_sha256"] == "f54169d47017e2be68df7f1c461503e8cadec97f6afc13dfc2e59161f8b15a6c"
    assert station["split"]["strategy"] == "chronological target-date holdout"
    assert station["split"]["training_targets"] == 3250
    assert station["split"]["test_targets"] == 997
    assert station["evaluation"]["metrics"]["xgboost"]["sample_count"] == 997
    assert station["evaluation"]["metrics"]["previous_day_persistence"]["sample_count"] == 997
    assert station["evaluation"]["metrics"]["xgboost"]["mae_c"] > station["evaluation"]["metrics"]["previous_day_persistence"]["mae_c"]
    assert station["evaluation"]["observed_validation"]["status"] == "unavailable"
    assert "Bengaluru-wide forecast" in station["not_intended_for"]
