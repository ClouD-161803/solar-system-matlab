"""Periodic orbit families: loading PyDylan family CSVs and exporting them.

A family file is what ``PeriodicOrbitFamily.save_family_data_to_file`` writes:
one row per member with the continuation parameter, energy, period and the six
initial state elements. It holds no trajectories, so exporting a family for
visualization means sampling each member along its orbit first. In production
that sampling is PyDylan's job; ``propagate`` is injected so the example can
use the stand-in integrator from :mod:`astroviz.er3bp`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from .container import ContainerWriter

Propagator = Callable[[np.ndarray, float, float, float, np.ndarray], np.ndarray]


@dataclass
class Family:
    parameter: np.ndarray  # (N,)
    energy: np.ndarray  # (N,)
    period: np.ndarray  # (N,)
    initial_state: np.ndarray  # (N, 6)
    corrector_iterations: np.ndarray  # (N,)

    def __len__(self) -> int:
        return len(self.parameter)


def load_family_csv(path: str) -> Family:
    """Reads a family CSV with the PyDylan header row."""
    rows = np.loadtxt(path, delimiter=",", skiprows=1, ndmin=2)
    if rows.shape[1] != 10:
        raise ValueError(f"{path}: expected 10 columns, found {rows.shape[1]}")
    return Family(
        parameter=rows[:, 0],
        energy=rows[:, 1],
        period=rows[:, 2],
        initial_state=rows[:, 3:9],
        corrector_iterations=rows[:, 9].astype(np.int32),
    )


def add_er3bp_family(
    writer: ContainerWriter,
    dataset_id: str,
    family: Family,
    *,
    title: str,
    group: str,
    branch: str,
    mu: float,
    f0: float,
    propagate: Propagator,
    n_samples: int = 401,
    parameter_name: str = "eccentricity",
    parameter_symbol: str = "e",
    progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Samples every member of an ER3BP family and adds it to ``writer``.

    Members are sampled on a uniform grid of ``n_samples`` true anomaly values
    over one period. Only the rotating-pulsating planar position is stored;
    the browser derives the rotating, barycentric inertial and body-centred
    inertial views from it kinematically using ``mu``, ``e`` and ``f``.
    """
    n = len(family)
    f_rel = np.linspace(0.0, 1.0, n_samples)  # scaled by each member's period below
    positions = np.empty((n, n_samples, 2), dtype=np.float32)
    closure = np.empty(n, dtype=np.float32)
    for i in range(n):
        grid = f_rel * family.period[i]
        states = propagate(family.initial_state[i], mu, float(family.parameter[i]), f0, grid)
        positions[i] = states[:, :2]
        closure[i] = np.linalg.norm(states[-1] - states[0])
        if progress:
            progress(i + 1, n)

    if not np.allclose(family.period, family.period[0]):
        raise ValueError("members with unequal periods need a per-member grid; not supported yet")

    prefix = dataset_id
    record = {
        "id": dataset_id,
        "kind": "periodic_orbit_family",
        "title": title,
        "group": group,
        "branch": branch,
        "system": {
            "model": "ER3BP",
            "mu": mu,
            "f0": f0,
            "primary": "m₁",
            "secondary": "m₂",
        },
        "coordinates": {
            "frame": "rotating_pulsating",
            "components": ["x", "y"],
            "unit": "DU",
        },
        "independent_variable": {
            "name": "true_anomaly",
            "symbol": "f",
            "unit": "rad",
            "relative": True,
            "view": writer.add_view(f"{prefix}.f", f_rel * family.period[0], dtype="float64"),
        },
        "parameter": {
            "name": parameter_name,
            "symbol": parameter_symbol,
            "view": writer.add_view(f"{prefix}.parameter", family.parameter, dtype="float64"),
        },
        "period": {"view": writer.add_view(f"{prefix}.period", family.period, dtype="float64")},
        "initial_state": {
            "view": writer.add_view(f"{prefix}.initial_state", family.initial_state, dtype="float64")
        },
        "positions": {"view": writer.add_view(f"{prefix}.positions", positions)},
        "closure_error": {"view": writer.add_view(f"{prefix}.closure", closure)},
    }
    writer.add_dataset(record)
    return record
