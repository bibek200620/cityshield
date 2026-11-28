# Import and compare historical storms

CityShield can compare authorized instrument readings with an exported drainage model run for a surveyed network. Open **Storm replay → Find imported storms → Compare storm**. The published Bengaluru replay is available independently. The repository ships no paired storm bundle or surveyed CityShield drainage run. See the [data request draft](STORM_DATA_REQUEST.md) and the [public evidence and its limits](FLOOD_EVENT_DATA.md).

## Inspect and install observations

Use the Python environment from the backend setup. Run from the repository root, using the equivalent virtual environment Python on Windows.

```sh
backend/.venv/bin/python scripts/import_storm_event.py /path/to/observations.json
backend/.venv/bin/python scripts/import_storm_event.py /path/to/observations.json --install
```

The first command only inspects the file. Both commands return a JSON report with the original file checksum, normalized rainfall fingerprint, issues, and per-series coverage. `--install` retains the original bytes in `backend/data/storm_events/<event_id>.json` and refuses to replace an existing file. Use `--event-dir` when the API is configured to load from another directory. Keep source and model exports in authorized storage. An installed bundle with `allow_api_display: false` stays out of the public catalog and responses.

### Observations schema `1.0`

| Field | Required contents |
| --- | --- |
| Event identity | `event_id` (ASCII letters, digits, underscores or hyphens), `storm_group_id`, and `catchment_id` |
| Evaluation split | `partition` (`development` or `holdout`) and `partition_reference` to the documented split. Assign all records from the same storm to one group. |
| Time window | `time_zone` (IANA, usually `Asia/Kolkata`), `start_at`, `end_at`, and integer `interval_minutes`. Timestamps require UTC or the local zone offset. Use a window of at least two complete intervals. |
| `source` | `title`, HTTP(S) `url`, archive or delivery `reference`, `reuse_terms`, and `allow_api_display` (boolean). Verify the right to serve original values, coordinates and model results before making them visible. |
| `network` | `id`, `version`, `basis: "surveyed"`, `source`, and survey or verified crosswalk `reference` |
| Each item in `gauges` | `id`, WGS84 `lat` and `lng`, `location_reference`, `unit` (`mm` or interval-mean `mm/h`), and `readings` |
| Each item in `sensors` | `id`, WGS84 `lat` and `lng`, `location_reference`, `node_id`, `gauge_id`, `mapping_reference`, `invert_elevation_m`, `vertical_datum`, `unit` (`m`, `cm`, or `mm`), `measurement_reference` (`drain_invert` or `water_surface_elevation`), and `readings` |
| Each item in `readings` | `at`, `value`, and mapped `qc` (`valid`, `suspect`, `invalid`, or `missing`). Rainfall is labeled at the interval end. An initial drain-only reading at `start_at` is optional. |

Normalize cumulative rainfall to interval totals before creating the bundle. Convert provider quality flags using the provider’s documentation. The importer converts units and reduces water-surface elevation to depth above the surveyed invert. Duplicate UTC timestamps, invalid values, unresolved QC gaps, and incomplete interval coverage fail validation. The importer checks the presence and consistency of survey and permission metadata. The operator must verify those documents with the data owner.

## Install a drainage model run

Run the hydraulic model against the same surveyed network and interval rainfall. Export drain water depth above the same invert in metres. Resample model output to the exact observation interval ends before export. Place the export at `<event-dir>/model_runs/<event_id>.json`. The observation and model files list permission independently.

| Field | Required contents |
| --- | --- |
| Run identity | `schema_version: "1.0.0"`, `event_id`, `catchment_id`, `network_id`, `network_version`, `quantity: "drain_depth_above_invert_m"` |
| Model provenance | `name`, `version`, `run_reference`, optional `source_url`, `reuse_terms`, `allow_api_display` (boolean) |
| Forcing and calibration | `rainfall_sha256` from the exact normalized forcing used in the run, and `calibration_storm_groups` listing the development storm group IDs used |
| `nodes` | Object keyed by model `node_id`. Each value has `invert_elevation_m`, `vertical_datum`, and `series` (an array of `{ "timestamp": "…", "depth_m": 0.0 }`). An initial depth at `start_at` is optional. |

Use the importer’s `rainfall_sha256` only after confirming the run used that normalized forcing. A held-out event must be separate from the declared development storms, which must also be installed for the same catchment and network version. Those development bundles can be private. The comparison reports paired depths, mean absolute error and peak timing by sensor. The existing city runoff screen and synthetic pilot FloodGNN cannot supply these drainage depths. See the [model methods](BENGALURU_EVALUATION.md).

For a container deployment, mount or provision authorized files outside the image and point `STORM_EVENT_DIR` at that directory. The API reads the directory at request time. `GET /api/backtest` lists readiness for displayable bundles. `GET /api/backtest/<event_id>` returns a comparison when ready, HTTP 501 for an unavailable event or run, or HTTP 422 for an incompatible run.
