# ERA5-Land next-day temperature research baseline

This is an offline research workflow for one Bengaluru ERA5-Land grid cell. It is not connected to the map API and does not generate a live forecast, official heatwave warning, heat-stress advisory, or neighborhood-level observation. The existing heat API continues to report that a validated human heatwave forecast is unavailable.

## Data and provenance

- Provider: [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api), explicit `models=era5_land`.
- Underlying dataset: ERA5-Land reanalysis, sourced through Open-Meteo. Open-Meteo describes this as reanalysis that combines observations with model estimates; its output is **model-derived**, not an independent station observation.
- Requested location: 12.9716°N, 77.5946°E, Bengaluru.
- Returned grid cell for this run: 13.000000°N, 77.600006°E, elevation 910 m. The returned cell is not the exact requested coordinate.
- Spatial resolution: 0.1° (about 11 km, per provider documentation); one grid cell cannot resolve street or ward variation.
- Variables: hourly 2 m air temperature (°C) and relative humidity (%), local timestamps in `Asia/Kolkata`, land-preferring cell selection.
- Retrieved archive: 1999-01-01 through 2025-12-31. 1999 supplies prior-day feature warm-up only; target dates from 2000 onward are used for model fitting/evaluation.
- License: API data are offered under [CC BY 4.0](https://open-meteo.com/en/license). Attribute as “Weather data by Open-Meteo.com, ERA5-Land reanalysis” and indicate transformations. The API service and dataset terms are distinct; use the free endpoint only within its current usage terms.

The downloaded yearly response files, trained model and detailed `evaluation.json` are written under `backend/data/heat/reanalysis/`, which is ignored by Git. Each cached annual response includes the exact request parameters and retrieval timestamp. The evaluation report records the returned grid, units, data-quality counts, dataset SHA-256, split, feature order, seed, XGBoost version/hyperparameters, and computed scores.

## Target and method

The target is **the next local calendar day's ERA5-Land daily maximum 2 m air temperature in °C**, a one-day horizon. This is a temperature-regression baseline, not an event detector: it does not define or predict official IMD heatwave episodes.

Each prediction uses the previous local day's hourly series summarized as maximum, mean and minimum temperature and mean, maximum and minimum relative humidity, plus sine/cosine encodings of the target day of year. Both days must have 24 valid hourly values; gaps are not filled or bridged. Incomplete days are excluded and counted in the report.

Training target dates are 2000-01-01 through 2020-12-31. The chronological test is 2021-01-01 through 2025-12-31. No test-period target or feature is used to fit either baseline. Three methods use the same held-out target dates:

1. XGBoost regression (`xgboost==3.1.2`): 300 trees, depth 4, learning rate 0.04, subsample 0.8, column sample 0.9, L2 regularization 1.0, seed 42, one worker, histogram tree method.
2. Persistence: previous local day's Tmax.
3. Seasonal climatology: mean training Tmax within a circular ±15-day day-of-year window, derived from training dates only.

## Reproduce

From a checkout with the backend dependencies installed:

```sh
cd backend
.venv/bin/python -m app.heat.train_reanalysis --download --train
```

The downloader resumes only from cached files with a matching ERA5-Land query manifest. To retrain from the validated local archive without requesting it again:

```sh
cd backend
.venv/bin/python -m app.heat.train_reanalysis --train
```

Optional `--start-year` and `--end-year` arguments select download years; the evaluation requires coverage for training targets 2000–2020 and test targets 2021–2025, with 1999 retained for warm-up. The default output directory is `backend/data/heat/reanalysis/`; a different `--output-dir` may be supplied. Do not commit raw API data or model artifacts.

## Result from the current retrieved archive

The run downloaded 27 annual files and validated 9,862 complete local days, with zero excluded incomplete days. Training used 7,671 target dates; the 2021–2025 held-out period used 1,826 dates. Metrics computed from the same ERA5-Land held-out target rows were:

| Method | MAE (°C) | RMSE (°C) | Bias (°C) | Test rows |
|---|---:|---:|---:|---:|
| XGBoost | 0.7786 | 1.0896 | 0.1039 | 1,826 |
| Previous-day Tmax persistence | 0.8330 | 1.1827 | -0.0020 | 1,826 |
| Training-only seasonal climatology | 1.2744 | 1.7415 | 0.2686 | 1,826 |

These scores summarize agreement with held-out **reanalysis values only**. They do not measure agreement with independent IMD/station observations, establish performance in real-world weather, or validate heatwave prediction. The issue acceptance criterion for observed-data evaluation is still unmet.

## Limitations

- The input and target are reanalysis/model-derived, not station-observed ground truth. The holdout is temporal separation within one reanalysis source, so systematic source errors can appear on both sides of the split.
- One ~11 km grid cell is much coarser than Bengaluru neighborhoods; it cannot support street-level temperature claims.
- Daily Tmax regression is not heatwave classification and uses no official event labels or threshold. It is not shown in the product as a current or future forecast.
- No independent observed-data comparison, heat-stress measure, humidity threshold, calibrated uncertainty, air-quality input, or life-safety evaluation is included.
- The results are tied to this retrieved source dataset and configuration. `evaluation.json` records a content fingerprint; rerunning after provider revisions may yield a different fingerprint and metrics.
