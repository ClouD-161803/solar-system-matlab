"""PyDylan adapter: PyDylan objects in, pytycho arrays out.

Nothing here imports ``pydylan`` at module load; every function takes PyDylan
objects (or factories that build them) as arguments, so pytycho installs and
imports without PyDylan, and the adapter is tested against duck-typed fakes.

Two entry points cover the families workflow:

``family_from_pydylan(family)``
    ``pydylan.periodic_orbit.PeriodicOrbitFamily`` -> :class:`pytycho.Family`.

``er3bp_propagator(make_system)``
    A :data:`pytycho.families.Propagator` that integrates with PyDylan's RK54
    on the ER3BP built by ``make_system(mu, e)``, with true anomaly as the
    independent variable, and returns states on the requested grid.
"""

from __future__ import annotations

from typing import Any, Callable

import numpy as np

from ..families import Family, Propagator


def family_from_pydylan(family: Any) -> Family:
    """Converts a ``PeriodicOrbitFamily`` (loaded, or recorded by a continuation run)."""
    members = family.get_members()
    if not members:
        raise ValueError("the family has no members")
    return Family(
        parameter=np.array([m.parameter_value for m in members], dtype=float),
        period=np.array([m.period for m in members], dtype=float),
        initial_state=np.array([np.asarray(m.initial_state, dtype=float) for m in members]),
        energy=np.array([m.energy for m in members], dtype=float),
    )


def load_family(path: str) -> Family:
    """Reads a family CSV written by ``PeriodicOrbitFamily.save_family_data_to_file``."""
    from pydylan.periodic_orbit import PeriodicOrbitFamily  # deferred: optional dependency

    return family_from_pydylan(PeriodicOrbitFamily.load_family_data_from_file(path))


def er3bp_propagator(
    make_system: Callable[[float, float], Any],
    *,
    tolerance: float = 1e-12,
    integrator_factory: Callable[[], Any] | None = None,
) -> Propagator:
    """Returns a propagator backed by PyDylan.

    ``make_system(mu, e)`` must return a ``pydylan.eom.ER3BP`` for that mass
    ratio and primaries' eccentricity; systems are cached per ``(mu, e)``.
    ``integrator_factory`` defaults to ``pydylan.integrators.RK54``.

    The integrator's adaptive steps are kept, then the state is interpolated
    onto ``f0 + f_grid`` with a cubic Hermite interpolant that uses the state
    derivatives already in the state vector, which is accurate to well below
    display resolution for the step sizes RK54 takes at ``tolerance``.
    """
    systems: dict[tuple[float, float], Any] = {}

    def make_integrator() -> Any:
        if integrator_factory is not None:
            return integrator_factory()
        from pydylan.integrators import RK54  # deferred: optional dependency

        return RK54()

    def propagate(initial_state: np.ndarray, mu: float, e: float, f0: float, f_grid: np.ndarray) -> np.ndarray:
        key = (float(mu), float(e))
        if key not in systems:
            systems[key] = make_system(*key)
        rk = make_integrator()
        rk.set_eom(systems[key])
        if hasattr(rk, "tolerance"):
            rk.tolerance = tolerance
        f_grid = np.asarray(f_grid, dtype=float)
        rk.set_time(f0 + float(f_grid[0]), f0 + float(f_grid[-1]))
        rk.evaluate(np.asarray(initial_state, dtype=float), True, True)
        t = np.asarray(rk.get_time(), dtype=float)
        states = np.asarray(rk.get_states(), dtype=float)
        return resample_hermite(t, states, f0 + f_grid)

    return propagate


def resample_hermite(t: np.ndarray, states: np.ndarray, t_out: np.ndarray) -> np.ndarray:
    """Cubic Hermite resampling of ``[x, y, z, x', y', z']`` states; returns ``x, y, x', y'``.

    Positions use the velocities as derivatives; velocities are linear between
    steps, which is enough since only positions are drawn.
    """
    t = np.asarray(t, dtype=float)
    states = np.asarray(states, dtype=float)
    if states.ndim != 2 or states.shape[1] < 6:
        raise ValueError(f"expected states of shape (M, 6+), got {states.shape}")
    keep = np.concatenate([[True], np.diff(t) > 0])  # drop repeated times at event stops
    t, states = t[keep], states[keep]
    k = np.clip(np.searchsorted(t, t_out, side="right") - 1, 0, len(t) - 2)
    h = t[k + 1] - t[k]
    u = np.where(h > 0, (t_out - t[k]) / np.where(h > 0, h, 1.0), 0.0)
    h00 = 2 * u**3 - 3 * u**2 + 1
    h10 = u**3 - 2 * u**2 + u
    h01 = -2 * u**3 + 3 * u**2
    h11 = u**3 - u**2
    out = np.empty((len(t_out), 4))
    for j, (pos, vel) in enumerate(((0, 3), (1, 4))):
        p0, p1 = states[k, pos], states[k + 1, pos]
        v0, v1 = states[k, vel], states[k + 1, vel]
        out[:, j] = h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1
        out[:, j + 2] = v0 + (v1 - v0) * u
    return out
