import numpy as np
from fastapi.testclient import TestClient
from rasterio.transform import from_bounds

from app.api import routes_heat
from app.core.config import settings
from app.heat.landsat import prepare_feature_stack
from app.main import app


def test_heat_api_reports_missing_scene_and_unavailable_model(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "HEAT_SCENE_DIR", str(tmp_path / "missing-scene"))
    monkeypatch.setattr(settings, "HEAT_MODEL_PATH", str(tmp_path / "missing-model.json"))
    scene_stack = prepare_feature_stack(
        {
            "SR_B2": np.full((2, 2), 10000, dtype=np.uint16),
            "SR_B3": np.full((2, 2), 12000, dtype=np.uint16),
            "SR_B4": np.full((2, 2), 11000, dtype=np.uint16),
            "SR_B5": np.full((2, 2), 20000, dtype=np.uint16),
            "SR_B6": np.full((2, 2), 14000, dtype=np.uint16),
            "SR_B7": np.full((2, 2), 13000, dtype=np.uint16),
            "ST_B10": np.full((2, 2), 45000, dtype=np.uint16),
            "ST_EMIS": np.full((2, 2), 9500, dtype=np.uint16),
        },
        np.zeros((2, 2), dtype=np.uint16),
        scene_id="LC08_L2SP_144051_20250414_20250424_02_T1",
        acquisition_date="20250414",
        crs="EPSG:32643",
        transform=from_bounds(0, 0, 60, 60, 2, 2),
    )

    with TestClient(app) as client:
        missing = client.get("/api/heat")
        assert missing.status_code == 200
        assert missing.json()["status"] == "unavailable"
        assert "Landsat" in missing.json()["message"]
        assert missing.json()["cells"] == []
        assert "validated human heatwave forecast" in missing.json()["limitations"][1]

        scene_dir = tmp_path / "scene"
        scene_dir.mkdir()
        (scene_dir / "LC08_L2SP_144051_20250414_20250424_02_T1_SR_B2.TIF").touch()
        monkeypatch.setattr(settings, "HEAT_SCENE_DIR", str(scene_dir))
        monkeypatch.setattr(routes_heat, "load_landsat_scene", lambda *_: scene_stack)
        no_model = client.get("/api/heat")
        assert no_model.status_code == 200
        assert no_model.json()["status"] == "unavailable"
        assert no_model.json()["scene_id"] == scene_stack.scene_id
        assert no_model.json()["explanation_status"] == "unavailable"
