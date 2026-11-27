# Bengaluru flood event evidence

## Current status

The repository contains 53 dated, district-scale event records from the checksum-verified IFI-Impacts v3 inventory, plus five attributed sensor-summary rows transcribed from a published Bengaluru case study. The five rows describe one 2020 storm and have no coordinates or matched rainfall series; one sensor value is inconsistent across two supplement tables. Both datasets are explicitly ineligible for CityShield model training or evaluation. The historical backtest endpoint therefore remains unavailable (HTTP 501).

The user-supplied `bengaluru_flood_incidents.csv` was audited but is not copied into the project: it contains 92 curated media/research rows without coordinates or measured flood depth/rainfall; most are reported and not independently verified, and the file does not document the compiler's review method. It can be used as a reference lead list, not as verified ground truth.

## Manifest contract

The manifest uses schema version `1.0.0` and is validated by `backend/app/ml/flood_event_data.py`:

- Every source has a stable ID, title, publisher, URL, evidence basis, publication date when known, and reuse-status note.
- Each event refers to a known source and includes an event kind, date/time precision, source publication time, named area, location precision, geocoding provenance, an observation object, quality flags and an explicit evaluation-eligibility decision.
- GeoJSON point coordinates, when present, are longitude then latitude in WGS84 and must be within coordinate bounds. The current narrative record deliberately has `geometry: null`; it has not been geocoded.
- Evaluation-eligible events require a bounded event time, verified geometry, an observed flood outcome and a non-negative event rainfall series. Records missing any of those remain descriptive evidence and cannot be passed to event scoring.
- Evaluation-eligible events must also have a documented `storm_group_id`. The deterministic `partition_event_groups` helper assigns complete storm groups to one partition; it rejects ineligible rows and does not score models. Keep storms/events wholly separate between training and evaluation to avoid leakage.
- Record IDs and same-source/date/location records must be unique. Distinct locations on one date may be separate records only when the source independently supports those observations. Do not create one coordinate event per locality from an aggregate report.

## Evidence inventory

### IFI-Impacts v3 district inventory

The normalized subset is [`backend/data/flood_events/ifi_bengaluru_urban.csv`](../backend/data/flood_events/ifi_bengaluru_urban.csv). It was filtered from the supplied `India_Flood_Inventory_v3.csv` by exact district-name membership (`Bengaluru Urban` in the source `Districts` field). The input had 6,876 rows and a SHA-256 of `ef9ab2cd0db7bf917dcc22c7cb094ec599f5013ef1b96ba525d816f26ff1b108`; its MD5 `fea75a9ff9eba8fb328eaddfacd21d67` matches the file published in [Zenodo record 10.5281/zenodo.11275211](https://zenodo.org/records/11275211). The record identifies version 3 and declares [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The later v4 record identifies different reuse terms, so this project cites and uses the exact v3 record matching the supplied file. Attribution and transformation details are in [`backend/data/flood_events/README.md`](../backend/data/flood_events/README.md).

The subset contains 53 distinct inventory IDs spanning 1969–2023. Thirty source rows list multiple districts; those are retained as the inventory reports them and are flagged. The file stores the date fields as dates/date ranges, discarding the source's `00:00` placeholder because it is not a reported event time. It does not infer coordinates or split multi-district events into separate observations. The inventory's source event IDs are retained when present; missing source IDs remain empty.

Rebuild the subset from the downloaded v3 file with:

```sh
cd backend
.venv/bin/python -m app.ml.ifi_inventory \
  --source /path/to/India_Flood_Inventory_v3.csv \
  --output data/flood_events/ifi_bengaluru_urban.csv
```

The command refuses a source file whose MD5 does not match the cited v3 artifact. This dataset is suitable as district-scale dated event evidence and provenance; it is not citywide point truth, a flood-depth label set, matched rainfall input, or road-level validation data.

1. **Sphere India, Bengaluru flood situation report, 2022-09-06 13:00 IST.** It reports widespread rainfall on the night of 2022-09-04, inundation in low-lying areas across named zones, and mentions localities including Whitefield, Yemalur, Rainbow Drive Layout, Marathahalli and Sunny Brooks Layout. The report does not pair each locality with an exact time or geometry and is not a machine-readable incident log. Its information is described as coming from SEOC Karnataka and other sources. The manifest retains only bibliographic metadata and a short factual summary. The report states no open data licence; no reuse permission for underlying event data was verified. Source: [Sphere India report](https://www.sphereindia.org.in/sites/default/files/2023-09/_1.%20SitRep%20-%20Floods%20in%20Bangaluru.pdf).
2. **OpenCity “Flooding Locations in Bengaluru Urban.”** The catalog describes common flooding points. No event timestamps are described, so these points are a spatial prior only and are not included as incident labels. Source: [OpenCity Bengaluru dataset catalog](https://data.opencity.in/dataset/?groups=bengaluru&organization=bruhat-bengaluru-mahanagara-palike).
3. **NRSC/NDEM flood inundation layers.** NRSC describes date-stamped satellite inundation layers. NDEM states that its portal content is intended for authorized users; no public, reusable Bengaluru-specific street event layer was verified for this work. Do not import portal data without authorized access and source terms. Source: [NRSC near-real-time mapping note](https://ndem.nrsc.gov.in/documents/downloads/nrt_technical_note.pdf) and [NDEM portal](https://ndem.nrsc.gov.in/).
4. **Davis et al. (2022), WRF–PCSWMM Bengaluru flood study.** The open-access article (CC BY) describes observed rain-gauge and drain-sensor data for selected 2020–2021 events. Its data-availability statement says KSNDMC high-resolution observations are request-only and local-government datasets are classified, not public. This project cites the article only; it does not include or reconstruct the restricted underlying time series. Source: [Frontiers article](https://doi.org/10.3389/feart.2022.883842).

### Published sensor summaries for 20–21 October 2020

[`frontiers_2020_sensor_summary.csv`](data/flood_events/frontiers_2020_sensor_summary.csv) transcribes the five point-in-time observed drain levels in Supplementary Table S3, with WLS ID, reported place name, timestamp, observed flow depth, drain depth and source attribution. The five locations were selected as critical sensors; the file has no coordinates and does not include the underlying 15-minute series. Its repeated 124.5 mm Kengeri value is the same event-level 24-hour maximum for every row, not five independent or co-located rainfall observations.

The user's two supplied `water_level_excess_over_drain_depth_pct` values match two Vrishabhavathi Valley rows by recalculation: 122% maps to WLS 100021 (`2.332 m` flow / `1.05 m` drain, at 00:45 IST) and 21% maps to WLS 100034 (`2.55 m` / `2.1 m`, at 01:30 IST). This joins on event/catchment and rounded derived value, not row order; the input rows did not carry the WLS IDs. Supplementary Table S6 separately lists a 0.9 m observed maximum for WLS 100021 at the same time. The conflicting 2.332 m and 0.9 m source values are both preserved in the CSV and marked unresolved.

These summaries may be used as cited, one-event case-study evidence. They are not sufficient for training or testing CityShield: sensor coordinates and model-network IDs are absent, rainfall is an event maximum rather than a matched time series, only one storm is represented, and one measured value is contradictory. Do not report the article's PCSWMM scores as CityShield scores. The detailed source search and calculation record is in [`ISSUE5_RESEARCH_BENCHMARK.md`](ISSUE5_RESEARCH_BENCHMARK.md).

### Storm replay in the browser

Open **Storm replay** to step through the five Table S3 snapshots in local time. The study's WSM6KF3-driven PCSWMM peaks from Table S6 are shown beside observations for the two matching sensor IDs. The model peaks have their own timestamps. At WLS 100003, the two tables give the same water depth at different times. At WLS 100021, they report different depths at the same time. The replay preserves these distinctions, skips the intervals between published snapshots, and shows the Table S5 gauge maximum as event context.

Run `python scripts/build_storm_replay.py` to regenerate the browser data from the checked-in summary and the two transcribed Table S6 rows in the script. Source pages 8, 10 and 11 were checked against the CC BY 4.0 [published supplement](https://ndownloader.figshare.com/files/35248909), with MD5 `7e78fc9e0d9766566f1236e922a35cb4`. The app displays the study results as a published reference. The [storm importer](STORM_BUNDLE.md) can enable the separate drainage model comparison when eligible data and model output are installed. The [data request draft](STORM_DATA_REQUEST.md) describes what is still needed.

The IFI subset is a third-party licensed district-scale event inventory. It has dates and district names but no coordinate geometry, local flood extent/depth, or matched event rainfall. It can support historical context and data provenance only; it is not used as a training label or for scoring the physics/GNN model. The Sphere India report remains a secondary narrative, not ground-verified street truth. The repository does not infer coordinates from locality names or treat city-level narrative as street-level ground truth. No physics or GNN score against observed flood events can currently be reported. Existing GNN labels come from the simplified physics baseline; agreement with those labels is surrogate agreement, not observed-event predictive performance.

## Verification

From `backend/` run:

```sh
.venv/bin/python -m pytest tests/test_flood_event_data.py -q
.venv/bin/python -m pytest tests/test_ifi_inventory.py -q
.venv/bin/python -m pytest tests/test_frontiers_2020_sensor_summary.py -q
```

The tests validate the evidence manifest, the 53-row source subset, date normalization, exact district filtering, source event ID uniqueness, source checksum pinning, no-coordinate handling, evaluation exclusion, deterministic storm-group separation, and the five published sensor-summary records and derived ratios. The backtest API returns HTTP 501 for unconfigured events. No observed-event drainage model score is bundled with this release.
