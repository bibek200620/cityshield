from rasterio.warp import transform

from app.geo.exposure import COMMON_GRID_RESOLUTION_M, combine_exposure_cells


def _point_at_grid_center(i: int, j: int) -> tuple[float, float]:
    x = i * COMMON_GRID_RESOLUTION_M + COMMON_GRID_RESOLUTION_M / 2
    y = j * COMMON_GRID_RESOLUTION_M + COMMON_GRID_RESOLUTION_M / 2
    lng, lat = transform("EPSG:32643", "EPSG:4326", [x], [y])
    return lng[0], lat[0]


def test_common_grid_marks_both_only_when_independent_thresholds_are_met():
    lng, lat = _point_at_grid_center(12466, 47633)
    flood = [{"lng": lng, "lat": lat, "depth_m_mean": 0.16}]
    heat = [{"lng": lng, "lat": lat, "temperature_c": 35.0, "hotspot": True}]

    combined = combine_exposure_cells(flood, heat)
    assert len(combined) == 1
    cell = combined[0]
    assert cell["grid_id"] == "EPSG:32643:30:12466:47633"
    assert cell["both_elevated"] is True
    assert cell["flood_elevated"] is True
    assert cell["heat_elevated"] is True

    cool = combine_exposure_cells(flood, [{**heat[0], "hotspot": False}])
    assert cool[0]["both_elevated"] is False
    low_flood = combine_exposure_cells([{**flood[0], "depth_m_mean": 0.149}], heat)
    assert low_flood[0]["both_elevated"] is False


def test_missing_hazard_is_not_treated_as_elevated():
    lng, lat = _point_at_grid_center(12466, 47633)
    flood_only = combine_exposure_cells([{"lng": lng, "lat": lat, "depth_m_mean": 0.4}], [])
    heat_only = combine_exposure_cells([], [{"lng": lng, "lat": lat, "temperature_c": 36, "hotspot": True}])
    assert flood_only[0]["both_elevated"] is False
    assert flood_only[0]["heat_elevated"] is None
    assert heat_only[0]["both_elevated"] is False
    assert heat_only[0]["flood_elevated"] is None


def test_bellandur_landsat_boundary_pixels_keep_distinct_grid_cells():
    lngs, lats = transform("EPSG:32643", "EPSG:4326", [788100, 788130], [1432020, 1432020])
    heat = [
        {"lng": lng, "lat": lat, "temperature_c": 35.0, "hotspot": True}
        for lng, lat in zip(lngs, lats)
    ]
    cells = combine_exposure_cells([], heat)
    assert [cell["grid_id"] for cell in cells] == [
        "EPSG:32643:30:26270:47734",
        "EPSG:32643:30:26271:47734",
    ]
