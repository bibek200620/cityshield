# Bengaluru flood event evidence

## Current status

The repository has no evaluation-grade, time-stamped Bengaluru flood incident dataset. `backend/app/ml/flood_event_sources.json` is a source and evidence manifest, not a model training dataset. It contains one coarse narrative reference and two candidate-source records; the narrative event is explicitly ineligible for evaluation. The historical backtest endpoint therefore remains unavailable (HTTP 501).

## Manifest contract

The manifest uses schema version `1.0.0` and is validated by `backend/app/ml/flood_event_data.py`:

- Every source has a stable ID, title, publisher, URL, evidence basis, publication date when known, and reuse-status note.
- Each event refers to a known source and includes an event kind, date/time precision, source publication time, named area, location precision, geocoding provenance, an observation object, quality flags and an explicit evaluation-eligibility decision.
- GeoJSON point coordinates, when present, are longitude then latitude in WGS84 and must be within coordinate bounds. The current narrative record deliberately has `geometry: null`; it has not been geocoded.
- Evaluation-eligible events require a bounded event time, verified geometry, an observed flood outcome and a non-negative event rainfall series. Records missing any of those remain descriptive evidence and cannot be passed to event scoring.
- Record IDs and same-source/date/location records must be unique. Distinct locations on one date may be separate records only when the source independently supports those observations. Do not create one coordinate event per locality from an aggregate report.

## Evidence inventory

1. **Sphere India, Bengaluru flood situation report, 2022-09-06 13:00 IST.** It reports widespread rainfall on the night of 2022-09-04, inundation in low-lying areas across named zones, and mentions localities including Whitefield, Yemalur, Rainbow Drive Layout, Marathahalli and Sunny Brooks Layout. The report does not pair each locality with an exact time or geometry and is not a machine-readable incident log. Its information is described as coming from SEOC Karnataka and other sources. The manifest retains only bibliographic metadata and a short factual summary. The report states no open data licence; no reuse permission for underlying event data was verified. Source: [Sphere India report](https://www.sphereindia.org.in/sites/default/files/2023-09/_1.%20SitRep%20-%20Floods%20in%20Bangaluru.pdf).
2. **OpenCity “Flooding Locations in Bengaluru Urban.”** The catalog describes common flooding points. No event timestamps are described, so these points are a spatial prior only and are not included as incident labels. Source: [OpenCity Bengaluru dataset catalog](https://data.opencity.in/dataset/?groups=bengaluru&organization=bruhat-bengaluru-mahanagara-palike).
3. **NRSC/NDEM flood inundation layers.** NRSC describes date-stamped satellite inundation layers. NDEM states that its portal content is intended for authorized users; no public, reusable Bengaluru-specific street event layer was verified for this work. Do not import portal data without authorized access and source terms. Source: [NRSC near-real-time mapping note](https://ndem.nrsc.gov.in/documents/downloads/nrt_technical_note.pdf) and [NDEM portal](https://ndem.nrsc.gov.in/).

The Sphere India report is a secondary narrative, not ground-verified street truth. Its location and time uncertainty make it unsuitable for evaluating predicted road depths or training event labels. The repository does not infer coordinates from locality names and does not treat rain totals or city-level narrative as street-level ground truth.

## Verification

From `backend/` run:

```sh
.venv/bin/python -m pytest tests/test_flood_event_data.py -q
```

The tests validate the checked-in manifest, duplicate IDs, WGS84 coordinate bounds and rejection of evaluation eligibility when geometry is absent. They do not establish that a real event data source is complete or licensed for redistribution.
