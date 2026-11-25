# IFI-Impacts v3 Bengaluru Urban subset

## Attribution and license

This derived CSV is based on the India Flood Inventory-Impacts (IFI-Impacts) v3 dataset by HydroSense Lab, IIT Delhi, with events attributed to the India Meteorological Department (IMD).

> Saharia, M. et al. *India Flood Inventory-Impacts (IFI-Impacts) [1967–2023]: A multi-source national geospatial database to facilitate comprehensive flood research*. Version 3, Zenodo record [10.5281/zenodo.11275211](https://doi.org/10.5281/zenodo.11275211), 2024. Dataset license: [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

The source file used was `India_Flood_Inventory_v3.csv`, MD5 `fea75a9ff9eba8fb328eaddfacd21d67`. The full source file is not redistributed here. The checked-in CSV is a filtered and normalized 53-row subset; the transformation is implemented in `backend/app/ml/ifi_inventory.py`.

## Transformation

- Keep rows only when the source `Districts` field contains the exact district name `Bengaluru Urban`.
- Preserve the source event identifier, reported cause and complete district list.
- Normalize source dates from `DD-MM-YYYY 00:00` to ISO dates. The source time placeholder is not an observed clock time; date precision is explicitly retained.
- Do not infer latitude/longitude or split events that name multiple districts.
- Add source ID, DOI, license, source file checksum and explicit quality flags.
- Mark every record `evaluation_eligible=false`. The inventory does not provide a localized flood footprint/depth or event-matched rainfall for the Bengaluru Urban records.

The v3 record is used because its published file checksum matches the supplied source and its Zenodo metadata declares CC BY 4.0. Zenodo's later v4 record reports different license metadata; it is not the record used for this subset.
