"""Periodic orbit families: sampling members and writing them to a Tycho container.

A family is the set of initial conditions a continuation run produces: one
member per parameter value, each with a period and an initial state. It holds
no trajectories, so exporting a family means propagating each member over one
period first. Propagation is injected as a ``Propagator``; the PyDylan adapter
(:mod:`pytycho.adapters.pydylan`) provides one, and any other integrator with
the same signature works. pytycho itself never integrates.

Sampling strategy
-----------------
Frames drawn at equal intervals of the independent variable look jagged where
the spacecraft covers a long stretch of orbit per radian (close approaches,
high eccentricity in inertial frames). Each member is therefore propagated
densely and resampled at equal intervals of *blended on-screen arclength*: in
each of the five display frames the per-step distance is normalised by that
frame's extent, the largest across frames is taken at every step, and the
samples divide the running total evenly. The stored samples concentrate where
any frame bends, and the browser interpolates the spacecraft between them.
Each sample carries its own true anomaly so the primaries are placed exactly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from .container import ContainerWriter

#: ``propagate(initial_state, mu, e, f0, f_grid) -> states`` with ``states`` of shape
#: ``(len(f_grid), >=4)`` holding x, y, x', y' (rotating-pulsating) at ``f0 + f_grid``.
Propagator = Callable[[np.ndarray, float, float, float, np.ndarray], np.ndarray]

FRAME_IDS = ("rotating_pulsating", "rotating", "barycentric_inertial", "inertial_primary", "inertial_secondary")


@dataclass
class Family:
    """One branch of a periodic orbit family, as plain arrays."""

    parameter: np.ndarray  # (N,) continuation parameter, eccentricity for ER3BP families
    period: np.ndarray  # (N,) in the units of the independent variable (rad of true anomaly)
    initial_state: np.ndarray  # (N, 6) x, y, z, x', y', z'
    energy: np.ndarray = field(default_factory=lambda: np.empty(0))  # (N,) or empty

    def __post_init__(self) -> None:
        self.parameter = np.asarray(self.parameter, dtype=float)
        self.period = np.asarray(self.period, dtype=float)
        self.initial_state = np.asarray(self.initial_state, dtype=float).reshape(len(self.parameter), -1)
        if len(self.period) != len(self.parameter):
            raise ValueError("parameter and period must have the same length")

    def __len__(self) -> int:
        return len(self.parameter)


# --- kinematic frames (mirror of web/src/frames.ts, used only for resampling) --------------------


def _rho(e: float, f: np.ndarray) -> np.ndarray:
    return (1.0 - e * e) / (1.0 + e * np.cos(f))


def frame_xy(xy: np.ndarray, f: np.ndarray, mu: float, e: float, frame: str) -> np.ndarray:
    """Rotating-pulsating planar positions ``xy`` at absolute true anomalies ``f`` in ``frame``."""
    if frame == "rotating_pulsating":
        return xy
    r = _rho(e, f)[:, None]
    if frame == "rotating":
        return r * xy
    c, s = np.cos(f), np.sin(f)
    out = np.empty_like(xy)
    out[:, 0] = r[:, 0] * (xy[:, 0] * c - xy[:, 1] * s)
    out[:, 1] = r[:, 0] * (xy[:, 0] * s + xy[:, 1] * c)
    if frame == "barycentric_inertial":
        return out
    xb = -mu if frame == "inertial_primary" else 1.0 - mu
    out[:, 0] -= r[:, 0] * xb * c
    out[:, 1] -= r[:, 0] * xb * s
    return out


def blended_arclength_grid(xy: np.ndarray, f_abs: np.ndarray, mu: float, e: float, n_samples: int) -> np.ndarray:
    """Indices into the dense track at equal intervals of blended on-screen arclength."""
    increments = []
    for frame in FRAME_IDS:
        track = frame_xy(xy, f_abs, mu, e, frame)
        span = max(np.ptp(track[:, 0]), np.ptp(track[:, 1])) or 1.0
        increments.append(np.hypot(*np.diff(track, axis=0).T) / span)
    cumulative = np.concatenate([[0.0], np.cumsum(np.max(increments, axis=0))])
    targets = np.linspace(0.0, cumulative[-1], n_samples)
    idx = np.searchsorted(cumulative, targets, side="left")
    idx = np.clip(idx, 0, len(cumulative) - 1)
    idx[0], idx[-1] = 0, len(cumulative) - 1
    # keep strictly increasing where the dense track allows it
    for i in range(1, len(idx)):
        if idx[i] <= idx[i - 1]:
            idx[i] = min(idx[i - 1] + 1, len(cumulative) - 1)
    return idx


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
    n_samples: int = 480,
    n_dense: int = 6000,
    parameter_name: str = "eccentricity",
    parameter_symbol: str = "e",
    progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Samples every member of an ER3BP family and adds it to ``writer``.

    Each member is propagated on ``n_dense`` uniform true anomaly values over
    one period, then reduced to ``n_samples`` points at equal blended
    arclength. Only the rotating-pulsating planar position and the relative
    true anomaly of each sample are stored; the browser derives the other
    views kinematically using ``mu``, ``e`` and ``f``.
    """
    n = len(family)
    positions = np.empty((n, n_samples, 2), dtype=np.float32)
    anomalies = np.empty((n, n_samples), dtype=np.float32)
    closure = np.empty(n, dtype=np.float32)
    for i in range(n):
        e = float(family.parameter[i])
        grid = np.linspace(0.0, family.period[i], n_dense)
        states = propagate(family.initial_state[i], mu, e, f0, grid)
        closure[i] = np.linalg.norm(states[-1] - states[0])
        idx = blended_arclength_grid(states[:, :2], f0 + grid, mu, e, n_samples)
        positions[i] = states[idx, :2]
        anomalies[i] = grid[idx]
        if progress:
            progress(i + 1, n)

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
        "sampling": "blended_arclength",
        "independent_variable": {
            "name": "true_anomaly",
            "symbol": "f",
            "unit": "rad",
            "relative": True,
            "per_member": True,
            "view": writer.add_view(f"{prefix}.f", anomalies),
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
