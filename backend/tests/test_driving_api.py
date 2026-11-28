from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.api import routes_driving
from app.core.config import settings
from app.main import app


REQUEST = {
    "source": {"lat": 12.979, "lng": 77.6408},
    "destination": {"lat": 12.9698, "lng": 77.7499},
}


def test_driving_comparison_merges_an_identical_shortest_path(monkeypatch):
    primary = {"summary": {"length": 10, "time": 800}, "legs": [{
        "shape": "??AA",
        "maneuvers": [
            {"begin_shape_index": 1, "instruction": "Arrive.", "verbal_transition_alert_instruction": "Your destination is ahead."},
            {"begin_shape_index": 3, "instruction": "Invalid position."},
        ],
    }]}
    alternate = {"summary": {"length": 11, "time": 900}, "legs": [{"shape": "??CC"}]}

    def query(req, *, shortest):
        return {"trip": primary} if shortest else {"trip": primary, "alternates": [{"trip": alternate}]}

    monkeypatch.setattr(routes_driving, "query_valhalla", query)
    monkeypatch.setattr(settings, "TOMTOM_API_KEY", None)
    monkeypatch.setattr(routes_driving, "annotate_conditions", lambda *args, **kwargs: {})
    response = TestClient(app).post("/api/drive/routes", json=REQUEST)
    assert response.status_code == 200
    result = response.json()
    assert result["shortest_available"]
    assert result["traffic"]["status"] == "unavailable"
    assert [r["labels"] for r in result["routes"]] == [["Best estimated time", "Shortest distance"], ["Alternative"]]
    assert result["routes"][0]["coordinates"] == [[0, 0], [0.000001, 0.000001]]
    assert result["routes"][0]["guidance"] == [{"point_index": 1, "instruction": "Your destination is ahead."}]


def test_driving_rejects_points_outside_india_before_querying_provider(monkeypatch):
    def unexpected_query(*args, **kwargs):
        raise AssertionError("An out-of-area request must be rejected locally")

    monkeypatch.setattr(routes_driving, "query_valhalla", unexpected_query)
    response = TestClient(app).post(
        "/api/drive/routes", json={**REQUEST, "destination": {"lat": 12.5, "lng": 60.6}},
    )
    assert response.status_code == 422


def test_driving_accepts_southern_suburb_coordinates(monkeypatch):
    route = {"summary": {"length": 10, "time": 800}, "legs": [{"shape": "??AA"}]}
    monkeypatch.setattr(routes_driving, "query_valhalla", lambda req, *, shortest: {"trip": route})
    monkeypatch.setattr(settings, "TOMTOM_API_KEY", None)
    monkeypatch.setattr(routes_driving, "annotate_conditions", lambda *args, **kwargs: {})
    request = {
        "source": {"lat": 12.979, "lng": 77.6408},
        "destination": {"lat": 12.70, "lng": 77.58},
    }

    response = TestClient(app).post("/api/drive/routes", json=request)

    assert response.status_code == 200


def test_configured_traffic_adapter_uses_provider_time_without_hazard_adjustments(monkeypatch):
    def fetch(url, params):
        assert params["traffic"] == "true"
        assert params["sectionType"] == "traffic"
        assert params["instructionsType"] == "text"
        return {"routes": [{
            "summary": {"travelTimeInSeconds": 900, "noTrafficTravelTimeInSeconds": 600, "lengthInMeters": 8000},
            "legs": [{"points": [
                {"latitude": 12.979, "longitude": 77.6408},
                {"latitude": 12.9698, "longitude": 77.7499},
            ]}],
            "guidance": {"instructions": [
                {"pointIndex": 1, "message": "Turn left."},
                {"pointIndex": -1, "message": "Invalid position."},
            ]},
        }]}

    monkeypatch.setattr(settings, "TOMTOM_API_KEY", SecretStr("test-key"))
    monkeypatch.setattr(routes_driving, "fetch_json", fetch)
    monkeypatch.setattr(routes_driving, "annotate_conditions", lambda *args, **kwargs: {})
    response = TestClient(app).post("/api/drive/routes", json=REQUEST)
    assert response.status_code == 200
    result = response.json()
    assert result["traffic"]["status"] == "ready"
    assert result["routes"][0]["eta_seconds"] == 900
    assert result["routes"][0]["traffic_time_delta_seconds"] == 300
    assert result["routes"][0]["traffic_segments"] is None
    assert result["routes"][0]["guidance"] == [{"point_index": 1, "instruction": "Turn left."}]


def test_traffic_sections_resolve_overlap_and_preserve_point_index_boundaries():
    route = {"sections": [
        {"sectionType": "TRAFFIC", "startPointIndex": 1, "endPointIndex": 4, "magnitudeOfDelay": 2},
        {"sectionType": "TRAFFIC", "startPointIndex": 2, "endPointIndex": 3, "simpleCategory": "ROAD_CLOSURE"},
    ]}
    assert routes_driving.traffic_segments(route, 6) == [
        {"start_index": 0, "end_index": 1, "level": "unknown"},
        {"start_index": 1, "end_index": 2, "level": "slow"},
        {"start_index": 2, "end_index": 3, "level": "heavy"},
        {"start_index": 3, "end_index": 4, "level": "slow"},
        {"start_index": 4, "end_index": 5, "level": "unknown"},
    ]
    route["sections"][0]["endPointIndex"] = 6
    assert routes_driving.traffic_segments(route, 6) == [
        {"start_index": 0, "end_index": 2, "level": "unknown"},
        {"start_index": 2, "end_index": 3, "level": "heavy"},
        {"start_index": 3, "end_index": 5, "level": "unknown"},
    ]


def test_aggregate_delay_without_a_location_does_not_color_route_blue():
    route = {"summary": {"travelTimeInSeconds": 820, "noTrafficTravelTimeInSeconds": 600, "trafficDelayInSeconds": 0}, "sections": []}
    assert routes_driving.traffic_segments(route, 10) is None
    route["summary"]["travelTimeInSeconds"] = 600
    assert routes_driving.traffic_segments(route, 10) == [{"start_index": 0, "end_index": 9, "level": "clear"}]


def test_flood_scenario_changes_exposure_on_the_same_bengaluru_road():
    client = TestClient(app)
    coordinates = [[[77.637, 12.971], [77.657, 12.948], [77.677, 12.926]]]
    dry = client.post("/api/drive/scenario", json={"rainfall_mm": 0, "routes": coordinates}).json()["routes"][0]
    flood = client.post("/api/drive/scenario", json={"rainfall_mm": 200, "routes": coordinates}).json()["routes"][0]
    assert dry["exposed_km"] == 0 and dry["spans"] == []
    assert 0 < flood["high_km"] < flood["exposed_km"] < flood["route_km"]
    assert flood["covered_km"] == dry["covered_km"]
    assert all(0 <= span["start"] < span["end"] <= 1 for span in flood["spans"])
    outside = client.post("/api/drive/scenario", json={"rainfall_mm": 200, "routes": [[[0, 0], [1, 1]]]})
    assert outside.status_code == 200
    assert outside.json()["status"] == "unavailable"


def test_route_ranking_uses_comparable_hazards_and_keeps_provider_etas(monkeypatch):
    routes = [
        {"coordinates": [[77.6, 12.9], [77.7, 12.9]], "eta_seconds": 600, "distance_km": 10, "labels": ["Alternative"]},
        {"coordinates": [[77.6, 12.9], [77.7, 12.91]], "eta_seconds": 660, "distance_km": 11, "labels": ["Alternative"]},
        {"coordinates": [[77.6, 12.9], [77.7, 12.92]], "eta_seconds": 800, "distance_km": 12, "labels": ["Alternative"]},
    ]
    monkeypatch.setattr(settings, "TOMTOM_API_KEY", None)
    monkeypatch.setattr(routes_driving, "valhalla_options", lambda _req: (routes, routes[0].copy()))

    def annotate(candidates, _key, *_coords, **_kwargs):
        for candidate, reports, km in zip(candidates, [1, 0, 0], [0, 2, 0.5]):
            candidate.update(nearby_flood_reports=reports, runoff_comparable=True, runoff={"forecast_km": km})
        return {"runoff_available": True}

    monkeypatch.setattr(routes_driving, "annotate_conditions", annotate)
    result = TestClient(app).post("/api/drive/routes", json=REQUEST).json()
    assert result["routes"][0]["eta_seconds"] == 800
    assert "Recommended for lower flood exposure" in result["routes"][0]["labels"]
    assert result["routes"][1]["eta_seconds"] == 600
    assert {"Best estimated time", "Shortest distance"} <= set(result["routes"][1]["labels"])


def test_route_ranking_uses_eta_when_runoff_coverage_is_incomplete():
    faster = {"eta_seconds": 900, "runoff": {"forecast_km": 3}, "runoff_comparable": True}
    slower = {"eta_seconds": 950, "runoff": {"forecast_km": 0}, "runoff_comparable": False}
    assert routes_driving.recommend_route([faster, slower]) is faster
