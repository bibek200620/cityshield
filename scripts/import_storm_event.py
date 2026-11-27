#!/usr/bin/env python3
"""Inspect or install a historical storm bundle for CityShield."""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.ml.storm_evaluation import rainfall_fingerprint
from app.ml.storm_import import STORM_DATA_DIR, inspect_storm_bundle, load_storm_bundle, storm_partition_issues


def install_bundle(payload: bytes, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".tmp", delete=False) as stream:
        temporary_path = Path(stream.name)
        try:
            stream.write(payload)
            stream.close()
            os.link(temporary_path, destination)
        finally:
            stream.close()
            temporary_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--install", action="store_true", help="Install an eligible bundle into the local event directory.")
    parser.add_argument("--event-dir", type=Path, default=STORM_DATA_DIR, help="Directory configured as STORM_EVENT_DIR.")
    options = parser.parse_args()

    try:
        payload = options.bundle.read_bytes()
    except OSError as exc:
        parser.exit(2, f"Could not read observation bundle: {exc}\n")
    result = inspect_storm_bundle(payload)
    report = result.report
    if result.event is not None:
        event = result.event
        report["rainfall_sha256"] = rainfall_fingerprint(event)
        installed = [load_storm_bundle(path).event for path in options.event_dir.glob("*.json")]
        existing = [item for item in installed if item is not None]
        report["errors"].extend(storm_partition_issues([*existing, event]))
        if options.install and not report["errors"]:
            destination = options.event_dir / f"{event.event_id}.json"
            try:
                install_bundle(payload, destination)
            except OSError as exc:
                report["errors"].append({"code": "install_failed", "path": str(destination), "message": str(exc)})
            else:
                report["installed_at"] = str(destination)
    report["ready"] = not report["errors"]
    print(json.dumps(report, indent=2))
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
