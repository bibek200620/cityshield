from fastapi import HTTPException
import pytest

from app.routing import air_quality


class FakeResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {"current": {
            "time": "2026-11-28T07:00",
            "us_aqi": 87,
            "pm2_5": 19.4,
            "pm10": 34.0,
            "carbon_monoxide": 220.0,
            "nitrogen_dioxide": 12.0,
            "sulphur_dioxide": 3.0,
            "ozone": 45.0,
        }}


def test_point_air_quality_maps_current_values_and_caveats(monkeypatch):
    captured = {}

    def get(url, *, params, **kwargs):
        captured.update(url=url, params=params, kwargs=kwargs)
        return FakeResponse()

    monkeypatch.setattr(air_quality.requests, "get", get)
    result = air_quality.get_air_quality.__wrapped__(12.97, 77.59, 1)

    assert result["status"] == "ready"
    assert result["indexes"][0]["value"] == 87
    assert result["indexes"][0]["category"] == "Moderate"
    assert len(result["pollutants"]) == 6
    assert captured["params"]["domains"] == "cams_global"
    assert "api_key" not in captured["params"]
    assert any("not readings" in item for item in result["limitations"])


def test_point_air_quality_does_not_fabricate_empty_values(monkeypatch):
    class EmptyResponse(FakeResponse):
        def json(self):
            return {"current": {"time": "2026-11-28T07:00", "us_aqi": None}}

    monkeypatch.setattr(air_quality.requests, "get", lambda *_args, **_kwargs: EmptyResponse())
    result = air_quality.get_air_quality.__wrapped__(12.97, 77.59, 1)
    assert result["status"] == "empty"
    assert result["indexes"] == []
    assert result["pollutants"] == []


def test_point_air_quality_reports_upstream_unavailable(monkeypatch):
    monkeypatch.setattr(air_quality.requests, "get", lambda *_args, **_kwargs: (_ for _ in ()).throw(
        air_quality.requests.Timeout("offline")))
    with pytest.raises(HTTPException) as error:
        air_quality.get_air_quality.__wrapped__(12.97, 77.59, 1)
    assert error.value.status_code == 503
