"""Broucke (1969) families 7, 8 and 11 in the ER3BP -> one self-contained HTML page.

Reads the six family CSVs PyDylan wrote with ``save_family_data_to_file``,
propagates every member for one period with PyDylan's RK54 on the ER3BP,
resamples each orbit for smooth drawing, and writes ``broucke_families.tyd``
and ``broucke_families.html`` next to this script.

Requires ``pydylan`` and the ``broucke_1969_support`` module from the PyDylan
demos (for ``bodies_at_mass_ratio``) on the Python path, and a pytycho install
that includes the runtime bundle (``pip install pytycho``, or in a checkout
``npm ci && npm run build`` in ``web/`` then ``pip install -e .``).

    python examples/broucke/build.py
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np

import pytycho
from pytycho.adapters.pydylan import er3bp_propagator, load_family

HERE = Path(__file__).resolve().parent

FAMILIES = [(7, 0.012155), (8, 0.5), (11, 0.5)]  # (Broucke family number, mass ratio)
BRANCHES = [("periapsis", 0.0), ("apoapsis", float(np.pi))]  # (branch, f0)
N_SAMPLES = 480  # stored per member, at equal blended arclength
N_DENSE = 6000  # propagation grid each member is resampled from


def make_er3bp(mu: float, e: float):
    """The ER3BP at mass ratio ``mu`` and primaries' eccentricity ``e``, as the PyDylan demos build it."""
    import pydylan
    from broucke_1969_support import bodies_at_mass_ratio

    primary, secondary = bodies_at_mass_ratio(mu)
    return pydylan.eom.ER3BP(primary, secondary, e)


def main() -> None:
    propagate = er3bp_propagator(make_er3bp)
    writer = pytycho.ContainerWriter(generator=f"pytycho {pytycho.__version__}, Broucke example")
    writer.meta = {"title": "Broucke families in the ER3BP", "propagator": "PyDylan RK54"}
    t0 = time.time()
    for number, mu in FAMILIES:
        for branch, f0 in BRANCHES:
            family = load_family(str(HERE / "data" / f"family_{number}_{branch}.csv"))
            print(f"family {number:2d} {branch:9s}: {len(family):4d} members, mu = {mu}", flush=True)
            pytycho.add_er3bp_family(
                writer,
                f"broucke-{number}-{branch}",
                family,
                title=f"Broucke family {number} {branch}",
                group=f"family {number}",
                branch=branch,
                mu=mu,
                f0=f0,
                propagate=propagate,
                n_samples=N_SAMPLES,
                n_dense=N_DENSE,
            )
    data = writer.to_bytes()
    (HERE / "broucke_families.tyd").write_bytes(data)
    out = pytycho.write_html(HERE / "broucke_families.html", data, title="Broucke families")
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
