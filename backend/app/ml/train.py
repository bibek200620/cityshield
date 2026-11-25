"""Generates synthetic training scenarios via the physics baseline, trains
the GNN surrogate, and saves a checkpoint + metrics.json.

Sweeps rainfall_intensity x duration per §6.4 of the build spec, splits
80/20 by scenario (not by node, to avoid leakage), trains with early
stopping, and reports MAE/RMSE against the physics baseline -- the only
"ground truth" available in this prototype.
"""
from __future__ import annotations

import hashlib
import json
import platform
from pathlib import Path

import numpy as np
import torch
import torch_geometric
import torch.nn.functional as F
from torch_geometric.data import Data

from app.gis.drainage_graph import build_drainage_graph
from app.gis.synthetic_ward import SyntheticWardProvider
from app.ml.features import assign_catchments, build_node_matrix, build_static_features
from app.ml.model import FloodGNN
from app.ml.physics_baseline import simulate

RAINFALL_INTENSITIES_MM_HR = [10, 20, 30, 40, 60, 80, 100, 120]
DURATIONS_MIN = [30, 60, 90, 120]

MODEL_CAVEAT = "Surrogate agreement with the simplified physics baseline only; not validated against observed real-world flooding."
EXPERIMENT_SCHEMA_VERSION = "1.0.0"


def generate_scenarios(drainage_graph, catchments, static):
    examples = []
    for intensity in RAINFALL_INTENSITIES_MM_HR:
        for duration in DURATIONS_MIN:
            result = simulate(drainage_graph, catchments, intensity, duration)
            peak = result.peak_depth()
            x = build_node_matrix(static, result.node_local_inflow_peak_m3_s)
            y = np.array([peak[n] for n in static.node_order], dtype=np.float32)
            examples.append({"intensity": intensity, "duration": duration, "x": x, "y": y})
    return examples


def to_pyg(static, example) -> Data:
    edge_index = torch.tensor(static.edge_index, dtype=torch.long)
    edge_weight = torch.tensor(static.edge_capacity_norm, dtype=torch.float32)
    x = torch.tensor(example["x"], dtype=torch.float32)
    y = torch.tensor(example["y"], dtype=torch.float32)
    return Data(x=x, edge_index=edge_index, edge_weight=edge_weight, y=y)


def build_experiment_manifest(
    *, provider, static, examples, train_idx, val_idx, epochs, patience, learning_rate, seed, metrics,
    best_val_loss,
) -> dict:
    """Describe the exact generated dataset, split and simulation-only score."""
    fingerprint = hashlib.sha256()
    fingerprint.update(type(provider).__name__.encode())
    provider_configuration = {
        "seed": getattr(provider, "seed", None),
        "grid_size_cells": getattr(provider, "n", None),
        "grid_resolution_m": getattr(provider, "resolution_m", None),
        "anchor_lat": getattr(provider, "anchor_lat", None),
        "anchor_lng": getattr(provider, "anchor_lng", None),
    }
    fingerprint.update(json.dumps(provider_configuration, sort_keys=True, separators=(",", ":")).encode())
    fingerprint.update(json.dumps(static.node_order, separators=(",", ":")).encode())
    fingerprint.update(np.asarray(static.edge_index, dtype="<i8").tobytes())
    fingerprint.update(np.asarray(static.edge_capacity_norm, dtype="<f4").tobytes())

    scenario_ids = []
    for example in examples:
        scenario_id = f"rain-{example['intensity']}mmhr-{example['duration']}min"
        scenario_ids.append(scenario_id)
        fingerprint.update(scenario_id.encode())
        fingerprint.update(np.asarray(example["x"], dtype="<f4").tobytes())
        fingerprint.update(np.asarray(example["y"], dtype="<f4").tobytes())

    is_synthetic = bool(getattr(provider, "is_synthetic", False))
    return {
        "schema_version": EXPERIMENT_SCHEMA_VERSION,
        "experiment_id": "flood-gnn-physics-surrogate",
        "model": {
            "architecture": "3-layer Graph Convolutional Network (GCNConv), ReLU, dropout, nonnegative depth output",
            "node_features": [
                {"name": "elevation_norm", "units": "normalized [0,1]"},
                {"name": "curve_number_over_100", "units": "unitless"},
                {"name": "slope_pct", "units": "percent"},
                {"name": "flow_accumulation_norm", "units": "normalized [0,1]"},
                {"name": "local_inflow_peak", "units": "m^3/s"},
            ],
            "edge_weight": "normalized estimated drainage capacity",
            "hidden_dimension": 64,
            "dropout_probability": 0.2,
            "target": "peak node depth from simplified physics simulation",
            "target_units": "m",
        },
        "data": {
            "provider_class": type(provider).__name__,
            "provider_configuration": provider_configuration,
            "input_provenance_class": "synthetic" if is_synthetic else "inferred_or_assumed",
            "label_provenance_class": "simulated",
            "label_source": "Simplified SCS-CN runoff and graph drainage physics baseline",
            "scs_cn_initial_abstraction_coefficient": 0.2,
            "scenario_ids": scenario_ids,
            "rainfall_intensity_mm_hr": RAINFALL_INTENSITIES_MM_HR,
            "duration_min": DURATIONS_MIN,
            "scenario_count": len(examples),
            "node_count": len(static.node_order),
            "edge_count": int(np.asarray(static.edge_index).shape[1]),
            "dataset_sha256": fingerprint.hexdigest(),
        },
        "split": {
            "strategy": "random scenario-level holdout; all nodes from a scenario stay in one partition",
            "seed": seed,
            "training_scenarios": [scenario_ids[int(index)] for index in train_idx],
            "validation_scenarios": [scenario_ids[int(index)] for index in val_idx],
            "training_scenario_count": len(train_idx),
            "validation_scenario_count": len(val_idx),
        },
        "training": {
            "epochs_max": epochs,
            "early_stopping_patience": patience,
            "learning_rate": learning_rate,
            "optimizer": "Adam",
            "loss": "mean((1 + 10 * target_depth_m) * (prediction - target)^2)",
            "framework_versions": {
                "python": platform.python_version(),
                "numpy": np.__version__,
                "torch": torch.__version__,
                "torch_geometric": torch_geometric.__version__,
            },
        },
        "metrics": {
            **metrics,
            "best_validation_loss": best_val_loss,
            "metric_kind": "surrogate_agreement",
            "metric_scope": "validation scenarios compared with simplified physics-generated labels",
            "observed_event_validation": "unavailable; no evaluation-grade observed flood events are configured",
        },
        "reproduction": "cd backend && .venv/bin/python -m app.ml.train",
        "limitations": [
            MODEL_CAVEAT,
            "Physics-generated training and validation labels are not observed flood events.",
            "Real-world depth, extent and road-impact accuracy are unavailable.",
        ],
    }


# BUGFIX: plain MSE, averaged uniformly over every node in every scenario,
# let the model collapse to a trivial "predict ~0 everywhere" solution --
# found on real (Bellandur) topology, where only a small fraction of
# node/scenario pairs ever have meaningful depth (most of the ward simply
# doesn't flood at most rainfall levels) and unweighted MSE is already
# nearly minimized by ignoring the few flood-relevant nodes entirely. A
# depth-weighted MSE keeps zero-depth nodes in the loss (correctly
# predicting "clear" still matters) while not letting them drown out the
# gradient signal from the nodes the whole system exists to predict.
def _weighted_mse(pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    weight = 1.0 + 10.0 * target
    return (weight * (pred - target) ** 2).mean()


def train(
    epochs: int = 200, patience: int = 15, lr: float = 1e-3, seed: int = 42, out_dir=None,
    provider=None, drainage_graph=None, catchments=None, static=None,
):
    """Trains against whichever ward is passed in (defaults to the
    synthetic ward, for the standalone `python -m app.ml.train` / seed
    script use case). PILOT_MODE=real must pass its own already-built
    provider/graph/catchments/static (see scenarios/cache.py) -- training
    always against SyntheticWardProvider() regardless of caller was a real
    bug: it silently produced a checkpoint fit to the synthetic ward's
    graph and value distributions, then that same checkpoint got loaded
    for real-ward inference too, via the single shared MODEL_CHECKPOINT_PATH.
    """
    torch.manual_seed(seed)
    if provider is None:
        provider = SyntheticWardProvider()
    if drainage_graph is None:
        drainage_graph = build_drainage_graph(provider)
    if catchments is None:
        catchments = assign_catchments(provider, drainage_graph)
    if static is None:
        static = build_static_features(drainage_graph, catchments)

    examples = generate_scenarios(drainage_graph, catchments, static)
    rng = np.random.RandomState(seed)
    indices = rng.permutation(len(examples))
    split = max(int(0.8 * len(examples)), 1)
    train_idx, val_idx = indices[:split], indices[split:] if split < len(examples) else indices[-1:]

    train_data = [to_pyg(static, examples[i]) for i in train_idx]
    val_data = [to_pyg(static, examples[i]) for i in val_idx]

    model = FloodGNN()
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)

    best_val_loss = float("inf")
    best_state = None
    epochs_since_improve = 0

    for _epoch in range(epochs):
        model.train()
        for data in train_data:
            optimizer.zero_grad()
            pred = model(data.x, data.edge_index, data.edge_weight)
            loss = _weighted_mse(pred, data.y)
            loss.backward()
            optimizer.step()

        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for data in val_data:
                pred = model(data.x, data.edge_index, data.edge_weight)
                val_loss += _weighted_mse(pred, data.y).item()
        val_loss /= max(len(val_data), 1)

        if val_loss < best_val_loss - 1e-6:
            best_val_loss = val_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            epochs_since_improve = 0
        else:
            epochs_since_improve += 1
            if epochs_since_improve >= patience:
                break

    if best_state is not None:
        model.load_state_dict(best_state)

    model.eval()
    abs_errors, sq_errors = [], []
    with torch.no_grad():
        for data in val_data:
            pred = model(data.x, data.edge_index, data.edge_weight)
            err = (pred - data.y).numpy()
            abs_errors.extend(np.abs(err).tolist())
            sq_errors.extend((err ** 2).tolist())
    mae = float(np.mean(abs_errors)) if abs_errors else 0.0
    rmse = float(np.sqrt(np.mean(sq_errors))) if sq_errors else 0.0

    out_dir = Path(out_dir or Path(__file__).parent / "checkpoints")
    out_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = out_dir / "gnn_surrogate.pt"
    torch.save(model.state_dict(), checkpoint_path)

    metrics = {
        "mae_m": mae,
        "rmse_m": rmse,
        "n_train_scenarios": len(train_data),
        "n_val_scenarios": len(val_data),
        "best_val_loss": best_val_loss,
        "caveat": MODEL_CAVEAT,
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))
    experiment = build_experiment_manifest(
        provider=provider,
        static=static,
        examples=examples,
        train_idx=train_idx,
        val_idx=val_idx,
        epochs=epochs,
        patience=patience,
        learning_rate=lr,
        seed=seed,
        metrics={"mae_m": mae, "rmse_m": rmse},
        best_val_loss=best_val_loss,
    )
    (out_dir / "experiment.json").write_text(json.dumps(experiment, indent=2, sort_keys=True) + "\n")

    return model, metrics


if __name__ == "__main__":
    _, result_metrics = train()
    print(json.dumps(result_metrics, indent=2))
