# NOAA GHCNh airport station baseline

This is a reproducible, offline **research evaluation** using one NOAA GHCNh station near Bengaluru. It does not provide a live feed, a Bengaluru-wide forecast, a heatwave event classifier, a health advisory, or evidence of neighborhood-level accuracy. The current application forecast/advisory remains unavailable.

## Source and provenance

- Dataset: [NOAA NCEI Global Historical Climatology Network hourly (GHCNh)](https://www.ncei.noaa.gov/products/global-historical-climatology-network-hourly), [dataset DOI](https://doi.org/10.25921/jp3d-3v19).
- Station: `INM00043296`, BANGALORE/HINDUSTAN AIRPORT, 12.9500° N, 77.6333° E, 888 m. The evaluation uses only this location. The Bengaluru international airport and Bangalore city station are not pooled into this experiment.
- Archived file: [`GHCNh_INM00043296_por.psv`](https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/access/by-station/GHCNh_INM00043296_por.psv), 183,179 source rows in the retrieved copy; SHA-256 `f54169d47017e2be68df7f1c461503e8cadec97f6afc13dfc2e59161f8b15a6c` (retrieved 2026-11-26; upstream archive is maintained and may change).
- The source file spans 1954-01-01 through 2026-11-21, but the accepted paired temperature/RH observations span 2005-05-07 through 2026-03-26. The series is discontinuous, with multi-year gaps. Raw extent must not be mistaken for continuous coverage.
- The experiment is classified as observed station data. The relative-humidity field is derived from temperature/dew-point observations; it is not represented as a separate neighborhood humidity sensor. The exact source and QC filters are in `backend/app/heat/station_observations.py`.
- Retain NOAA/NCEI attribution and the dataset DOI. This repository does not assert a separate license beyond the terms stated by the data provider; review provider terms before redistribution.

## Target, quality filters, and split

The target is **the maximum quality-accepted station temperature report on the next eligible local calendar date, in °C**, with a one-local-day horizon. Since dates may have fewer than 24 reports, this report maximum is not asserted to be a complete official daily Tmax. It is temperature regression, not heatwave-event prediction. Predictors summarize the preceding eligible local date: maximum/mean/minimum accepted report temperature, mean/max/min derived RH, and the target date's day-of-year sine/cosine.

The archive is parsed as one fixed station and source. A temperature report is retained only when source code is `223`, source-station ID is `ICAO-VOBG`, and temperature QC is `1`. A paired RH value must also have source code `223`, source-station ID `ICAO-VOBG`, derived measurement code `D`, and no `f` or `o` quality flag. Timestamps are interpreted as UTC and converted to `Asia/Kolkata` before daily grouping. A date needs at least 8 paired accepted reports spanning at least 18 hours. Both previous and target dates must pass; missing dates are not filled or bridged.

For the retrieved archive and those filters, the run produced 4,497 eligible local dates and 4,332 adjacent-day examples. The target-date split is chronological: 3,250 training examples from 2005-05-19 through 2022-12-31, and 997 held-out examples from 2023-01-01 through 2025-12-31. Training data include long gaps; no shuffled or neighboring-day random split is used. The partial 2026 records are excluded from both train and test.

All methods were evaluated against the same 997 held-out station targets:

| Method | MAE (°C) | RMSE (°C) | Bias (°C) | Held-out rows |
| --- | ---: | ---: | ---: | ---: |
| XGBoost | 1.1698 | 1.4790 | -0.5587 | 997 |
| Previous-day Tmax persistence | 1.0502 | 1.4510 | 0.0000 | 997 |
| Training-only day-of-year climatology, circular ±15 days | 1.6565 | 2.0642 | -0.7621 | 997 |

On this split, XGBoost did **not** outperform persistence. These scores describe only this station and period; they are not citywide, neighborhood, human heat-stress, or operational forecast skill. No supported heatwave warning is inferred from them.

## Reproduce

With backend dependencies installed, retrieve the same archive version and verify the content hash:

```sh
mkdir -p backend/data/heat/ghcnh-hal
curl -L \
  https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/access/by-station/GHCNh_INM00043296_por.psv \
  -o backend/data/heat/ghcnh-hal/GHCNh_INM00043296_por.psv
echo 'f54169d47017e2be68df7f1c461503e8cadec97f6afc13dfc2e59161f8b15a6c  backend/data/heat/ghcnh-hal/GHCNh_INM00043296_por.psv' | shasum -a 256 -c -
cd backend
.venv/bin/python -m app.heat.train_station_observations \
  --input data/heat/ghcnh-hal/GHCNh_INM00043296_por.psv \
  --output-dir data/heat/ghcnh-hal/model
```

The parser validates station identity, coordinates, timestamp uniqueness/order, ranges, source and QC fields, then reports accepted/excluded counts and the raw-file SHA-256. The command writes `evaluation.json` and a loadable XGBoost model under the ignored local data directory. Neither the large raw archive nor generated model is checked in. Because NCEI maintains the archive, a later download may have a different hash, row count and scores; the report records the actual input fingerprint.

The model uses XGBoost 3.1.2 with 250 trees, depth 3, learning rate 0.04, subsample 0.8, column sample 0.9, L2 1.0, seed 42, one worker and histogram tree method. Persistence uses prior-day observed Tmax. Climatology uses only training targets in a circular day-of-year ±15-day window. All results and dates are computed by the command; the metrics above are the run from the archived hash listed here.

## Limitations and product boundary

- One airport station cannot represent Greater Bengaluru's spatial temperature or humidity variation.
- Observation availability is uneven, and substantial multi-year gaps reduce effective training history. Same-station temporal holdout is not an independent-site test.
- Derived RH is sourced from the station's temperature/dew-point observations and may inherit their measurement and QC limitations.
- The model underperformed persistence on the stated holdout. It is retained as an evaluated research baseline, not a forecast service.
- Landsat LST remains a separate remotely sensed surface-temperature workflow. It is not used as air temperature or as this model's target.
- Existing tests continue to assert that Landsat-only data do not produce an air-temperature forecast, and the product's heatwave forecast/advisory remains unavailable.
