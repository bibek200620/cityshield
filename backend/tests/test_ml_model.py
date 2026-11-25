import numpy as np
import torch
from types import SimpleNamespace

from app.ml.model import FloodGNN
from app.ml.train import build_experiment_manifest


def _tiny_batch():
    torch.manual_seed(0)
    x = torch.rand((6, 5))
    edge_index = torch.tensor([[0, 1, 2, 3, 4], [1, 2, 3, 4, 5]], dtype=torch.long)
    edge_weight = torch.rand(5)
    y = torch.rand(6)
    return x, edge_index, edge_weight, y


def test_trains_without_nan_loss():
    model = FloodGNN()
    x, edge_index, edge_weight, y = _tiny_batch()
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss = None
    for _ in range(10):
        optimizer.zero_grad()
        pred = model(x, edge_index, edge_weight)
        loss = torch.nn.functional.mse_loss(pred, y)
        loss.backward()
        optimizer.step()
    assert loss is not None
    assert not torch.isnan(loss).item()


def test_mc_dropout_uncertainty_is_nonzero():
    model = FloodGNN()
    x, edge_index, edge_weight, _ = _tiny_batch()
    model.train()  # dropout active, matching ml/infer.py's MC-dropout approach
    preds = []
    with torch.no_grad():
        for _ in range(20):
            preds.append(model(x, edge_index, edge_weight).numpy())
    std = np.stack(preds, axis=0).std(axis=0)
    assert (std > 0).any()


def test_flood_experiment_manifest_records_reproducible_simulation_split():
    provider = SimpleNamespace(is_synthetic=True)
    static = SimpleNamespace(
        node_order=["n1", "n2"],
        edge_index=np.array([[0], [1]], dtype=np.int64),
        edge_capacity_norm=np.array([0.5], dtype=np.float32),
    )
    examples = [
        {"intensity": 10, "duration": 30, "x": np.ones((2, 5)), "y": np.array([0.0, 0.2])},
        {"intensity": 20, "duration": 30, "x": np.zeros((2, 5)), "y": np.array([0.1, 0.0])},
    ]
    args = dict(
        provider=provider,
        static=static,
        examples=examples,
        train_idx=np.array([0]),
        val_idx=np.array([1]),
        epochs=20,
        patience=5,
        learning_rate=1e-3,
        seed=42,
        metrics={"mae_m": 0.1, "rmse_m": 0.15},
        best_val_loss=0.02,
    )

    first = build_experiment_manifest(**args)
    second = build_experiment_manifest(**args)

    assert first["schema_version"] == "1.0.0"
    assert first["data"]["dataset_sha256"] == second["data"]["dataset_sha256"]
    assert first["split"]["training_scenarios"] == ["rain-10mmhr-30min"]
    assert first["split"]["validation_scenarios"] == ["rain-20mmhr-30min"]
    assert first["metrics"]["metric_kind"] == "surrogate_agreement"
    assert first["metrics"]["observed_event_validation"].startswith("unavailable")
