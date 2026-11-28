from pydantic import SecretStr

from app.core.config import settings
from app.routing import meteoblue


def test_five_day_hourly_forecast_request_is_parsed_without_credential_leaks(monkeypatch):
    captured = {}
    count = 121

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "metadata": {"latitude": 12.9, "longitude": 77.6, "modelrun_utc": "2026-11-28T00:00:00Z"},
                "data_1h": {
                    "time": [f"2026-11-28T{index % 24:02d}:00:00Z" for index in range(count)],
                    "temperature": [29] * count,
                    "felttemperature": [31] * count,
                    "precipitation": [0] * count,
                    "relativehumidity": [65] * count,
                    "pictocode": [3] * count,
                },
            }

    def get(url, *, params, **kwargs):
        captured.update(url=url, params=params, kwargs=kwargs)
        return Response()

    monkeypatch.setattr(settings, "METEOBLUE_API_KEY", SecretStr("never-return-this"))
    monkeypatch.setattr(meteoblue.requests, "get", get)

    result = meteoblue._get_forecast(12.9, 77.6)

    assert captured["params"]["forecastDays"] == 5
    assert len(result["hours"]) == count
    assert "limitations" in result
    assert "never-return-this" not in str(result)
    assert "apikey" not in result
