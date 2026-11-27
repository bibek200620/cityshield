# Issue #5 — online data search and supplied-paper benchmark

**Audit date:** 2026-11-26

**Purpose:** Find reusable Bengaluru observations for CityShield flood-model evaluation. This note records source evidence, not a CityShield performance report.

## Finding

No publicly inspectable dataset found in this search meets the minimum contract for evaluating CityShield against Bengaluru floods: event-separated observed outcomes with usable timestamps and geometry, event-matched rainfall, and a defensible mapping to the model's evaluated network. The most relevant result is the user-supplied Frontiers study and supplement. They provide real published observations and a meaningful research benchmark, but not the raw time series or sensor coordinates needed to run a CityShield backtest.

## Online sources checked

| Source | What it contains | Limitation for CityShield evaluation |
| --- | --- | --- |
| [Davis et al. (2022), Bengaluru WRF–PCSWMM study](https://doi.org/10.3389/feart.2022.883842) and [supplement](https://doi.org/10.3389/feart.2022.883842.s001) | Four 2020–2021 heavy-rain events; published 15-minute sensor-data methodology; tables of selected water-level observations and the authors' own model comparisons. The article is CC BY 4.0. | Article states high-resolution KSNDMC observations are request-only and local-government inputs are classified. Supplement has summary rows, not raw event rainfall/water-level series or sensor coordinates. Its output metrics belong to the paper's WRF/PCSWMM system, not CityShield. |
| [KSNDMC/Bengaluru Urban annual rainfall catalog](https://data.opencity.in/dataset/?_organization_limit=0&license_id=other-pd&organization=ksndmc&q=UrbanMorph&sort=views_recent+desc) | Catalog describes annual Bengaluru rainfall at Taluk/Hobli scale for 2017–2023; an indexed 2022 PDF includes annual and seasonal totals. | Aggregates are not storm hydrographs and include no observed flood outcomes. Catalog page access was blocked during this audit; the indexed 2022 PDF is not a substitute for station-level 15-minute event data. |
| [NRSC/Bhuvan flood portal](https://bhuvan-app1.nrsc.gov.in/disaster/usrtasks/flood/flood.php?uname=empty) | Portal lists a Bengaluru “Vulnerable Areas” experimental layer; its displayed recent Karnataka event layer is for Belgaum, not Bengaluru. | Bengaluru vulnerability areas are static spatial priors, not time-stamped flood outcomes. Portal notes say vulnerable-area output is experimental. The inspected portal did not expose a public Bengaluru event series. |
| [NRSC aggregated flood-layer technical document](https://ndem.nrsc.gov.in/documents/downloads/aggregated_flood_techdoc.pdf) | Satellite-derived annual and aggregated inundation extents from 2003–2020, intended for broad planning use. | Official notes say satellite coverage may miss peak flooding and rapid flash floods; use is limited to broad scale. Aggregation removes event timing needed for storm holdout. |
| [Bharatlas copy attributed to NDEM](https://bharatlas.com/view/ndem_floods_1998_2022) | A downloadable 122,388-feature Parquet file, described as NDEM inundation polygons for 1998–2022; page states non-commercial use. Retrieved file SHA-256: `51cb78cfde25aa7d9b9adcbd224fe6654aa5f9e30c04fb3fbc89dd98bddf5934`. | The file contains only `id`, `gridcode`, geometry and bounds—no event date, year, state, district or sensor fields. A bounding-box check found 0 feature bounds inside the Bengaluru extent published by the Frontiers study (77.42–77.75°E, 12.75–13.17°N). Not usable for Bengaluru evaluation. The public catalog's 1998–2022 range also differs from the inspected NRSC technical document's 2003–2020 product description; no resolution of that catalog/version discrepancy was found. |

The NRSC technical document also cautions that satellite coverage may not coincide with peak flood and rapid flash floods may not be captured. Accordingly, even a nearby satellite water polygon would need event/time review before being treated as ground truth.

## What the supplied Frontiers research gives us

The paper studies the BBMP city area and describes a calibrated PCSWMM model using BBMP drainage data, 10 m NRSC DEM, BDA land cover, rain gauges and water-level sensors. It reports 15-minute observations and four selected 2020–2021 events. Its Supplementary Table S3 reports these five observed sensor summaries for 20–21 October 2020:

| Valley | WLS ID | Published location text | Local timestamp | Flow depth (m) | Drain depth (m) | Flow/drain ratio (calculated) |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| KC | 100003 | Bangalore_Bommanahalli_Hulimavu Lake-Inlet | 2020-10-20 20:30 | 0.79 | 1.00 | 79.0% |
| HB | 100018 | Bangalore_East_Kanakanagar | 2020-10-20 23:45 | 1.57 | 2.00 | 78.5% |
| HB | 100026 | Bangalore_East_Ananda Nagara (HMT Layout) | 2020-10-21 00:30 | 1.45 | 1.80 | 80.6% |
| VV | 100021 | Bangalore_West_Vrishabhavathi Nagar | 2020-10-21 00:45 | 2.332 | 1.05 | 222.1% |
| VV | 100034 | Bangalore_RR Nagar_Nayandahalli Junction | 2020-10-21 01:30 | 2.55 | 2.10 | 121.4% |

Times above are transcribed from the paper's local event dates/times; the table does not provide coordinates. Ratios in the last column are recalculated as `flow depth / drain depth`; the source reports these as selected critical sensors above a 75% threshold.

### Source discrepancy requiring resolution

Supplementary Table S6 reports the observed **maximum** at WLS `100021` as `0.9 m` at `2020-10-21 00:45`, whereas Table S3 reports `2.332 m` at the same sensor and timestamp. These figures cannot both describe the same maximum. The discrepancy is preserved as unresolved; neither value is selected as truth for scoring. The user-supplied `bengaluru_authorized_flood_rainfall.csv` has two rows for one event, lacks WLS IDs/coordinates/peak times, repeats one 124.5 mm/24-hour Kengeri maximum, and contains drain-depth-exceedance percentages rather than measured street-flood outcomes. It cannot safely be joined to Table S3 rows by row order or locality name.

The supplement's Table S5 lists the highest 24-hour gauge rainfall per event: 139 mm (8–9 Sep 2020), 124.5 mm (20–21 Oct 2020), 91 mm (11–12 Oct 2021), and 144.5 mm (4–5 Nov 2021). These are event-level maxima, not spatially matched 15-minute rainfall series. Table S2 reports the paper's own hydrologic model calibration/validation scores (R² 0.833/0.819, RMSE 0.18/0.102 m, NSE 0.644/0.54); these are the authors' PCSWMM results and **must not be presented as CityShield results**.

The two user-supplied Vrishabhavathi Valley CSV rows can be enriched using the published table without relying on row order: their reported 122% and 21% drain-depth excess values match the rounded ratios for WLS 100021 (`2.332 m` / `1.05 m`, excess 122.095%) and WLS 100034 (`2.55 m` / `2.1 m`, excess 21.429%), respectively. The resulting five-row cited summary is [`frontiers_2020_sensor_summary.csv`](data/flood_events/frontiers_2020_sensor_summary.csv); the two original row IDs and arithmetic match basis are retained. This enriches the source records but does not make them evaluation-eligible.

## Why this is not a CityShield backtest or training set

- It is one storm for the reported sensor snapshots, with no multi-storm sensor time series or negative/control observations. The sensor list was selected as critical; using it to train or score a general flood model would introduce selection bias.
- No sensor coordinates are given, so observations cannot be matched to CityShield nodes or roads without unsupported geocoding.
- CityShield's configured default flood geometry is the synthetic Bellandur grid (`PILOT_MODE=synthetic`); the checked-in configuration has no WLS sensor IDs or mapped BBMP drain network. Its standard rainfall scenario accepts a uniform intensity and duration, not the study's spatially varying, 15-minute station forcing.
- The reported gauge maximum is not enough to reconstruct the event hyetograph. Replacing it with uniform 124.5 mm/24 h rainfall would create an invented temporal/spatial profile.
- The source's own published model metrics validate that study's PCSWMM workflow only. They cannot transfer across model, drainage geometry, sensor locations or rainfall inputs.

Therefore no CityShield flood training or observed-event metric was computed; `/api/backtest/{event_id}` should remain unavailable (HTTP 501). The paper summaries are useful as attributed literature context and as a specification for the data contract, but not as labels for CityShield.

## Smallest data request that would unblock a real test

Obtain an authorized, reusable export from KSNDMC/BBMP or the study authors with: (1) at least two independent storms, preferably the 2020–2021 events above; (2) gauge IDs/coordinates and 15-minute rainfall values with timezone/QC; (3) WLS IDs/coordinates, 15-minute levels, drain invert/reference depth and sensor QC; (4) event IDs and source/reuse terms; and (5) the matching CityShield drainage-network geometry or verified observation-to-node mapping. Resolve the WLS `100021` published depth discrepancy before using that series. Then hold out entire storms and report the model against the observed sensors, separately from physics-baseline/surrogate agreement.
