# Current issue work plan — 2026-11-26

## Objective
Push/verify the current navigation change first, then address the open CityShield GitHub issues sequentially. Work each issue on its own branch based on current `origin/main`; validate its acceptance criteria, stage only owned paths, commit, push, and open a PR to `main`. Never push directly to `main`, merge without authorization, close an issue before its acceptance criteria are actually met, or stage pre-existing untracked user files.

## Issue order
1. #1 dated Bengaluru flood incident records — first and current. Inspect sources and existing data; implement only schema/provenance handling and verified records. Keep event evaluation unavailable if no lawful, authoritative records exist.
2. #2 rainfall and meteorological ingestion — only after issue #1 is completed or its data blocker is documented; use a verified provider and actual missing-data behavior.
3. #3 multi-date Landsat preprocessing — preserve sensor/date/QA metadata and evaluate spatial generalization.
4. #4 temporal heatwave baseline — only with suitable observed air temperature and humidity; otherwise document the missing-data blocker and do not train from LST.
5. #5 observed-event flood validation — only with verified dated event records; keep surrogate agreement separate.
6. #7 model cards and experiment provenance — record actual datasets/configuration/splits/metrics without fabricating evaluation.
7. #8 end-to-end combined hazard regression coverage — use existing frontend/test setup, no broad framework migration.

## Current gates and paths for issue #1
- Already verified current feature branch `feature/live-gps-navigation-south-coverage` commit `c16237c56a316319bf09885f9d94f4ac7324eb66` is pushed and PR #9 is open against `main`.
- Branch for #1: `feature/issue-1-flood-event-records`, created from `origin/main` after preserving untracked files.
- Inspect issue body, current flood evaluation/data registry, source records, licenses and authoritative provider evidence before implementation.
- Candidate owned paths: `backend/app/...` and tests only if actual data contract supports it; `docs/DATA_SOURCES.md`, `docs/BENGALURU_EVALUATION.md`, and a focused data manifest/schema only if needed.
- Focused validation: existing backend test commands; any validator tests; `git diff --check`; inspect staged paths.
- Exit: every included record has source, event time/precision, coordinate/location provenance and quality flags, with permissions documented. If no real records can be obtained, do not make up rows or metrics; leave historical evaluation unavailable, capture the precise evidence/blocker in docs and the GitHub issue, then continue only if remaining issue work is independent.

## Per-issue workflow
1. Read the issue and relevant current code/data/docs; identify a testable acceptance contract.
2. Write a short issue-specific plan and inspect all source/licence constraints.
3. Implement only issue scope; add focused tests.
4. Run tests and inspect diff; if gate fails, repair or document blocker before moving on.
5. Stage only owned paths, commit a coherent verified change, push feature branch, open PR to `main`; verify remote SHA and PR target.
6. Update `docs/IMPLEMENTATION_STATE.md` (copy old version to backup first) and append actual result to `docs/IMPLEMENTATION_LOG.md`.
7. Leave issue open unless the work fully satisfies acceptance; do not merge PRs without authorization.

## Tools and constraints
- Repository `.agents/skills/` is absent. Authenticated `gh` CLI works; connected GitHub MCP issue fetch returned HTTP 403. Use documented repo scripts/CLI and actual web sources as evidence; do not pretend the unavailable connector succeeded.
- Preserve untracked user files: `.playwright-cli/`, `.pre-commit-config.yaml`, `docs/DEMO_SCRIPT.md`, `docs/JUDGE_QA.md`, and `media/`.


## Issue #1 initial source audit

- Open issue #1 requires real dated/location records, permissions, provenance and quality flags; spatial flood-prone points are explicitly not event labels.
- Existing checkout has no flood incident dataset. `backend/app/ml/backtest.py` contains only a TODO stub and rejects missing rainfall/street labels; `/api/backtest/{event_id}` remains HTTP 501.
- Public sources found: Sphere India 2022 Bengaluru situation report (2022-09-06 13:00; describes Sep 4 night rainfall/inundation across named zones/localities but has no exact incident coordinates or per-location times; source is a secondary report and explicitly cites SEOC/media). OpenCity lists BBMP-associated “Flooding Locations in Bengaluru Urban” as common flooding points, which is an undated prior and not event ground truth. NRSC/NDEM describes satellite flood layers by image date, but the portal content is intended for authorized users and the located Karnataka maps do not establish Bengaluru-specific event points.
- Decision: record the situation report only as a coarse, research-only source record with explicit null geometry and ineligibility flags; do not geocode localities into invented event points or train/backtest from it. Record other sources as candidates/prior-only. Preserve 501 until evaluation-grade data exists.
- Evidence URLs: https://www.sphereindia.org.in/sites/default/files/2023-09/_1.%20SitRep%20-%20Floods%20in%20Bangaluru.pdf ; https://data.opencity.in/dataset/?groups=bengaluru&organization=bruhat-bengaluru-mahanagara-palike ; https://ndem.nrsc.gov.in/documents/downloads/nrt_technical_note.pdf ; https://ndem.nrsc.gov.in/
- Current branch `feature/issue-1-flood-event-records` starts at `origin/main`.


## Issue #1 implementation and verification result

- Added `backend/app/ml/flood_event_sources.json` with the cited coarse 2022 narrative record plus catalog entries for OpenCity common flood points and NRSC/NDEM layers. The record has date precision, named places, publication time, source basis, reuse status, uncertainty flags, null geometry, and an explicit evaluation exclusion. No coordinates, rain series, or street labels were invented.
- Added stdlib manifest validation in `backend/app/ml/flood_event_data.py`, schema/provenance guide `docs/FLOOD_EVENT_DATA.md`, and tests for manifest validity, duplicate record and source/date/location entries, WGS84 coordinate bounds, and rejection of evaluation eligibility without geometry/outcome. Updated source docs/backtest comments and changed API integration coverage to use the narrative record ID while asserting 501.
- Focused tests: `rtk proxy .venv/bin/python -m pytest tests/test_flood_event_data.py tests/test_api_integration.py -q` from `backend/` — 6 passed, 1 Starlette deprecation warning.
- Full backend suite after final edits: `rtk proxy .venv/bin/python -m pytest -q` from `backend/` — 41 passed, 16 dependency/deprecation warnings. `rtk git diff --check` — passed.
- Issue #1 remains open: no evaluation-grade geometry/time/outcome/rainfall bundle or explicit source data reuse permission was found. The work is a source inventory and gate, not proof of a labeled dataset or real-world model validation.
- Next: stage only the seven issue #1 files, inspect staged diff, commit/push feature branch, and create PR to `main` without closing issue #1.


## Issue #1 publication result

- Commit `2f61a1b15edc11d61ff8080bba800679ed6a8cb9` pushed to `feature/issue-1-flood-event-records`; remote SHA verified.
- PR #10 verified open against `main`: https://github.com/bibek200620/cityshield/pull/10. PR references #1 without an auto-close keyword. Issue #1 remains open because the data acceptance gap is unresolved.
- Next issue #2 is independent; inspect its current body and implementation from a fresh branch based on `origin/main`.


## Issue #2 audit and planned implementation

- Open issue #2 requires source/version, resolution, units, timezone and valid/retrieval time, distinct stale/missing/timeout states, deterministic parse/unit/time tests and no-network failure tests.
- Existing path: `backend/app/routing/conditions.py` requests one Bengaluru reference coordinate from `api.open-meteo.com/v1/forecast`, requests unix timestamps and UTC, parses current plus two past/three future hourly slots, but returns only a generic `unavailable` message on all provider/parser failures. Ready payload omits returned grid-cell center, elevation, provider units/timezone, API/model selection and retrieval time. Tests exercise some stale/missing shape paths but no explicit timeout distinction. Frontend displays source/units/IST and attribution, but no model/grid provenance. `docs/ARCHITECTURE.md` incorrectly says weather is not configured; evaluation docs describe an older forecast window.
- Provider verification: official API docs identify `auto`/Best Match as automatic model selection; response includes returned grid-cell center, elevation, timezone, UTC offset and units. A cell may be kilometres from requested coordinate. Best Match combines models and may vary resolution; exact model identifier/resolution not returned as a universal value. Open-Meteo says data are CC BY 4.0 with attribution; free public API is for non-commercial use, rate-limited and has no uptime guarantee.
- Planned edits: classify `timeout`, `missing_data`, `stale_data`, and `invalid_data` separately; include API v1/provider, provider-default automatic model selection, explicitly configured units/timezone/cell-selection, requested coordinate, provider returned grid center/elevation, raw provider units/timezone/UTC offset, provider retrieval time from the five-minute cache fetch, and current/forecast valid times. Explicitly report model version and spatial resolution as not returned rather than inventing them. Keep single-city-point estimate limitations visible. Update frontend types and provenance copy; correct applicable docs.
- Tests: fixed UTC fixture for units/time conversion and metadata; parser errors for missing/misaligned values and stale current; get_weather timeout, missing, stale, and invalid states; API no-network behavior. No test should call Open-Meteo.
- Branch: `feature/issue-2-meteorology-ingestion` from `origin/main`; no issue #2 code edits yet.


## Issue #2 implementation and verification result

- Updated Open-Meteo ingestion to explicitly request `temperature_unit=celsius`, `precipitation_unit=mm`, `timezone=UTC`, `timeformat=unixtime`, `cell_selection=land`, and the required current/hourly variables. Model selection uses provider default Best Match. An initial explicit `models=auto` parameter returned HTTP 400 (`Cannot initialize MultiDomains`); removed it in favor of the documented provider default, then a live request succeeded.
- Parser now validates units, returned grid center/elevation, timezone/offset, hourly alignment, timestamps and values. Ready metadata records API v1, model selection with exact model/version unknown, requested and returned location, resolution explicitly unknown, units, timezone, retrieval time, and observation/forecast valid times. Failures distinguish timeout, provider error, stale data, missing data and invalid data. No data fallback was added.
- UI exposes model/resolution limits, provider grid-cell center and retrieval time; visible forecast times remain IST. Docs corrected weather setup, licensing, point coverage and upcoming 3-hour rainfall window.
- Focused backend tests: `rtk proxy .venv/bin/python -m pytest tests/test_route_conditions.py -q` — final 8 passed, 1 Starlette deprecation warning. The first attempt failed two assertions only because the old message case no longer matched; assertions were corrected and rerun.
- Full backend suite: `rtk proxy .venv/bin/python -m pytest -q` — 41 passed, 16 warnings. Frontend lint passed. TypeScript/Vite build passed with existing large-chunk advisory. `rtk git diff --check` passed.
- Live Open-Meteo smoke: one provider request returned `status=ready`, 20.4 °C air and 22.6 °C apparent at 12.98,77.59; returned grid center 12.970123,77.56364 at 924 m; valid time 18:45 UTC; retrieval time 18:57 UTC; 3 forecast slots. This is provider model output, not a station observation.
- Playwright UI check at `http://localhost:5173/`: opened “Next 3 hours”; confirmed 3 live hourly estimates, IST times, attribution, grid-cell metadata, model/version/resolution caveat and forecast limitations; browser console 0 errors, 2 warnings. Task-created browser closed.
- Issue #2 scope still uses one Bengaluru reference point, not neighborhood-specific weather. Open-Meteo does not return one stable spatial resolution or exact Best Match run/version. These limits are visible; this is not a warning service.
- Next: stage only issue #2 paths, review, commit/push branch, create PR to `main`.


## Issue #2 publication result

- Commit `ba2b03f4f17ce03bf133faf815b8d470b2c8105b` pushed to `feature/issue-2-meteorology-ingestion`; remote SHA verified.
- PR #11 verified open against `main`: https://github.com/bibek200620/cityshield/pull/11.
- Issue #2 closed after verified acceptance work; GitHub returned state `CLOSED`. A comment links PR #11 and reiterates the point-estimate/model-version/resolution limits.
- Next: issue #3 multi-date Landsat preprocessing; use a fresh branch from `origin/main`.


## Issue #3 plan — multi-date Landsat contract and spatial validation

### Audit decision and evidence
- Branch is `feature/issue-3-multidate-landsat` based on `origin/main`; tracked tree is clean. Existing user-owned untracked files and ignored `backend/data/heat/` assets must remain untouched/stay uncommitted.
- The existing importable `landsat.py` single-scene processor validates QA, feature order/units and within-scene band alignment. `city_study.py` selects Landsat 8/9 C2 L2 scenes and has chronological acquisition holdout, but no cross-scene compatibility contract or spatial-block evaluation for its pooled multi-date training samples.
- The local ignored cache has 20 sample archives with only features/target/metadata and one full April 2026 archive with coordinates/CRS; existing per-scene metadata lacks CRS, affine, resolution, feature/unit schema, sensor and QA/preprocessing version. STAC manifests are present. The real city-study evaluation/model also exist locally, but artifacts are not tracked.
- STAC inspection shows all sampled items are Landsat C2 L2 in EPSG:32643 at 30 m, while source affine x-origins shift between dates by integral 30 m pixels. Therefore validate one projected CRS, north-up 30 m resolution and shared pixel lattice, not identical per-scene transform origins. Record both source and AOI-window transforms.
- Required issue behavior: support both L8/L9 with explicit sensor/collection metadata under one pinned C2 L2 feature contract; reject missing/misaligned bands and unsupported/incompatible scenes; stable spatial blocks must be keyed from projected coordinates across all training dates, not scene-local rows/columns.

### Implementation phases
1. **Complete audit / contract (no code edits before plan):** inspect existing API consumers, tests, requirements, cache and STAC structure. Exit: plan above reviewed against actual source/docs and no unresolved instruction/data license blocker.
2. **Reusable validation + cache contract:** in `backend/app/heat/city_study.py`, define versioned feature/unit/QA/grid metadata; validate STAC item/sensor/product/date, all-band profiles and cross-scene CRS/resolution/orientation/pixel-lattice compatibility; write versioned NPZ caches preserving old local artifacts; validate cache schema/array shape before use. Exit: synthetic unit fixtures reject incompatible metadata deterministically and accepted L8/L9 metadata round-trips.
3. **Spatial generalization evaluation:** derive stable projected 900 m block IDs (30 pixels × 30 m) from every training sample's coordinates; use deterministic grouped split across pooled training acquisitions, report withheld-block metrics separately; retain the existing whole-acquisition chronological evaluation and train final temporal model only on configured training dates. Exit: tests prove no block is shared between spatial train/test, repeatability, and temporal test dates remain later.
4. **Real-scene integration + documentation:** when public licensed Planetary Computer inputs/network are available, rerun configured scene processing/training into the ignored v2 output/cache; record actual outcomes only. Update `docs/HEAT_WORKFLOW.md`, `docs/BENGALURU_EVALUATION.md`, and `docs/DATA_SOURCES.md` as needed to distinguish Bellandur one-scene spatial holdout, city multi-date spatial-block holdout, and future-date holdout. Preserve USGS and Microsoft Planetary Computer attribution and keep imagery/model/cache out of Git. Exit: reproducible command and truthful evaluation metadata; if provider/assets fail, stop and report exact blocker, no fabricated metrics.
5. **Verification/publication:** run focused heat tests, full backend suite, `git diff --check`, inspect staged paths; commit scoped source/tests/docs only, push this feature branch, open PR to `main`, verify branch SHA/PR target. Close #3 only if every acceptance criterion is truly met; otherwise leave it open with a comment and exact remaining evidence.

### Affected paths
- Planned implementation: `backend/app/heat/city_study.py` (and `landsat.py` only if a shared schema constant is needed).
- Planned tests: new `backend/tests/test_city_study.py`; existing `backend/tests/test_heat.py` only if a shared function contract changes.
- Planned docs: `docs/HEAT_WORKFLOW.md`, `docs/BENGALURU_EVALUATION.md`, `docs/DATA_SOURCES.md` (only where needed).
- Required local handoff: `docs/IMPLEMENTATION_STATE.md`, its backup before each replacement, append-only `docs/IMPLEMENTATION_LOG.md`; this temporary plan persists until the whole issue sequence is done.
- Never stage `backend/data/`, `.playwright-cli/`, `.pre-commit-config.yaml`, `docs/DEMO_SCRIPT.md`, `docs/JUDGE_QA.md`, or `media/`.

### Validation commands
- Focused: `cd backend && .venv/bin/python -m pytest tests/test_city_study.py tests/test_heat.py -q`.
- Integration/reproducibility: `cd backend && .venv/bin/python -m app.heat.city_study` then `cd backend && .venv/bin/python -m app.heat.city_study --export-map` only if configured scene data/provider are available; all generated caches/artifacts must remain ignored. Otherwise mark blocked/not run with actual cause.
- Broad: `cd backend && .venv/bin/python -m pytest -q`; root `rtk proxy git diff --check`; inspect `git diff --stat`, `git diff`, and `git status --short`.
- Issue gate: shared CRS, pixel alignment/resolution, scene metadata/schema, QA mask and units validated; spatial blocks disjoint across dates; existing single-scene workflow preserved; no model or live heat forecast claims from LST.


## Issue #3 implementation and validation result
- Implemented and tested the planned multi-date compatibility/cache contract and buffered 900 m spatial holdout. Actual files are `backend/app/heat/city_study.py`, `backend/tests/test_city_study.py`, and the three heat/data documents.
- Real full city-study retraining completed from USGS Landsat 8/9 C2 L2 scene samples accessed through Microsoft Planetary Computer. Final output is ignored `backend/data/heat/city-study/evaluation.v2.json` and `model.v2.json`; old model/report paths were not replaced. Metrics and limits are in the implementation state and evaluation document.
- Final backend suite: 51 passed, 16 warnings. Focused heat suite: 20 passed, 14 warnings. Python compile check and `git diff --check` passed.
- Exit criteria for issue #3 are met. Next: inspect/stage only its five tracked source/test/doc paths, commit, push this feature branch, open PR to `main`, and close #3 after verifying publication.


## Issue #3 publication result
- Commit `0ee95834c55f524268846a519c6ab816ada86606` pushed to `feature/issue-3-multidate-landsat`; remote SHA verified. PR #12 is open against `main`: https://github.com/bibek200620/cityshield/pull/12.
- GitHub issue #3 was closed after verified acceptance and the final real multi-date run; closure state confirmed.
- Next issue: #4. Audit observed meteorological histories; no LST-derived heatwave labels.


## Issue #4 audit — blocked on meteorological data provenance choice

- Issue #4 asks for a defined temporal heatwave baseline trained and measured against real observed air-temperature/humidity records with chronological holdout.
- Local audit: no historical weather time series or approved archive is in `backend/data/`; app uses only Open-Meteo forecast API. Existing heat API remains unavailable for heatwave forecast and tests cover the limitation. No code changes/tests were necessary.
- Official source evidence: IMD Bengaluru documents hourly/3-hourly/daily temperature, dewpoint and relative humidity as supplied by request/payment: https://mausam.imd.gov.in/bengaluru/docs/data-procedure.pdf. Current IMD API fields include current weather and daily observations/forecasts, but no long historical time series sufficient for training: https://api.imd.gov.in/public/api_reference.html. IMD archive procedure may require forms, certificate and payment: https://internal.imd.gov.in/section/rti/MANUAL_15.pdf.
- Candidate alternative is Open-Meteo ERA5-Land: hourly temperature and RH, about 0.1° (~11 km), 1950-present; its docs describe reanalysis that blends observations and model estimates, so it is not station-observed data: https://open-meteo.com/en/docs/historical-weather-api. Open-Meteo attribution/license docs: https://open-meteo.com/en/license.
- No IMD request/payment was made. No reanalysis download or training was made. Current model output remains unavailable; no LST/forecast data used as target.
- Decision needed: provide/authorize licensed IMD station series; explicitly accept a clearly labelled ERA5-Land reanalysis-only research baseline (which does not satisfy observed-ground-truth acceptance); or defer issue #4. Do not continue dependent implementation without that choice.

## Issue #4 plan — ERA5-Land reanalysis-only next-day baseline

### Decision and audit evidence
- User selected ERA5-Land for this baseline. Use it only as a reanalysis/model-derived research dataset, never as station-observed truth, a neighbourhood-scale observation or a validated heatwave warning.
- GitHub issue #4 remains OPEN at planning time. Its acceptance text asks for metrics against held-out observations. This work can produce an exploratory held-out reanalysis evaluation but cannot satisfy the observed-ground-truth clause; do not close the issue unless its criteria are actually met.
- Official Open-Meteo Historical Weather API documentation was checked on 2026-11-26. It documents ERA5-Land at 0.1° (~11 km), hourly from 1950, temperature/RH, API `/v1/archive`, and states reanalysis combines observations with model estimates. A live three-day smoke request succeeded for the explicit `models=era5_land` query at Bengaluru; provider grid cell returned 13.0°N, 77.600006°E, elevation 910 m, timezone Asia/Kolkata and expected °C/% units. This is API contract verification, not training or evaluation.
- Source/licence: Open-Meteo historical API and its data-use license/attribution must be cited in the docs and output manifest. No dependency addition is planned; use existing Python, pandas, scikit-learn and XGBoost.

### Implementation phases and gates
1. **Plan/source gate (complete before code):** review instructions, issue #4, existing heat API/docs/tests, package versions, ignore rules and official source; write plan and initial handoff state. Exit: actual API smoke works and provenance tradeoff is explicit.
2. **Validated archive module and deterministic tests:** add an importable ERA5-Land module with fixed Bengaluru request configuration, bounded per-year acquisition, response metadata, strict timestamps/units/range/alignment/missing-value validation, and stable local ignored raw cache. Add tests using static fixtures for valid responses and malformed/missing data. Exit: tests prove exact model/variables/timezone/units, timezone-to-date handling and data-quality rejection; no network required by tests.
3. **Chronological feature/training workflow:** produce local-day 2 m Tmax target and prior-day-only temperature/RH features; compare one-step persistence, training-only day-of-year climatology and XGBoost using targets from 2000–2020 for training and 2021–2025 as chronological test (1999 is only previous-day warm-up). Record dataset fingerprint, requested/returned coordinates, period, excluded rows, split, feature order, seed, hyperparameters, model versions and computed held-out metrics. Save model/metrics only beneath ignored `backend/data/heat/reanalysis/`. Exit: reproducible end-to-end training succeeds on the acquired ERA5-Land data and all three methods use identical test rows.
4. **Docs and truthful product boundary:** add `docs/HEATWAVE_REANALYSIS.md`, update `docs/DATA_SOURCES.md`, retain `/api/heat`'s Landsat-only behavior and add a regression assertion that this temporal experiment is not exposed as an operational/advisory output. Exit: source, CC BY 4.0 attribution, scale, target and non-observation status are explicit; user-facing heatwave/advisory remains unavailable.
5. **Verification and publication:** run focused then full backend tests, the real-data download/training command, compile and diff checks; inspect all changes and ignored artifacts; commit only scoped tracked files on `feature/issue-4-heatwave-baseline`, push the feature branch, open a PR to `main`. Close issue #4 only if its observation-based acceptance criteria are actually met; otherwise leave it open with the remaining evidence gap and a link to the research-only PR.

### Planned affected paths
- New: `backend/app/heat/reanalysis.py`, `backend/app/heat/train_reanalysis.py`, `backend/tests/test_reanalysis.py`, `docs/HEATWAVE_REANALYSIS.md`.
- Update only as needed: `backend/tests/test_heat_api.py`, `docs/DATA_SOURCES.md`.
- Handoff: this plan, `docs/IMPLEMENTATION_STATE.md` (backup before replacing), append-only `docs/IMPLEMENTATION_LOG.md`.
- Local acquired data/model/results go only to ignored `backend/data/heat/reanalysis/`; never stage them. Preserve unrelated untracked user paths.

### Validation commands and completion criteria
- Focused: `cd backend && .venv/bin/python -m pytest tests/test_reanalysis.py tests/test_heat_api.py -q`.
- Real data: `cd backend && .venv/bin/python -m app.heat.train_reanalysis --download --train` (actual options finalized from the CLI implementation; do not claim before running).
- Backend suite: `cd backend && .venv/bin/python -m pytest -q`; syntax check `cd backend && .venv/bin/python -m compileall -q app/heat`; root `rtk proxy git diff --check`.
- Evaluation: verify chronological dates, no shared date between train/test, no future-derived predictors, equal test sample counts for all methods, metrics computed from downloaded held-out ERA5-Land values only, and output metadata labels target as reanalysis/model-derived. Never call this observed validation or claim heatwave event detection.
- Issue gate: this baseline may pass reproducibility and temporal split criteria while failing the original observed-target acceptance criterion. If so, keep #4 open and stop this sequential issue flow at that gate for a user scope decision.

### Phase 2 test iteration 1 — micro-plan
- Evidence: first focused run `cd backend && .venv/bin/python -m pytest tests/test_reanalysis.py tests/test_heat_api.py -q` failed 2 tests and passed 10. The gap behavior correctly raises when no adjacent complete days exist, while the test expected an empty frame. The miniature training fixture had too few prior seasonal training dates for its final test date, so the training-only climatology intentionally rejected it.
- Micro-plan: assert the explicit no-adjacent-days error; extend the synthetic training cutoff so each held-out date has nearby training climatology samples; replace deprecated `DataFrame.applymap` finite validation with a NumPy array check. Then rerun the exact focused command. Do not begin the full download unless it passes.
- Focused run 2 returned **1 failed, 11 passed**: the saved XGBoost booster had no feature names because fit used NumPy arrays. Micro-plan: pass train/test DataFrames in `FEATURE_COLUMNS` order, then assert the model artifact retains that exact order. Rerun the same focused test command before continuing.

### Phase 3 report audit adjustment — warm-up boundary and source manifest
- Actual first run downloaded 27 annual files for 1999–2025, produced 9,862 complete local days (0 excluded), and compared all methods on 1,826 held-out dates from 2021–2025. Initial RMSE/MAE: XGBoost 1.0874/0.7773 °C; prior-day Tmax persistence 1.1827/0.8330 °C; training-only seasonal climatology 1.7310/1.2669 °C. These are reanalysis-target metrics only.
- The report showed training target dates began 1999-01-02. 1999 was requested to provide prior-day warm-up for Jan 2000, so its labels must be excluded from training. Freeze final split as targets 2000–2020 for training and 2021–2025 for test; 1999 supplies lag features only.
- The raw annual response cache did not persist the exact request parameters although the current fetch code did explicitly request ERA5-Land. Add a validated envelope containing the exact year query, retrieval timestamp and raw response; refuse unmanifested cache files. Migrate only this task's already fetched local files after verifying their complete response schema, or re-fetch them if that cannot be established. Add tests for query-envelope validation. Re-run training from the cache and replace initial metrics in final docs/state with the verified corrected split result.

### Phase 3 corrected real archive result
- The exact query manifest is now retained with each annual cached response. 27 validated yearly responses cover 1999–2025, selected cell 13.000000°N/77.600006°E at 910 m; retrieved 2026-11-25 UTC, hourly units °C/% and explicit model `era5_land`.
- Excluded 1999 target rows; it supplies only lag warm-up. Final training targets: 7,671 (2000-01-01–2020-12-31). Held-out targets: 1,826 (2021-01-01–2025-12-31). Complete days 9,862; excluded incomplete days 0.
- Corrected final held-out scores (same ERA5-Land target rows): XGBoost MAE/RMSE/bias = 0.778556/1.089562/0.103946 °C; persistence = 0.833023/1.182746/-0.002026 °C; training-only seasonal climatology = 1.274384/1.741495/0.268597 °C. These are model-to-reanalysis comparisons, not independent observations.
- Documentation added in `docs/HEATWAVE_REANALYSIS.md` and `docs/DATA_SOURCES.md`. No frontend/API exposure was added; the existing forecast-unavailable state remains.
- A cache migration helper was first invoked with the system `python3` and failed because pandas is only installed in the backend venv; the following invocation with `.venv/bin/python` validated and manifested all 27 task-created files. The first training run against the unmanifested cache correctly stopped; after migration, cache-backed training succeeded. These commands/results are recorded, and no user-owned data was altered.

### Phase 5 — final checks and issue/PR gate
- Run focused tests, the full backend suite, compile check, cache-only real training and diff/status review. Only after green checks, commit/push a feature branch and open PR. Issue #4 remains open unless the original observed-data criterion is satisfied by evidence; ERA5-Land scores cannot be relabeled as observed validation.
- Final hardening iteration: added checks for full required archive-year coverage and UTC retrieval timestamps. The first focused run after this change had 1 failed, 13 passed because the synthetic mocked loader fixture omitted its `years` list. Micro-plan: add 1999 and 2000 to that fixture metadata, rerun the focused suite, then rerun the complete cached workflow and full tests.
- Final verification passed: focused tests 14 passed (2 warnings); cache-only training reproduced the corrected metrics; complete backend suite 49 passed (16 dependency/deprecation warnings); Python compileall, tracked diff-check and new-file whitespace check passed. Dataset/model/report files are Git-ignored.
- Phase 5 code/data/doc checks pass. Publication remains pending; issue #4 observed-station validation criterion is not met and must remain open.
- Latest main advanced after branch creation (PR #12 merge); feature branch merged `origin/main` commit `b802fae` with no history rewrite. Resolved one `docs/DATA_SOURCES.md` content conflict while preserving both branches' documented sources/limits.
- Post-merge verification: backend 75 passed (16 warnings), frontend lint passed, production build passed with the existing oversized chunk advisory, Python compileall and diff checks passed. Merge commit and GitHub PR refresh are pending. Issue #4 remains open because station-observed evaluation is not available.


## Issue #5 plan — event-held-out flood validation support

### Audit and evidence
- GitHub issue #5 is OPEN. `origin/main` is `2bfd04d`, the PR #13 merge commit; issue #4 remains OPEN because station-observed heat validation is unmet.
- `backend/data/` contains heat artifacts only; no observed flood event records. The checked-in flood evidence manifest contains one coarse 2022 narrative explicitly excluded from evaluation and two candidate-source entries. The report lacks per-location observed geometry/outcomes and matched event rainfall. OpenCity points are undated spatial priors; NDEM reuse/access was not verified.
- Existing `/api/backtest/{event_id}` returns 501. Existing physics/GNN labels are simulated and cannot be scored as observed performance. Preserve these boundaries.
- User asked to remove one unnecessary branch after work. `feature/issue-4-heatwave-baseline` is a candidate because PR #13 is merged; verify no open PR uses it and verify its tip is contained in `origin/main` before deleting its local and remote refs. Do not delete other stale branches.

### Phases and gates
1. **Audit and plan (no app edits):** verify latest main, branch/PR status, manifest, local data, API contract, model modes, tests and docs. Exit: exact missing observation fields and scoped change confirmed.
2. **Event-group split contract:** add a small deterministic splitter for only evaluation-eligible rows with explicit event/storm grouping; reject malformed/duplicate identities and insufficient group counts instead of silently splitting. Add tests proving deterministic results, group non-overlap, ineligible exclusion/rejection, and failure on insufficient groups. Exit: focused tests pass; no metrics or live backtest is enabled.
3. **Truthful status and documentation:** keep backtest API unavailable (501); update flood validation docs to distinguish simulated surrogate agreement from observed-event metrics, specify full-event holdout, and state current data gap. Exit: docs and API tests agree, no unsupported performance claims.
4. **Verification and delivery:** run focused flood manifest/backtest/API tests, full backend suite, compile and diff checks; inspect owned paths; commit scoped work, push feature branch, open PR to `main`; leave issue #5 OPEN if observed records remain absent. Exit: branch/PR verified and issue state accurately reported.
5. **Branch cleanup:** after delivery, confirm #4 branch is fully merged into `origin/main` and unused by any open PR; delete only its local and remote refs. Exit: branch deletion confirmed, active issue #5 branch and unrelated refs intact.

### Affected paths
- Planned: `backend/app/ml/flood_event_data.py` (event group partition utility) or a directly owned adjacent backtest module if cleaner; `backend/tests/test_flood_event_data.py` and possibly focused API test; `docs/FLOOD_EVENT_DATA.md` and/or `docs/DATA_SOURCES.md`.
- Handoff: this plan, `docs/IMPLEMENTATION_STATE.md` with prior version backed up before replacement, append-only `docs/IMPLEMENTATION_LOG.md`.
- Do not stage generated/ignored `backend/data/`, `.playwright-cli/`, `.pre-commit-config.yaml`, `docs/DEMO_SCRIPT.md`, `docs/JUDGE_QA.md`, or `media/`.

### Validation commands
- Focused: `cd backend && .venv/bin/python -m pytest tests/test_flood_event_data.py tests/test_api_integration.py -q`.
- Broad: `cd backend && .venv/bin/python -m pytest -q`; `cd backend && .venv/bin/python -m compileall -q app/ml`; root `rtk proxy git diff --check`.
- GitHub: verify issue #5 still open, PR target `main`, feature remote SHA equals local; verify issue #4 branch is contained in `origin/main` and no open PR references it before deletion.

### Acceptance boundary
- Deterministic fixture proves whole event/storm groups do not cross train/evaluation partitions.
- No usable observed flood events currently exist, so model performance against real events remains unavailable; physics/GNN simulated-label agreement is not real-world accuracy. Leave #5 open unless genuine eligible records appear and observed evaluation is actually run.


### Issue #5 execution update
- Phase 0 audit/plan gate passed: no evaluation-grade local flood events; branch created from `origin/main` at `2bfd04d`.
- Phase 1 implementation complete: require storm group identity on evaluation-eligible manifest records; deterministic complete-group partitioner and focused tests added.
- Phase 2 truthful-doc update complete; backtest stays unavailable (501).
- Phase 3 verification passed: focused 9 passed/1 warning; full backend 78 passed/16 warnings; compileall and diff-check exited 0.
- Next gate: inspect staged paths, commit/push feature branch and open PR; then safely remove only the merged #4 branch after verifying remote state.

- Publication: commit `940cdc8f763977f79715bc605a8aaa4ff7635b7b` pushed; PR #14 open against `main`. Remote head SHA matches. GitHub Actions reported two backend and two frontend checks pending at handoff; no CI pass is claimed.
- Cleanup: verified `feature/issue-4-heatwave-baseline` is merged into `origin/main` and unused by all open PRs; deleted local and remote refs.
- Issue #5 remains OPEN because there are no eligible observed flood incidents; actual model validation and real-world scores remain unavailable.
- Final CI check: all four PR #14 Actions jobs passed (two backend, two frontend); GitHub PR state is CLEAN. Issue #5 remains open for the missing observed-event data and real scoring.


# Remaining GitHub issue sequence — updated 2026-11-26

User clarified that each issue must be fully implemented and validated before pushing; close the GitHub issue only after completion. Never push to main. Current open issues: #1, #4, #5, #7, #8. PR #14 for #5 has since merged to main at `5541814`; issue #5 stays open because no observed flood data exist.

## Order and gates
1. **#1 flood event data:** official/public source and licence/access audit; inspect exact data grain and labels. Add only verified rows. If no qualifying data can be lawfully obtained, document evidence and leave open without publishing partial code.
2. **#4 observed heat baseline:** audit licensed station observation access. Existing ERA5-Land training is reanalysis-only and cannot meet observed-ground-truth acceptance. Keep forecast unavailable; leave open if observations unavailable.
3. **#5 observed flood validation:** code/holdout tests merged in PR #14; no real observations exist. Keep open until data are available; no duplicate code.
4. **#7 model cards:** inventory real model configs, source manifests and computed evaluation artifacts, then add versioned model cards and deterministic completeness tests. Mark unavailable metrics/data as unavailable; no tracking platform. Complete focused/full relevant checks before commit/push/PR/issue closure.
5. **#8 combined-map regression:** inspect current frontend and API test boundaries and installed tooling. Add focused independent toggle/alignment/threshold/error-state regression coverage with no unnecessary test framework migration. Complete API/frontend verification before commit/push/PR/issue closure.

For every independent completed issue: branch from current `origin/main`, write/verify the issue plan first, implement only its scope, run tests, stage owned paths, commit/push feature branch and create PR, then close the issue only when all acceptance criteria are met. Data-blocked issues remain OPEN and unpushed. Preserve user-owned untracked paths.


## Issue #1 source audit conclusion
- OpenCity lists BBMP grievance files for 2020–2025 with ward/date/category metadata and a catalog Public Domain marker, but requests for the CSV returned HTTP 403. Actual rows, contents and record-level reuse could not be verified; ward-level grievance records are not confirmed flood observations or street-level outcome labels.
- Bhuvan/NRSC lists Bengaluru low-lying vulnerable zones, but these are priors. The NRSC 2024 inundation report says the affected district was Mysuru. The inspected 2022 Karnataka product is labelled “For official use” and says no ground verification. No reusable Bengaluru event geometry was acquired.
- KSNDMC’s public page describes 15-minute telemetric observations; no historic temperature/RH or matched event rainfall export was acquired. Published aggregate rainfall/KSNDMC counts are not event-level observations.
- Gate result: no qualifying data source available for lawful/reproducible record ingestion. No source records were added, no code was pushed, and issues #1/#4/#5 remain open. Proceed to independent #7/#8 work.

## Issue #7 plan — versioned model cards and experiment records

### Reproducibility micro-plan (2026-11-26)
- Evidence: two separate synthetic FloodGNN training runs with the same recorded seed/configuration produced different dataset SHA-256 fingerprints (`dca6a350…` and `9e6e77cd…`). Inspection found `build_drainage_graph` iterated unordered `set`/`frozenset` edges and nodes, making generated graph tensor order process-dependent.
- Fix narrowly at the graph-construction owner: sort components, nodes, and undirected drain-edge iteration with stable identifiers; add a deterministic ordering regression test. Then rerun full training in separate processes and require matching dataset fingerprint and metrics before publishing the card numbers.
- No existing ignored user artifacts are touched; reproduce only under `/tmp/cityshield_issue7_*`.

### Audit facts
- Current branch `feature/issue-7-model-cards` is based on `origin/main` at `5541814`; tracked working tree was clean. PR #14 is MERGED; issue #5 remains OPEN.
- Flood trainer defaults and synthetic physics labels live in `backend/app/ml/train.py`; architecture in `backend/app/ml/model.py`. A local ignored synthetic checkpoint/metrics exists but does not record complete run provenance. No observed flood metrics exist.
- Single-scene Landsat XGBoost metadata exists only in ignored `backend/data/heat/model/heat_lst_model.metadata.json`, and the workflow is documented in `docs/HEAT_WORKFLOW.md`. Bengaluru multi-date LST metrics are in ignored `backend/data/heat/city-study/evaluation.v2.json` and documented in `docs/BENGALURU_EVALUATION.md`. ERA5-Land report/model are ignored under `backend/data/heat/reanalysis/model/` and documented in `docs/HEATWAVE_REANALYSIS.md`.
- Cards must include only reproducible settings and actually computed metrics; distinguish remote-sensing LST, ERA5-Land reanalysis targets, simulated physics/GNN agreement, and unavailable observed flood/heat validation.

### Phases / exit criteria
1. **Audit and card contract:** verify model configs, ignored report values, source/licence references and reproduction commands. Define versioned machine-readable schema. Exit: every field has a source in code/report or is explicitly unavailable.
2. **Flood experiment manifest:** update the GNN trainer to write a versioned JSON run manifest with dataset fingerprint, generated scenario list and train/validation scenario IDs, provider/provenance, architecture, optimization settings, seed, counts, metrics and limitations. Test deterministic manifest construction with tiny fixtures; run the training command into a fresh `/tmp` output to produce verifiable metrics/manifest without overwriting user artifacts.
3. **Cards and validator:** add versioned JSON cards for physics baseline, GNN surrogate, single-scene Landsat LST, multi-date Bengaluru LST, and ERA5-Land next-day Tmax; test required fields, unique versions, metric/source provenance boundaries and unavailable observed validation. Add a concise README index only if needed.
4. **Reproducibility and verification:** run card tests, relevant flood/heat/reanalysis suites, full backend suite, documented training reproduction from the existing licensed local Landsat/ERA5 data where available, diff check. If report cache/source artifacts are missing or stale, report the exact limitation instead of fabricating values.
5. **Publish/close:** after all issue #7 acceptance is met, stage only issue paths, commit, push feature branch, create PR, and close issue #7. Keep all ignored datasets/models out of Git.

### Planned paths
- `backend/app/ml/train.py` and likely a focused new test module for experiment manifest generation.
- New `docs/model-cards/v1.0.0.json`, `docs/MODEL_CARDS.md`, and focused schema/content tests (in `backend/tests`).
- Handoff state/log/plan. Never stage `backend/data/` or unrelated user-owned untracked paths.

### Validation commands
- Focused: `cd backend && .venv/bin/python -m pytest tests/test_model_cards.py tests/test_ml_model.py tests/test_flood_event_data.py -q`.
- Heat reports/cards: `cd backend && .venv/bin/python -m pytest tests/test_heat.py tests/test_city_study.py tests/test_reanalysis.py -q`.
- Actual GNN reproduction: `cd backend && .venv/bin/python -m app.ml.train` only with an explicit task temp output to avoid replacing ignored artifacts (use a small harness if CLI lacks output control).
- Full suite: `cd backend && .venv/bin/python -m pytest -q`; root `rtk proxy git diff --check`.
- Acceptance: all five workflows have versioned metadata, provenance, source/date range, preprocessing/CRS/resolution as applicable, split/seed/hyperparameters, metrics or explicit unavailable state, limitations, and a reproducible command or exact missing input.

## Issue #8 plan — combined map regression coverage

### Audit facts
- Issue #8 is OPEN: https://github.com/bibek200620/cityshield/issues/8. PR #15 for #7 has passed backend/frontend CI; #7 is closed. Keep work isolated on a fresh branch from current `origin/main`.
- The frontend is Vite + React + TypeScript. Existing scripts are dev/build/lint/preview only; there is no frontend test runner or Playwright package. `npx` is available, and the existing CI has frontend lint/build plus the full backend pytest suite.
- Existing UI owners: `frontend/src/App.tsx` `MapLayers` renders independent Flood/Heat/Combined Exposure checkboxes and status messages; `frontend/src/components/MapView.tsx` derives separate flood/heat layers and filters only `both_elevated` cells for combined display; `frontend/src/store/useFloodStore.ts` owns async heat/exposure result/error state.
- Existing backend owner: `backend/app/geo/exposure.py` snaps independent outputs onto EPSG:32643 30 m cells; `backend/app/api/routes_exposure.py` returns unavailable if Landsat inputs are missing and otherwise outputs separate risk fields. `backend/tests/test_exposure.py` already tests threshold and one-hazard-missing pure behavior; `backend/tests/test_api_integration.py` currently tests unavailable response only.
- No changes to app behavior are assumed until browser/API tests identify a defect. A narrowly scoped browser-test dependency is justified only if needed to add repeatable browser coverage; avoid a framework migration or product redesign.

### Planned phases / gates
1. **Contract/tests plan:** define observable browser states (independent toggles, each hazard status, combined empty/error/unavailable) and API contract (separate flood/heat fields, `both_elevated` only when depth ≥ documented threshold and relative heat flag true; missing layer remains null/false). Exit: tests use real API calculation where practical and visibly distinguish mocked browser endpoints.
2. **API regressions:** add a route-level ready/unavailable contract test using controlled in-memory fixture data; preserve existing CRS/threshold constraints and no-probability claim. Exit: route passes true, one-hazard-missing, threshold-boundary and invalid scenario cases without external sources.
3. **Browser regression:** add the focused `@playwright/test` dev dependency because this repository has no browser-test runner and issue #8 explicitly requires end-to-end regression coverage. Run browser against Vite with API endpoints intercepted using clearly-labelled synthetic fixtures; cover independent toggles, one unavailable layer with the other still inspectable, combined loading/empty/API-error, and truthful LST/simulation status. Exit: browser test command passes locally and in CI; app behavior is unchanged unless a failing regression proves a defect.
4. **Integration verification:** focused API/browser, frontend lint/build, complete backend suite and `git diff --check`; inspect only issue-owned changes. Exit: checks green; no unrelated UI changes.
5. **Publish/close:** one scoped issue commit only after #8 is fully complete/validated, push feature branch, open PR to `main`, verify CI, then close #8. Never push `main`.

### Likely affected paths (confirm while implementing)
- `backend/tests/test_exposure_api.py` (or existing API test module)
- `frontend/package.json`, `frontend/package-lock.json`, `frontend/playwright.config.ts`, `frontend/e2e/combined-map.spec.ts`
- `.github/workflows/ci.yml` for the focused E2E invocation and Chromium install
- Existing `frontend/src/App.tsx`, `MapView.tsx`, `useFloodStore.ts` only if a focused test reveals a failing behavior
- `docs/IMPLEMENTATION_STATE.md` (copy previous version to backup before replacement), append-only log and this temporary plan

### Validation commands
- `cd backend && .venv/bin/python -m pytest tests/test_exposure.py tests/test_exposure_api.py tests/test_api_integration.py -q`
- `cd frontend && npx playwright install chromium && npm run test:e2e`; `npm run lint`; `npm run build`
- `cd backend && .venv/bin/python -m pytest -q`; root `rtk proxy git diff --check`
- GitHub: verify feature branch SHA, PR target `main`, all checks, and issue #8 closed only after all acceptance is satisfied.


# Remaining open issues continuation — 2026-11-26

## Objective
Continue only open issues #1, #4, and #5 on the confirmed `origin https://github.com/bibek200620/cityshield.git` project repository. Preserve observed/simulated distinctions and the user's one-commit-per-completed-issue policy. Do not push to main; do not close issues until acceptance is met. Current branch is issue #8 PR branch, so each code issue needs a fresh branch from current `origin/main`. User-owned untracked workspace paths listed in implementation state must remain untouched.

## Evidence discovered during audit (not yet evaluated for model use)
- NOAA NCEI GHCNh is a public, station-based hourly/synoptic observation dataset. Official sources: https://www.ncei.noaa.gov/products/global-historical-climatology-network-hourly and DOI https://doi.org/10.25921/jp3d-3v19.
- Downloaded the official GHCNh station inventory to `/tmp/cityshield-ghcnh-stations.txt` (not the repo). It lists `INM00043296` BANGALORE/HINDUSTAN AIRPORT at 12.95, 77.6333, elevation 888 m, and `INI0000VOBL` BANGALURU INTL AIRPORT at 13.2, 77.7, elevation 915 m. Another site `INMU0020525` is listed for BANGALORE INDIA at 12.97,77.58.
- NCEI station-file prefix for `INM00043296` lists `GHCNh_INM00043296_por.psv` (139,189,084 bytes; last modified 2026-11-24). HTTP byte-range checks show latest HAL observations through 2026-11-21, with temperature and dew-point, plus intermittent relative humidity. This proves a public station archive exists but not adequate history, continuity, input completeness, licensing fit or forecast-baseline suitability. Full quality profiling remains pending.
- IMD Pune's official portal provides historical observation procurement and lists station data; its current documented process is account registration, availability/cost estimate and possible payment. No IMD request will be submitted by the agent.

## Plan and phase gates
### Phase 0 — handoff/source audit (no code edits)
- Reverify current branch/status, root remotes, issue bodies and actual local manifests/docs/source code. Preserve untracked user work.
- Read required guides and apply the data-quality skill.
- Write this issue plan, exact paths, validation commands and data gates before source/model code changes.
- Exit: current implementation, issue criteria and source leads verified; no code edits yet.

### Phase 1 — issue #1 flood record search and gate
- Recheck authoritative/public flood-event sources and direct download/access. Existing checked-in source manifest is one coarse narrative and spatial-prior candidates, not event labels.
- Candidate source evidence to recheck: OpenCity BBMP catalog, official NRSC/NDEM event layers, KSNDMC/IMD source descriptions, and dated event reports. Do not contact data custodians, invent locality coordinates, or use aggregated counts as road events.
- If a lawful machine-readable dataset with event timestamp, location, outcome/extent and reuse terms is actually accessible, profile duplicates, missingness, coordinate/time precision and event grain, then plan only a schema/provenance update plus validation tests. Otherwise update issue/state with precise blocker and leave #1 open; do not publish partial code as dataset completion.
- Paths if data exists: `backend/app/ml/flood_event_sources.json`, `backend/app/ml/flood_event_data.py`, focused tests and `docs/FLOOD_EVENT_DATA.md`/`docs/DATA_SOURCES.md`. Validation: `cd backend && .venv/bin/python -m pytest tests/test_flood_event_data.py tests/test_api_integration.py -q`, full suite if code changes, and `rtk proxy git diff --check`.
- Gate: no score, ground-truth label or completed #1 claim without eligible records and license/access evidence. If blocked, proceed to independent #4 discovery.

### Phase 2 — issue #4 observed-station suitability audit
- Download NOAA NCEI GHCNh station `INM00043296` data to temporary/ignored storage only; retain upstream citation and collection metadata. Also inspect `INMU0020525` and VOBL only if needed for data completeness/continuity. Do not merge locations silently.
- Inspect file schema, date span, record count, duplicate keys, temperature/RH/dew-point coverage by year/month, quality/source flags, station coordinates/elevation stability, reporting intervals, missingness, and any source changes. Convert dew point to RH only if exact validated formula and temperature pairing are documented; do not fill missing observations. NOAA station observations are point data, not neighborhood measurements.
- Exit if one site has sufficient, quality-flagged temperature/humidity coverage to define a same-station daily target and an adequate chronological holdout. Otherwise document observed coverage and leave #4 blocked (IMD archive would require authorized/user-led procurement).

### Phase 3 — issue #4 baseline implementation only if Phase 2 passes
- Create `feature/issue-4-observed-heat-baseline` from current origin/main only after Phase 2 finds suitable observations; do not edit existing model/API to expose a forecast.
- Add a deterministic reusable station-data parser/validator and baseline workflow using actual station records, explicit target (e.g. next local-day Tmax, only if observation coverage supports daily aggregates) and horizon; chronological holdout; persistence and training-only seasonal climatology compared against a simple temporal model only if data scale supports it. Preserve ERA5-Land model/report separately and label NOAA station run independent observed station test data.
- No public warning or UI/API forecast. Missing station fields/dates remain missing; no gap-filling or synthetic records. Document input provider, source station(s), date range, unit/UTC-to-local rules, QC/source flags, training rows/held-out rows, random seed/hyperparameters and actual metrics.
- Candidate paths: new `backend/app/heat/station_observations.py` (or minimal extension to `train_reanalysis.py` only if the owner is truly reusable), new focused training module/report docs, `backend/tests/test_heat_station_data.py`, docs/data-sources/model card changes only as required.
- Validation: focused parser/split/baseline tests; train only from the retrieved station archive; independent manual row/sample count and date-boundary check; full backend suite; `compileall`; `rtk proxy git diff --check`; no large raw data or model artifacts staged.
- Gate: observed-data holdout scores and comparison are reproducible; forecast stays unavailable in product pending separate validation adequacy review. If model quality or coverage inadequate, keep issue open and report actual evidence.

### Phase 4 — issue #5 flood evaluation readiness
- Reverify current issue #5 branch/PR merge and splitter tests. Do not duplicate already merged storm-group split support. Recheck whether eligible flood data appeared since prior audit.
- If absent, retain API 501 and issue open; add no code or fabricated metrics. If data appears, use whole storm holdout and trace data rights/outcomes before real validation.
- Validation if data appears: focused flood manifest/backtest tests plus full backend suite and an event-level leakage audit.

### Phase 5 — handoff / publication
- Only a completed issue with passing scoped tests gets one scoped commit, push to its feature branch, PR to `main`, hosted-check verification, and issue closure if all issue criteria actually pass. Never push main.
- Update state (backup first) and append actual test/access results to log after each gate. If remaining issues are data-blocked, report exact evidence, URLs, counts, and the one item needed from the user.

## Current exact action (after issue #4 publication)
Issue #4 was completed locally, published in commit `91c552550368a7490c4a16c43bd1f6b38fad4706` on `feature/issue-4-observed-heat-baseline`, and PR #18 to `main` has all four hosted checks passing; the issue is CLOSED. The XGBoost model underperformed persistence, and no app forecast was enabled. Remaining open issues #1 and #5 have been rechecked against their current GitHub bodies and the checked-in event evidence manifest. No evaluation-grade event data is available: the lone 2022 situation report lacks per-location geometry/outcomes/rainfall, common flood locations are undated spatial priors, and other sources lack verified authorized machine-readable Bengaluru events. Leave #1/#5 OPEN and the backtest unavailable until a lawful, time-stamped event dataset with observed outcome, location precision and matched rainfall becomes available. The single next action is to obtain that source/data with reuse terms; do not create coordinates or labels from narrative locality names.

### Confirmed Phase 2 profile and Phase 3 scope
- Archive: NOAA NCEI GHCNh, station `INM00043296` BANGALORE/HINDUSTAN AIRPORT, one fixed site at 12.95 N, 77.6333 E, 888 m. Raw file `/tmp/cityshield-ghcnh-INM00043296_por.psv`, 139,189,084 bytes, SHA-256 `f54169d47017e2be68df7f1c461503e8cadec97f6afc13dfc2e59161f8b15a6c`.
- Entire-file profile: 183,179 chronological rows, no invalid dates, duplicate adjacent timestamps or backward timestamps. Coverage has multi-year gaps; therefore do not treat the archive as a continuous daily series.
- Daily input rule: only source-223 temperature with QC flag `1`; RH only when source `223`, measurement code `D`, and quality flag is neither `f` nor `o`; convert UTC timestamps to Asia/Kolkata before grouping. Keep rows with paired valid temperature/RH; do not fill gaps or mix stations.
- Require at least 8 paired reports spanning at least 18 hours on each local date. The packaged parser yields 4,497 eligible days and 4,332 adjacent valid-day examples; 3,250 training examples (2005-05-19 through 2022-12-31) and 997 test examples (2023-01-01 through 2025-12-31). An earlier exploratory profile reported higher counts because it did not enforce the exact paired source-station filter; use only packaged-parser counts in reports.
- Implement a one-local-day-ahead station Tmax (°C) experiment. Training target dates through 2022; chronological test target dates 2023–2025. Compare previous-day Tmax persistence and training-only circular day-of-year climatology with XGBoost on identical held-out rows. This is a narrow airport-station point-series evaluation, not Bengaluru-wide forecast evidence or a heatwave warning.
- Existing reusable dependencies are already pinned: pandas 2.2.3, numpy 1.26.4, scikit-learn 1.5.2, xgboost 3.1.2. Existing `reanalysis.py` / `train_reanalysis.py` establish the local next-day feature, chronological split and report conventions, but NOAA parsing remains a separate module because its source/QC contract differs.
- Planned issue-owned paths: `backend/app/heat/station_observations.py`, `backend/app/heat/train_station_observations.py`, `backend/tests/test_heat_station_observations.py`, and `docs/HEATWAVE_STATION_BASELINE.md`, `docs/DATA_SOURCES.md`, `docs/MODEL_CARDS.md` or versioned model-card JSON only where needed. Keep the current API/UI forecast unavailable.
- Checks: focused new parser/training tests; full `cd backend && .venv/bin/python -m pytest -q`; `python -m compileall -q backend/app/heat backend/tests`; reproducible training from the exact downloaded archive; independent report/date/count/hash inspection; `rtk proxy git diff --check`.
- Gate: report must be reproducible, baselines and model use identical real held-out station dates, no temporal leakage, and limitations/provenance are explicit. If unsuitable or tests fail, stop and document rather than publish/close issue #4.

### After issue #4
- Recheck #5's required inputs and the merged storm-group split implementation. With no event-level observations and matched rainfall, leave issue #5 OPEN and the observed backtest unavailable.
- Recheck #1 for new authoritative flood incident data. Without eligible records and reuse terms, leave it OPEN.
- One issue-scoped commit, feature branch push, PR targeting `main`, hosted checks, and issue close only after actual acceptance. Never stage progress files, raw data, or preserved user paths.


## Issue #1 — current source/access audit plan (2026-11-26)

### Objective and gate
Find an authoritative, legally reusable, machine-readable Bengaluru flood incident source suitable for open issue #1. Required grain is one independently supported flood incident/location record with a source, event time and precision, location and location precision, provenance, quality flags, and documented permissions. Do not treat a zone-level situation summary, a spatial flood-prone prior, aggregate count, or flood inundation layer intended for authorized users as a verified street event. No data/model code changes begin unless a source actually meets the gate.

### Phase 0 — baseline and plan gate (complete)
- Re-read current `AGENTS.md`, mandatory shared guidance, state/log, issue #1 body, current event-source manifest, validator/tests and flood documentation.
- Correct stale handoff facts after backing up the prior state: PR #18 is merged at `3593ca2`; issue #4 is closed; active branch remains the merged #4 feature branch; issues #1 and #5 remain open.
- Write this source plan before live/source inspection. Exit: scope, source candidates, paths, checks and no-fabrication gate documented.

### Phase 1 — bounded source discovery (next)
- Inspect the original sources behind current candidates and at most two focused lookups each: OpenCity/BBMP catalog and direct resource; official KSNDMC/BBMP data portals; NRSC/NDEM dated inundation products and access terms; official or primary event-specific situation reports only if they provide record-level detail.
- For every promising resource record catalog owner/publisher, direct URL, access outcome/HTTP status, file/schema, record count if downloaded, date/time coverage and precision, location grain/coordinates, outcome label semantics, duplicate/missingness checks, license/permission, retrieval date and content hash.
- Do not log in, purchase data, contact custodians, bypass portal controls, or infer permission. Do not convert narrative locality names to points.
- Exit: either identify a source with inspectable records and terms satisfying issue #1, or document precise blockers and stop application changes.

### Phase 2 — record profiling and eligibility (only if Phase 1 finds data)
- Keep raw files outside Git/ignored storage unless explicit source terms allow redistribution. Build a source manifest and schema only after inspecting original rows.
- Profile intended incident grain, event-time precision/timezone, unique keys/duplicates, missing dates/locations/outcomes, coordinate CRS/ranges, record-level provenance and licensing. Distinguish narrative/event reports, official mapped inundation, spatial priors and matched rainfall.
- Label a record evaluation-eligible only when its source independently supports its time/location/outcome and rights are documented. Issue #5 additionally requires matched event rainfall and event/storm IDs.
- Exit: machine-readable records can pass current `flood_event_data.py` validator with verified quality flags, or remain explicitly ineligible.

### Phase 3 — scoped integration and tests (only when the contract passes)
- Likely paths: `backend/app/ml/flood_event_sources.json`, `backend/app/ml/flood_event_data.py` only if schema/validation needs a justified extension, `backend/tests/test_flood_event_data.py`, `docs/FLOOD_EVENT_DATA.md`, and `docs/DATA_SOURCES.md`.
- Add only verified records, source/version/permission metadata and stable validation tests for IDs, duplicate events, time precision, coordinates/CRS, quality flags, outcome, provenance and eligibility. Do not add scoring unless matched inputs and outputs support an actual evaluation.
- Validation: from `backend/`, `.venv/bin/python -m pytest tests/test_flood_event_data.py tests/test_api_integration.py -q`, then full `.venv/bin/python -m pytest -q`, Python compile check and `rtk proxy git diff --check`. Independently re-open the source and reconcile actual file rows/hash with the manifest.
- Exit: every accepted record is traceable and tests preserve an unavailable state for unusable data.

### Phase 4 — publication or blocker handoff
- If issue #1 acceptance is met, create a feature branch from latest `origin/main`, commit one completed issue-scoped chunk only after tests pass, push that branch, open one PR to `main`, verify hosted checks, then close #1 only after acceptance is confirmed. No direct main push.
- If no data source meets the gate, make no application-data changes and no empty commit. Keep #1 open; record exact unavailable resource, observed access status and the precise authorized dataset needed. Then issue #5 remains blocked until observed outcomes plus matched rainfall exist.

### Phase 1 findings / exact next action
- OpenCity catalog metadata now lists annual BBMP grievance CSVs for 2020–2025; its 2025 data dictionary contains complaint ID, category, subcategory, grievance date, ward name, status, staff remarks and staff name. Catalog metadata says source BBMP, data last updated 2025-11-25, datastore active/all rows, and `Other (Public Domain)`; it does not list coordinates or road locations. These are grievance reports, not automatically verified flood observations.
- Direct download of the catalog's 2025 CSV and direct datastore query both returned HTTP 403. No raw rows/hash were obtained, so category values, precise content, data-quality profile and actual re-use terms remain unverified. Do not use the candidate as event labels.
- KSNDMC 24-hour realized-weather page displayed no rows and “Database Under Maintenance”; public flood-alert page is an aggregate Karnataka summary, not an event table. NDEM documentation describes date-wise historical flood layers but says portal content is intended for authorized users; the inspected 2022 Karnataka product is preliminary, marked for official use, and not ground-verified.
- Phase 1 exit: source gate NOT PASSED. No application/data files changed, no tests or commit. Issue #1 stays open; issue #5 still lacks observed outcomes and matched rainfall.
- Exact next action: provide an authorized, inspectable, reusable incident export with event time/precision, location/precision, provenance and quality flags. For #5 also provide verified outcome/extent and matched event rainfall. Do not infer road points from ward names or situation-report prose.


### Phase 1 update — user supplied official inventory (2026-11-26)
- `/Users/shinobi/Downloads/India_Flood_Inventory_v3.csv` is 1,801,579 bytes; SHA-256 `ef9ab2cd0db7bf917dcc22c7cb094ec599f5013ef1b96ba525d816f26ff1b108`; MD5 `fea75a9ff9eba8fb328eaddfacd21d67`. The MD5 matches the `India_Flood_Inventory_v3.csv` file in Zenodo record v3 `10.5281/zenodo.11275211`; that exact record's metadata reports CC BY 4.0. The current record v4 reports a different license (CC BY-NC 4.0), so cite and apply the v3 file/version terms matching the supplied bytes.
- Dataset profile: 6,876 national rows; 53 unique event IDs list the exact district name `Bengaluru Urban`; event dates range from 1969 through 2023. All source locations are district-level and no coordinates are supplied; 30 rows list multiple districts. Treat as district-scale historical inventory evidence only, preserve dates as date/date-range precision, and mark all rows ineligible for drainage/road-level model evaluation. Source reports are attributed to IMD; this is not the underlying station or local-government observation archive.
- `/Users/shinobi/Downloads/bengaluru_flood_incidents.csv` has 92 curated rows and 31 columns, but no coordinates or measured depths/rainfall; 78/92 are reported-not-independently-verified, 82/92 reuse notes say paraphrased public article facts, and its collection/review provenance is not documented outside the file. Do not import it as verified truth or redistribute it. It can be used only as a lead list if individual references are independently checked.
- The user-linked 2022 Frontiers article is CC BY, but its data-availability statement says KSNDMC high-resolution observations are request-only and local-government data are classified/not public. Its published text may be cited; underlying restricted records are not included.
- Source gate now passes for adding the traceable district-scale IFI subset to the descriptive event inventory, not for issue #5 evaluation. Proposed paths: a scoped derived data file/manifest under `backend/data/flood_events/`, `backend/app/ml/flood_event_sources.json`, focused manifest tests, `docs/FLOOD_EVENT_DATA.md` and `docs/DATA_SOURCES.md`. Keep all 53 `evaluation_eligible: false`, include dataset DOI/version/license/checksum, filter procedure, date precision, district-scale limitation and no-redistribution of unrelated source material.
- Next: branch from latest `origin/main`; generate/review the 53-row subset from the supplied checksum-matched file, add deterministic validation tests and docs. Recheck dates/counts/hash independently. Issue #5 remains blocked because these rows provide no event-matched rainfall or sub-district observed flood extent/depth.


### Phase 2 — issue #1 licensed district inventory implementation (complete locally)
- Added the IFI-Impacts v3 source citation, license, exact file MD5, and reproducible district subset. The generated artifact contains 53 unique Bengaluru Urban records; all have date/date-range precision, district location precision, provenance and quality flags; none has inferred coordinates or evaluation eligibility.
- Added parser/validator and six focused data tests; updated flood/data-source documentation. The 92-row curated Bengaluru table remains unimported because its reports are not independently verified, lack geometry/depth/rainfall and do not include an external curation/review method.
- Validation completed: focused flood/IFI tests 16 passed; full backend 106 passed with 16 dependency/deprecation warnings; compile check passed; regenerated output matches checked-in subset byte-for-byte; `git diff --check` passed.
- Phase 2 exit gate: passed for source-provenance dataset inventory only. It does not satisfy issue #5 real-world scoring.

### Phase 3 — issue #1 publication (next)
- Inspect final diff and stage only `backend/app/ml/flood_event_sources.json`, `backend/app/ml/ifi_inventory.py`, `backend/data/flood_events/README.md`, `backend/data/flood_events/ifi_bengaluru_urban.csv`, `backend/tests/test_ifi_inventory.py`, `docs/DATA_SOURCES.md`, `docs/FLOOD_EVENT_DATA.md`.
- One commit on `feature/issue-1-flood-event-inventory`, push branch, open one PR to `main`, verify hosted checks, provide evidence comment and close #1 only if acceptance and checks remain satisfied. Keep #5 open.


### Issue #1 publication complete; issue #5 remains data-blocked
- One commit `cccb907b4060e95433a494dee2e48c24454b9771` was pushed to `feature/issue-1-flood-event-inventory`; PR #19 targets `main` and is open/unmerged. Four hosted checks passed (backend/frontend in two runs). GitHub issue #1 was commented with acceptance evidence and verified CLOSED.
- Issue #5 remains OPEN. Supplied IFI dataset lacks localized extent/depth and matched rainfall; Bengaluru compilation lacks populated coordinates, depth/rainfall and independent verification; linked Frontiers paper says raw KSNDMC/high-resolution and local government datasets are restricted. Backtest remains unavailable.
- Next action: obtain an authorized, inspectable dataset with timestamped flood outcome/extent, location and precision, storm IDs, matched event rainfall, source provenance/quality flags and reusable terms. No inference from district/news text.


### Issue #5 — new authorized flood/rainfall CSV and paper supplement audited (2026-11-26)
- New file has 2 rows for one 20–21 Oct 2020 event, same event-wide 124.5 mm/24h Kengeri rainfall maximum; coordinates, WLS IDs and timestamps blank in the user file. Road/surface labels and actual water-depth fields are unknown; values 122%/21% are drain-depth exceedance indicators, explicitly not proof of road flooding. Rainfall is not sensor co-located or peak-time matched. SHA-256 `801d06f7266bfd397e3f469f1edc10e69755af6066b76cae3c8ce1f4023aaa46`.
- Inspected the paper's CC BY supplement (DOI `10.3389/feart.2022.883842.s001`) from `/tmp`: its S3 table adds five sensor-summary observations with WLS IDs, names, timestamps, flow depths and drain depths; S5 only adds an event-level max 24h rainfall. No raw 15-minute series or sensor coordinates. Main paper says KSNDMC high-resolution data are request-only and local government datasets classified.
- No event holdout possible with one storm; no event-resolution matched forcing; no point coordinates/network alignment. No app/data code changes or tests. Keep issue #5 open and backtest unavailable (HTTP 501).
- Exact required input: authorized multi-storm 15-min rainfall observations and corresponding sensor-level water-level observations with event/station/sensor IDs, coordinates, timestamps, sensor QC, drain reference depth, source/reuse rights, and a defensible mapping to the model network or observed flood geometry.
