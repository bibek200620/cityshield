from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.ml.storm_evaluation import ModelRunError, ModelRunUnavailable, evaluate_storm, load_model_run
from app.ml.storm_import import StormEvent, load_storm_bundle

router = APIRouter()
UNAVAILABLE = "No verified historical comparison is available for this event."


def _load_events(directory: Path) -> dict[str, StormEvent]:
    events = {}
    for path in sorted(directory.glob("*.json")):
        if not path.is_file():
            continue
        imported = load_storm_bundle(path)
        if imported.event is not None and imported.event.event_id == path.stem:
            events[imported.event.event_id] = imported.event
    return events


def _comparison(directory: Path, event: StormEvent, events: list[StormEvent]) -> dict:
    run = load_model_run(directory / "model_runs" / f"{event.event_id}.json")
    return evaluate_storm(event, run, events)


@router.get("/api/backtest")
def list_backtests() -> dict:
    directory = Path(settings.STORM_EVENT_DIR)
    events = list(_load_events(directory).values())
    catalog = []
    for event in events:
        if not event.source.allow_api_display:
            continue
        message = None
        try:
            _comparison(directory, event, events)
        except ModelRunError as exc:
            message = str(exc)
        catalog.append({
            "event_id": event.event_id,
            "catchment_id": event.catchment_id,
            "partition": event.partition,
            "status": "ready" if message is None else "unavailable",
            "message": message,
        })
    return {"events": catalog}


@router.get("/api/backtest/{event_id}")
def get_backtest(event_id: str) -> JSONResponse:
    directory = Path(settings.STORM_EVENT_DIR)
    events = _load_events(directory)
    event = events.get(event_id)
    if event is None or not event.source.allow_api_display:
        return JSONResponse(status_code=501, content={"message": UNAVAILABLE})
    try:
        return JSONResponse(content=_comparison(directory, event, list(events.values())))
    except ModelRunUnavailable as exc:
        return JSONResponse(status_code=501, content={"message": str(exc)})
    except ModelRunError as exc:
        return JSONResponse(status_code=422, content={"message": str(exc)})
