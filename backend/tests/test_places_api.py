from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from app.api import routes_places
from app.main import app


def test_place_search_returns_bounded_named_results_and_attribution(monkeypatch):
    captured = {}

    def provider(url):
        captured["url"] = url
        return [
            {"osm_type": "way", "osm_id": 17, "display_name": "BMS College of Engineering, Bengaluru", "lat": "12.9412", "lon": "77.5651", "type": "college"},
            {"osm_type": "relation", "osm_id": 19, "display_name": "Anekal, Bengaluru Urban", "lat": "12.70", "lon": "77.58", "type": "town"},
            {"osm_type": "way", "osm_id": 18, "display_name": "Outside Bengaluru", "lat": "12.5", "lon": "77.5", "type": "college"},
            {"osm_type": "way", "osm_id": 20, "display_name": "Below supported map bounds", "lat": "12.61", "lon": "77.5", "type": "town"},
            {"display_name": "Malformed location", "lat": "nan", "lon": "77.5"},
        ]

    routes_places._search_cached.cache_clear()
    monkeypatch.setattr(routes_places, "_limited_provider_get", provider)
    result = TestClient(app).get("/api/places/search", params={"query": "BMS College"})

    assert result.status_code == 200
    body = result.json()
    assert body["source"] == "OpenStreetMap Nominatim"
    assert body["attribution"] == "© OpenStreetMap contributors"
    assert body["results"] == [
        {
            "id": "way/17",
            "name": "BMS College of Engineering, Bengaluru",
            "lat": 12.9412,
            "lng": 77.5651,
            "category": "college",
        },
        {
            "id": "relation/19",
            "name": "Anekal, Bengaluru Urban",
            "lat": 12.7,
            "lng": 77.58,
            "category": "town",
        },
    ]
    query = parse_qs(urlparse(captured["url"]).query)
    assert query["q"] == ["bms college, Bengaluru, India"]
    assert query["viewbox"] == ["77.44,13.16,77.80,12.62"]
    assert query["bounded"] == ["1"]


def test_place_search_caches_normalized_queries(monkeypatch):
    calls = []
    monkeypatch.setattr(routes_places, "_limited_provider_get", lambda url: calls.append(url) or [])
    routes_places._search_cached.cache_clear()
    client = TestClient(app)

    first = client.get("/api/places/search", params={"query": "  Orion Mall  "})
    second = client.get("/api/places/search", params={"query": "orion   mall"})

    assert first.status_code == second.status_code == 200
    assert first.json()["results"] == []
    assert len(calls) == 1


def test_place_search_reports_provider_failure_and_rejects_short_query(monkeypatch):
    routes_places._search_cached.cache_clear()

    def unavailable(_url):
        raise OSError("provider down")

    monkeypatch.setattr(routes_places, "_limited_provider_get", unavailable)
    client = TestClient(app)
    failed = client.get("/api/places/search", params={"query": "hotel"})
    short = client.get("/api/places/search", params={"query": "x"})

    assert failed.status_code == 503
    assert failed.json()["detail"] == "Place search is temporarily unavailable."
    assert short.status_code == 422
