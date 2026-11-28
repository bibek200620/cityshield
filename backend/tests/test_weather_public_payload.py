from app.api.routes_weather import _public_forecast_payload


def test_public_forecast_payload_removes_upstream_identity_recursively():
    result = _public_forecast_payload({
        "status": "ready",
        "source": "Example forecast service",
        "provenance": {
            "provider": "Example provider",
            "grid_cell_center": {"latitude": 12.9, "longitude": 77.6, "elevation_m": 900},
            "nested": {"endpoint": "https://example.test", "temperature_c": 31},
        },
        "hours": [{"air_temperature_c": 29, "attribution": "Example attribution"}],
    })

    assert result == {
        "status": "ready",
        "provenance": {
            "grid_cell_center": {"latitude": 12.9, "longitude": 77.6, "elevation_m": 900},
            "nested": {"temperature_c": 31},
        },
        "hours": [{"air_temperature_c": 29}],
    }
