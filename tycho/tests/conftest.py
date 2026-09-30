"""Shared fixtures: a reference ER3BP integrator and PyDylan look-alikes.

The fakes mimic exactly the PyDylan API the adapter calls (``get_members`` and
member attributes; ``set_eom``, ``set_time``, ``evaluate``, ``get_time``,
``get_states``, ``tolerance`` on the integrator), so the adapter is exercised
without PyDylan installed. The dynamics are the planar ER3BP in
rotating-pulsating coordinates with true anomaly as the independent variable.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pytest
from scipy.integrate import solve_ivp


def er3bp_rhs(f, s, mu, e):
    x, y, z, vx, vy, vz = s
    r1 = np.sqrt((x + mu) ** 2 + y**2 + z**2)
    r2 = np.sqrt((x - 1 + mu) ** 2 + y**2 + z**2)
    k = 1.0 / (1.0 + e * np.cos(f))
    ax = 2 * vy + k * (x - (1 - mu) * (x + mu) / r1**3 - mu * (x - 1 + mu) / r2**3)
    ay = -2 * vx + k * (y - (1 - mu) * y / r1**3 - mu * y / r2**3)
    az = k * (-(1 - mu) * z / r1**3 - mu * z / r2**3) - e * np.cos(f) * k * z
    return [vx, vy, vz, ax, ay, az]


@dataclass
class FakeER3BP:
    mu: float
    eccentricity: float


class FakeRK54:
    def __init__(self):
        self.tolerance = 1e-10
        self._eom = None
        self._t0 = self._t1 = 0.0
        self._t = self._s = None

    def set_eom(self, eom):
        self._eom = eom

    def set_time(self, t0, t1):
        self._t0, self._t1 = t0, t1

    def evaluate(self, state, clear_results=True, save_state_history=True):
        sol = solve_ivp(er3bp_rhs, (self._t0, self._t1), state, args=(self._eom.mu, self._eom.eccentricity),
                        method="DOP853", rtol=self.tolerance, atol=self.tolerance * 1e-2)
        self._t, self._s = sol.t, sol.y.T
        return self._s[-1]

    def get_time(self):
        return self._t

    def get_states(self):
        return self._s


@dataclass
class FakeMember:
    parameter_value: float
    period: float
    initial_state: np.ndarray
    energy: float = float("nan")


class FakeFamily:
    def __init__(self, members):
        self._members = members

    def get_members(self):
        return list(self._members)


# Two members of Broucke family 7, periapsis branch (mu = 0.012155), from the PyDylan export.
FAMILY7_PERI = [
    (0.0, 0.15212026932000766, 3.1607655873953333),
    (0.1, 0.12783388710205812, 3.3296585124400053),
]


@pytest.fixture
def fake_family():
    return FakeFamily([
        FakeMember(e, 2 * np.pi, np.array([x, 0, 0, 0, vy, 0])) for e, x, vy in FAMILY7_PERI
    ])


@pytest.fixture
def fake_propagator():
    from pytycho.adapters.pydylan import er3bp_propagator

    return er3bp_propagator(lambda mu, e: FakeER3BP(mu, e), tolerance=1e-11, integrator_factory=FakeRK54)
