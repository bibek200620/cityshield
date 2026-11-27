import io
import json

import pytest
from pydantic import SecretStr
from shapely.geometry import LineString, box

from app.api import routes_assistant
from app.core.config import settings
from app.routing.conditions import runoff_spans


def test_city_watch_uses_first_forecast_hour_with_distinct_screened_cells(monkeypatch):
    weather = {
        "status": "ready", "recent_rain_mm": 2, "upcoming_rain_mm": 12,
        "forecast_through": "2026-11-26T04:00:00+00:00",
        "hourly_forecast": [
            {"precipitation_mm": 1, "valid_at": "2026-11-26T02:00:00+00:00"},
            {"precipitation_mm": 11, "valid_at": "2026-11-26T03:00:00+00:00"},
        ],
    }
    cells = [(f"{i}:20:0",) for i in range(10)] + [("1:20:1",)]
    monkeypatch.setattr(routes_assistant, "get_alert_weather", lambda: [weather])
    monkeypatch.setattr(routes_assistant, "load_grid", lambda: {"cells": cells})
    monkeypatch.setattr(routes_assistant, "screen_values", lambda _grid, rain: [8 if rain > 3 else 0] * len(cells))
    result = routes_assistant.assistant_outlook()
    assert result["alert"] == {"valid_at": "2026-11-26T03:00:00+00:00", "cells": 10}


def test_city_watch_limits_rain_to_its_forecast_zone_and_keeps_heat(monkeypatch):
    time = "2026-11-26T03:00:00+00:00"
    inputs = [
        {"recent_rain_mm": 0, "upcoming_rain_mm": rain, "forecast_through": time,
         "hourly_forecast": [{"precipitation_mm": rain, "valid_at": time, "feels_like_c": heat}],
         "provenance": {"grid_cell_center": {"longitude": lng, "latitude": 12.98}}}
        for lng, rain, heat in [(77.59, 0, 42), (77.72, 10, 30)]
    ]
    monkeypatch.setattr(routes_assistant, "get_alert_weather", lambda: inputs)
    monkeypatch.setattr(routes_assistant, "load_grid", lambda: {"cells": [(f"{i}:20:0",) for i in range(20)]})
    monkeypatch.setattr(routes_assistant, "_nearest_forecast_points", lambda _locations: (0,) * 9 + (1,) * 11)
    monkeypatch.setattr(routes_assistant, "screen_values", lambda _grid, rain: [rain] * 20)

    result = routes_assistant.assistant_outlook()
    assert result["alert"] == {"valid_at": time, "cells": 11}
    assert result["heat"] == {"valid_at": time, "feels_like_c": 42}
    assert result["forecast_points"] == 2
    def missing_grid():
        raise FileNotFoundError
    monkeypatch.setattr(routes_assistant, "load_grid", missing_grid)
    result = routes_assistant.assistant_outlook()
    assert not result["flood_screen_available"]
    assert result["heat"]["feels_like_c"] == 42


def test_runoff_spans_keep_order_when_path_doubles_back():
    path = LineString([(0, 0), (100, 0), (0, 0)])
    spans = runoff_spans(path, box(20, -10, 40, 10))
    assert [span["start"] for span in spans] == pytest.approx([.1, .8])
    assert [span["end"] for span in spans] == pytest.approx([.2, .9])


@pytest.mark.parametrize("style", ["gentle", "unreviewed alert text"])
def test_gemini_can_choose_only_reviewed_tones(monkeypatch, style):
    monkeypatch.setattr(settings, "GEMINI_API_KEY", SecretStr("fixture"))
    routes_assistant._gemini_phrasings.cache_clear()

    def fake_provider(request, timeout):
        message = json.loads(request.data)
        assert "gemini-2.5-flash-lite" in request.full_url
        assert "fixture" not in request.full_url
        assert set(message["generationConfig"]["responseSchema"]["required"]) == set(routes_assistant.ALERT_KINDS)
        text = json.dumps({"city_flood": style, "route_rain": "direct", "traffic": "direct"})
        return io.BytesIO(json.dumps({"candidates": [{"content": {"parts": [{"text": text}]}}]}).encode())

    monkeypatch.setattr(settings, "GEMINI_MODEL", "gemini-2.5-flash-lite")
    monkeypatch.setattr(routes_assistant, "urlopen", fake_provider)
    try:
        response = routes_assistant.assistant_phrasing()
        assert response["source"] == ("gemini" if style == "gentle" else "preset")
        assert response["styles"]["city_flood"] == ("gentle" if style == "gentle" else "direct")
    finally:
        routes_assistant._gemini_phrasings.cache_clear()


def test_refresh_keeps_traffic_only_when_provider_matches_the_selected_path(monkeypatch):
    coordinates = ((77.6, 12.9), (77.61, 12.91))
    monkeypatch.setattr(settings, "TOMTOM_API_KEY", SecretStr("fixture"))
    routes_assistant._refreshed_traffic.cache_clear()

    def fake_provider(_url, params, *, body):
        assert params["reconstructionMode"] == "strict"
        assert len(body["supportingPoints"]) == 2
        return {"routes": [{"legs": [{"points": body["supportingPoints"]}],
                            "summary": {"trafficDelayInSeconds": 0}, "sections": []}]}

    monkeypatch.setattr(routes_assistant, "fetch_json", fake_provider)
    try:
        result = routes_assistant._refreshed_traffic(coordinates, 1)
        assert result["segments"] == [{"start_index": 0, "end_index": 1, "level": "clear"}]
        monkeypatch.setattr(routes_assistant, "fetch_json", lambda *_args, **_kwargs: {
            "routes": [{"legs": [{"points": [{"longitude": 77.63, "latitude": 12.95}]}], "sections": []}],
        })
        assert routes_assistant._refreshed_traffic(coordinates, 2) is None
    finally:
        routes_assistant._refreshed_traffic.cache_clear()


def test_legacy_gemini_unavailable_uses_known_flash_lite_fallback(monkeypatch):
    from urllib.error import HTTPError

    monkeypatch.setattr(settings, "GEMINI_API_KEY", SecretStr("fixture"))
    monkeypatch.setattr(settings, "GEMINI_MODEL", "gemini-2.5-flash-lite")
    routes_assistant._gemini_phrasings.cache_clear()
    tried = []

    def fake_provider(request, timeout):
        model = request.full_url.split("/models/")[-1].split(":")[0]
        tried.append(model)
        if model == "gemini-2.5-flash-lite":
            raise HTTPError(request.full_url, 404, "Not found", {}, None)
        text = json.dumps(dict.fromkeys(routes_assistant.ALERT_KINDS, "direct"))
        return io.BytesIO(json.dumps({"candidates": [{"content": {"parts": [{"text": text}]}}]}).encode())

    monkeypatch.setattr(routes_assistant, "urlopen", fake_provider)
    try:
        response = routes_assistant.assistant_phrasing()
        assert response["source"] == "gemini"
        assert response["model"] == "gemini-3.5-flash-lite"
        assert tried == ["gemini-2.5-flash-lite", "gemini-3.5-flash-lite"]
    finally:
        routes_assistant._gemini_phrasings.cache_clear()
