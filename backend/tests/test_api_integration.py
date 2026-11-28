from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app


def test_full_api_flow(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "HEAT_SCENE_DIR", str(tmp_path / "missing-scene"))
    monkeypatch.setattr("app.api.routes_weather.get_weather", lambda *_args: {
        "status": "unavailable", "source": "Open-Meteo weather model", "message": "Fresh weather estimates unavailable.",
    })
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200

        scenarios_resp = client.get("/api/scenarios")
        assert scenarios_resp.status_code == 200
        scenario_list = scenarios_resp.json()
        assert len(scenario_list) == 3
        scenario_id = scenario_list[0]["scenario_id"]

        infra_resp = client.get("/api/critical-infrastructure")
        assert infra_resp.status_code == 200
        infra_list = infra_resp.json()
        assert len(infra_list) == 3

        sim_resp = client.post("/api/simulate", json={"rainfall_intensity_mm_hr": 60, "duration_min": 90})
        assert sim_resp.status_code == 200
        sim_body = sim_resp.json()
        assert "scenario_id" in sim_body
        assert "node_predictions" in sim_body and len(sim_body["node_predictions"]) > 0
        assert "road_segments" in sim_body and len(sim_body["road_segments"]) > 0
        assert sim_body["model_caveat"]
        assert sim_body["is_synthetic_ward"] is True
        assert sim_body["provenance_class"] == "simulated"
        assert sim_body["model_mode"].startswith("FloodGNN")
        assert sim_body["rainfall_source"].startswith("User-selected")
        assert any("not observed Bellandur assets" in item for item in sim_body["input_provenance"])
        assert sim_body["generated_at_utc"].endswith("Z") or "+00:00" in sim_body["generated_at_utc"]
        assert "observed flood" in " ".join(sim_body["limitations"])

        exposure_resp = client.get(f"/api/exposure/{sim_body['scenario_id']}")
        assert exposure_resp.status_code == 200
        exposure_body = exposure_resp.json()
        assert exposure_body["status"] == "unavailable"
        assert exposure_body["grid_crs"] == "EPSG:32643"
        assert exposure_body["grid_resolution_m"] == 30
        assert exposure_body["cells"] == []
        assert "no compound probability" in " ".join(exposure_body["limitations"])

        weather_resp = client.get("/api/weather/nowcast")
        assert weather_resp.status_code == 200
        assert weather_resp.json()["status"] == "unavailable"
        assert "source" not in weather_resp.json()

        start, end = infra_list[0], infra_list[1]
        route_resp = client.post("/api/route", json={
            "start": {"lat": start["lat"], "lng": start["lng"]},
            "end": {"lat": end["lat"], "lng": end["lng"]},
            "scenario_id": scenario_id,
            "algorithm": "astar",
        })
        assert route_resp.status_code == 200
        route_body = route_resp.json()
        assert "route_geometry" in route_body
        assert "baseline_route_geometry" in route_body
        assert "eta_seconds" in route_body
        assert "avoided_flooded_segments" in route_body

        backtest_resp = client.get(
            "/api/backtest/bengaluru-inundation-reported-2022-09-04-sphere-india"
        )
        assert backtest_resp.status_code == 501
