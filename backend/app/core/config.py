"""Central application settings, read from environment / .env.

Every tunable referenced by the build spec lives here so nothing is a
magic number buried in a module.
"""
from __future__ import annotations

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Pilot ward mode
    PILOT_MODE: str = "synthetic"  # "synthetic" | "real"
    REAL_WARD_BBOX: str = ""  # "min_lon,min_lat,max_lon,max_lat"

    # Database
    DB_MODE: str = "sqlite"  # "sqlite" | "postgis"
    DATABASE_URL: str = "sqlite:///./flood_nowcast.db"
    POSTGIS_URL: str = "postgresql+psycopg2://flood:flood@localhost:5432/flood_nowcast"

    # Synthetic ward generation
    SYNTHETIC_SEED: int = 42
    GRID_SIZE_CELLS: int = 100
    GRID_RESOLUTION_M: int = 20
    # Synthetic reference coordinates are placed inside the Bellandur pilot
    # bbox only for map co-location; the generated network is not observed data.
    ANCHOR_LAT: float = 12.928
    ANCHOR_LNG: float = 77.668

    # Drainage network assumptions
    # ASSUMPTION: pipe diameters are not measured for any real ward; they are
    # plausible defaults for residential vs. arterial storm drains in a
    # planned layout, configurable per §6.3 of the spec.
    DRAIN_DIAMETER_RESIDENTIAL_MM: int = 450
    DRAIN_DIAMETER_ARTERIAL_MM: int = 900
    # ASSUMPTION: the trunk interceptor drain running along the depression
    # itself (between consecutive major junctions) is larger-bore than a
    # generic arterial road drain -- realistic for a ward's primary
    # stormwater trunk line -- and, verified empirically, is what actually
    # determines how much water reaches (and ponds at) the ward's true
    # outlet; deepening the channel or upzoning nearby land use alone did
    # not move the outlet's predicted depth much once the trunk itself was
    # the delivery bottleneck.
    DRAIN_DIAMETER_TRUNK_MM: int = 1400
    MANNINGS_N_CONCRETE: float = 0.013

    # Hydrology (SCS-CN)
    IA_COEFFICIENT: float = 0.2

    # Road / flood state thresholds (metres of predicted depth)
    DEPTH_THRESHOLD_AT_RISK_M: float = 0.15
    DEPTH_THRESHOLD_FLOODED_M: float = 0.30

    # ML
    MODEL_CHECKPOINT_PATH: str = "./app/ml/checkpoints/gnn_surrogate.pt"
    MC_DROPOUT_SAMPLES: int = 20

    # Authorized observation bundles and separately produced drainage runs.
    STORM_EVENT_DIR: str = "./data/storm_events"

    # Heat model uses only a locally supplied, single Landsat C2 L2 scene.
    HEAT_SCENE_DIR: str = "./data/heat/landsat"
    HEAT_MODEL_PATH: str = "./data/heat/model/heat_lst_model.json"
    HEAT_AOI_BBOX: str = "77.655,12.915,77.680,12.940"

    # API
    CORS_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173"
    TOMTOM_API_KEY: SecretStr | None = None
    METEOBLUE_API_KEY: SecretStr | None = None
    GOOGLE_MAPS_API_KEY: SecretStr | None = None
    GEMINI_API_KEY: SecretStr | None = None
    GEMINI_MODEL: str = "gemini-2.5-flash-lite"
    CX_CONVERSATION_ENABLED: bool = True
    PLACE_SEARCH_URL: str = "https://nominatim.openstreetmap.org/search"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
