"""Stand-in planar ER3BP propagator.

This module exists only so the example can be built without PyDylan. It
integrates the elliptic restricted three-body problem in rotating-pulsating
coordinates with the true anomaly ``f`` as the independent variable, which is
the formulation PyDylan's ``pydylan.eom.ER3BP`` uses. In production the
trajectory samples must come from PyDylan's integrator: the visualization
toolkit is meant to stay on the kinematic side of the physics boundary and
never own an ODE solver of its own.

The primary of mass ``1 - mu`` sits at ``(-mu, 0)`` and the secondary of mass
``mu`` at ``(1 - mu, 0)``. Primes are derivatives with respect to ``f``::

    x'' - 2 y' = (x - (1-mu)(x+mu)/r1^3 - mu (x-1+mu)/r2^3) / (1 + e cos f)
    y'' + 2 x' = (y - (1-mu) y/r1^3   - mu y/r2^3        ) / (1 + e cos f)
"""

from __future__ import annotations

import numpy as np
from scipy.integrate import solve_ivp


def _rhs(f: float, s: np.ndarray, mu: float, e: float) -> list[float]:
    x, y, vx, vy = s
    r1 = np.hypot(x + mu, y)
    r2 = np.hypot(x - 1.0 + mu, y)
    k = 1.0 / (1.0 + e * np.cos(f))
    ax = 2.0 * vy + k * (x - (1.0 - mu) * (x + mu) / r1**3 - mu * (x - 1.0 + mu) / r2**3)
    ay = -2.0 * vx + k * (y - (1.0 - mu) * y / r1**3 - mu * y / r2**3)
    return [vx, vy, ax, ay]


def propagate_planar(
    initial_state: np.ndarray,
    mu: float,
    eccentricity: float,
    f0: float,
    f_grid: np.ndarray,
    rtol: float = 1e-10,
    atol: float = 1e-12,
) -> np.ndarray:
    """Propagates a planar state and samples it on ``f0 + f_grid``.

    ``initial_state`` is the six-element ``[x, y, z, xdot, ydot, zdot]``
    PyDylan convention; ``z`` and ``zdot`` are ignored. Returns an array of
    shape ``(len(f_grid), 4)`` holding ``x, y, x', y'`` at each sample.
    """
    x, y, _z, vx, vy, _vz = np.asarray(initial_state, dtype=float)
    f_abs = f0 + np.asarray(f_grid, dtype=float)
    sol = solve_ivp(
        _rhs,
        (f_abs[0], f_abs[-1]),
        [x, y, vx, vy],
        t_eval=f_abs,
        args=(mu, eccentricity),
        method="DOP853",
        rtol=rtol,
        atol=atol,
    )
    if not sol.success:
        raise RuntimeError(f"propagation failed: {sol.message}")
    return sol.y.T.copy()
