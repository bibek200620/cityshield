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
            {"osm_type": "way", "osm_id": 18, "display_name": "Mysuru Palace, Karnataka", "lat": "12.3", "lon": "76.65", "type": "museum"},
            {"osm_type": "way", "osm_id": 20, "display_name": "Outside India bounds", "lat": "12.3", "lon": "60.5", "type": "town"},
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
        {
            "id": "way/18",
            "name": "Mysuru Palace, Karnataka",
            "lat": 12.3,
            "lng": 76.65,
            "category": "museum",
        },
    ]
    query = parse_qs(urlparse(captured["url"]).query)
    assert query["q"] == ["bms college, India"]
    assert query["countrycodes"] == ["in"]


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
    routes_places._search_photon_cached.cache_clear()

    def unavailable(_url):
        raise OSError("provider down")

    monkeypatch.setattr(routes_places, "_limited_provider_get", unavailable)
    monkeypatch.setattr(routes_places, "_limited_provider_json", unavailable)
    client = TestClient(app)
    failed = client.get("/api/places/search", params={"query": "hotel"})
    short = client.get("/api/places/search", params={"query": "x"})

    assert failed.status_code == 503
    assert failed.json()["detail"] == "Place search is temporarily unavailable."
    assert short.status_code == 422


def test_place_search_falls_back_to_photon_during_a_provider_outage(monkeypatch):
    routes_places._search_cached.cache_clear()
    routes_places._search_photon_cached.cache_clear()
    calls = []

    def provider(url):
        calls.append(url)
        if urlparse(url).netloc != "photon.komoot.io":
            raise OSError("Primary provider unavailable")
        place = {"name": "Lalbagh Botanical Gardens", "city": "Bengaluru", "state": "Karnataka",
                 "countrycode": "IN", "osm_type": "W", "osm_id": 53, "osm_value": "park"}
        point = {"type": "Point", "coordinates": [77.5869, 12.9489]}
        return {"features": [
            {"properties": place, "geometry": point},
            {"properties": {**place, "countrycode": "LK", "osm_id": 54}, "geometry": point},
            {"properties": {**place, "osm_id": 55}, "geometry": {"type": "Point", "coordinates": [60.5, 12.3]}},
        ]}

    monkeypatch.setattr(routes_places, "_limited_provider_json", provider)
    client = TestClient(app)
    first = client.get("/api/places/search", params={"query": "Lalbagh, Bengaluru"})
    second = client.get("/api/places/search", params={"query": "lalbagh,   bengaluru"})

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json() == {
        "status": "ready", "source": "OpenStreetMap Photon", "attribution": "© OpenStreetMap contributors",
        "results": [{"id": "W/53", "name": "Lalbagh Botanical Gardens, Bengaluru, Karnataka",
                     "lat": 12.9489, "lng": 77.5869, "category": "park"}],
    }
    photon_calls = [url for url in calls if urlparse(url).netloc == "photon.komoot.io"]
    assert len(photon_calls) == 1
    query = parse_qs(urlparse(photon_calls[0]).query)
    assert query["q"] == ["lalbagh, bengaluru"]
    assert query["countrycode"] == ["IN"]


def test_nearby_mapped_facilities_are_bounded_cached_and_unverified(monkeypatch):
    routes_places._nearby_facilities_cached.cache_clear()
    calls = []

    def query(lat, lng, radius):
        calls.append((lat, lng, radius))
        return {"elements": [
            {"type": "node", "id": 11, "lat": 12.9719, "lon": 77.5937,
             "tags": {"name": "Example Hospital", "amenity": "hospital"}},
            {"type": "way", "id": 12, "center": {"lat": 13.5, "lon": 77.5},
             "tags": {"name": "Outside radius", "amenity": "clinic"}},
            {"type": "node", "id": 13, "lat": 12.97, "lon": 77.59, "tags": {"amenity": "police"}},
        ]}

    monkeypatch.setattr(routes_places, "_overpass_query", query)
    client = TestClient(app)
    params = {"latitude": 12.9719, "longitude": 77.5937, "radius_m": 3000}
    first = client.get("/api/places/nearby", params=params)
    second = client.get("/api/places/nearby", params=params)

    assert first.status_code == second.status_code == 200
    body = first.json()
    assert body["status"] == "ready"
    assert len(body["results"]) == 1
    assert body["results"][0]["status"] == "mapped_listing_unverified"
    assert body["results"][0]["category"] == "hospital"
    assert len(calls) == 1
    assert "verified" in " ".join(body["limitations"])


def test_nearby_mapped_facilities_report_unavailable(monkeypatch):
    routes_places._nearby_facilities_cached.cache_clear()

    def query(*_args):
        raise OSError("upstream unavailable")

    monkeypatch.setattr(routes_places, "_overpass_query", query)
    response = TestClient(app).get("/api/places/nearby", params={
        "latitude": 12.9719, "longitude": 77.5937, "radius_m": 3000,
    })
    assert response.status_code == 503
