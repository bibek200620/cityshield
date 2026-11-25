# Model cards

The versioned inventory is [`model-cards/v1.0.0.json`](model-cards/v1.0.0.json). It records five distinct workflows: the simplified flood physics baseline, its FloodGNN surrogate, Bellandur single-scene Landsat LST, the Bengaluru multi-date Landsat LST study, and the offline ERA5-Land next-day Tmax experiment. A reproducible FloodGNN run record is stored alongside the cards.

The reported values describe different targets and must not be compared as one score:

- FloodGNN MAE/RMSE are agreement with synthetic scenarios labelled by the simplified physics model. They are not observed flood accuracy.
- Landsat metrics compare estimated land-surface temperature with held-out Landsat surface-temperature products. They are not air-temperature, heat-stress or forecast validation.
- ERA5-Land scores compare with held-out ERA5-Land reanalysis targets from the same source. They are not independent station observations or an operational forecast.
- Observed flood-event validation and independent station temperature validation are explicitly unavailable.

Reproduction commands and input requirements are recorded per card. Landsat scenes, ERA5-Land archives, checkpoints and derived study outputs are local and ignored by Git; a clean checkout must acquire the documented inputs under their applicable terms. See [`HEAT_WORKFLOW.md`](HEAT_WORKFLOW.md), [`BENGALURU_EVALUATION.md`](BENGALURU_EVALUATION.md), [`HEATWAVE_REANALYSIS.md`](HEATWAVE_REANALYSIS.md), [`DATA_SOURCES.md`](DATA_SOURCES.md), and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for operational details and attribution.

Validate the checked-in cards and their cross-references with:

```sh
cd backend
.venv/bin/python -m pytest tests/test_model_cards.py tests/test_ml_model.py tests/test_city_study.py -q
```
