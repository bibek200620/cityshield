import json
import os
import re
from pathlib import Path

import requests

KEY_NAME = re.compile(r"^GOOGLE_MAPS_API_KEY(?:_\d+)?$")

ENDPOINTS = [
    (
        "Weather API",
        "GET",
        "https://weather.googleapis.com/v1/currentConditions:lookup",
        lambda key: {
            "params": {
                "key": key,
                "location.latitude": 12.9716,
                "location.longitude": 77.5946,
            }
        },
    ),
    (
        "Air Quality API",
        "POST",
        "https://airquality.googleapis.com/v1/currentConditions:lookup",
        lambda key: {
            "params": {"key": key},
            "json": {
                "location": {
                    "latitude": 12.9716,
                    "longitude": 77.5946,
                }
            },
        },
    ),
    (
        "Places API (New)",
        "POST",
        "https://places.googleapis.com/v1/places:searchNearby",
        lambda key: {
            "headers": {
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": "places.id",
                "Content-Type": "application/json",
            },
            "json": {
                "includedTypes": ["hospital"],
                "maxResultCount": 1,
                "locationRestriction": {
                    "circle": {
                        "center": {
                            "latitude": 12.9716,
                            "longitude": 77.5946,
                        },
                        "radius": 1000,
                    }
                },
            },
        },
    ),
]


def read_dotenv(path: Path) -> dict[str, str]:
    values = {}
    if not path.exists():
        return values

    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        name, value = line.split("=", 1)
        name = name.removeprefix("export ").strip()
        value = value.strip().strip('"').strip("'")

        if KEY_NAME.fullmatch(name) and value:
            values[name] = value

    return values


def get_keys() -> dict[str, str]:
    keys = read_dotenv(Path(__file__).with_name(".env"))

    # Environment values take precedence over .env values.
    for name, value in os.environ.items():
        if KEY_NAME.fullmatch(name) and value:
            keys[name] = value

    return dict(sorted(keys.items()))


def check_endpoint(name: str, method: str, url: str, kwargs: dict) -> str:
    try:
        response = requests.request(method, url, timeout=(4, 12), **kwargs)
    except requests.RequestException as error:
        return f"NETWORK ERROR ({type(error).__name__})"

    if response.ok:
        return f"PASS (HTTP {response.status_code})"

    try:
        body = response.json()
    except ValueError:
        body = {}

    error = body.get("error", {}) if isinstance(body, dict) else {}
    status = error.get("status", "unknown")
    reason = ""

    for detail in error.get("details", []):
        if isinstance(detail, dict) and detail.get("reason"):
            reason = f", {detail['reason']}"
            break

    return f"FAIL (HTTP {response.status_code}, {status}{reason})"


def main() -> None:
    keys = get_keys()
    if not keys:
        print("No Google Maps keys found in this folder's .env or environment.")
        print("Expected names: GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_API_KEY_2, etc.")
        return

    for key_name, key_value in keys.items():
        print(f"\n{key_name}:")
        for api_name, method, url, make_request in ENDPOINTS:
            result = check_endpoint(
                api_name,
                method,
                url,
                make_request(key_value),
            )
            print(f"  {api_name}: {result}")


if __name__ == "__main__":
    main()
