# Contributing to CityShield

CityShield is a research MVP for Bengaluru flood screening, surface heat and mobility analysis. Contributions to scientific validity, accessibility, software reliability and documentation are welcome.

## Getting started

1. Search [existing issues](https://github.com/bibek200620/cityshield/issues) before opening one.
2. Discuss substantial changes in an issue before implementing them.
3. Fork and clone the repository, then create a branch from current main (for example, `git switch -c fix/route-validation`).
4. Follow the [local setup](README.md#local-setup) in the README. Python 3.11 and Node.js 20 are the CI versions; use synthetic pilot mode and SQLite for local tests.
5. Make focused commits and open a pull request against main. Do not commit directly to main.

## Checks

From the repository root:

```sh
cd backend
python -m pytest --cov=app --cov-report=term-missing
cd ../frontend
npm ci
npm run lint
npm run build
```

Activate the backend virtual environment first. Add regression tests for behavior changes; mock external providers in automated tests rather than relying on live APIs. Follow existing Python and TypeScript conventions. Keep changes scoped and document API or configuration changes.

## Scientific and geospatial standards

- Distinguish synthetic inputs, simulations, reanalysis, satellite estimates and independent observations.
- Document source URLs, licenses, retrieval dates, units, CRS, geographic coverage and assumptions.
- Preserve missing/unavailable states; do not fabricate observations or extrapolate beyond supported coverage.
- Prevent leakage across storm groups, acquisition dates and spatial holdouts as appropriate. Report baseline comparisons and limitations.
- Do not describe runoff screening as calibrated depth, land-surface temperature as air temperature, or spatial overlap as compound probability.
- Preserve attribution and update [data provenance](docs/DATA_SOURCES.md) and [evaluation](docs/BENGALURU_EVALUATION.md) when relevant.
- Never commit API keys, private locations, restricted datasets or large local training artifacts.

## Pull requests

Explain the problem, solution, tests actually run, relevant screenshots for UI changes, and scientific or privacy implications. Link the issue and update [CHANGELOG.md](CHANGELOG.md) for user-visible changes. Review feedback respectfully. See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

By contributing, ensure you have rights to submit the material under the repository's [license](LICENSE); retain upstream notices.
