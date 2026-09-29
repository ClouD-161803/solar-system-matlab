"""Builds the Broucke families example: six family CSVs -> one HTML file.

Run from anywhere::

    python astroviz/examples/broucke/build.py

Requires the runtime bundle at ``astroviz/web/dist/astroviz.js`` (build it
with ``npm run build`` in ``astroviz/web``) and ``numpy`` plus ``scipy`` for
the stand-in propagator.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "python"))

import numpy as np  # noqa: E402

from astroviz import ContainerWriter, add_er3bp_family, build_html, load_family_csv  # noqa: E402
from astroviz.er3bp import propagate_planar  # noqa: E402

# Mass ratios as used when the families were continued in PyDylan.
FAMILIES = [
    (7, 0.012155),
    (8, 0.5),
    (11, 0.5),
]
BRANCHES = [("periapsis", 0.0), ("apoapsis", float(np.pi))]
N_SAMPLES = 401


def main() -> None:
    runtime_path = ROOT / "web" / "dist" / "astroviz.js"
    if not runtime_path.exists():
        sys.exit(f"runtime bundle missing: {runtime_path} (run `npm run build` in astroviz/web)")

    writer = ContainerWriter(generator="astroviz broucke example")
    writer.meta = {
        "title": "Broucke families in the ER3BP",
        "note": "Trajectories sampled with the stand-in scipy propagator, not PyDylan.",
    }
    t0 = time.time()
    for number, mu in FAMILIES:
        for branch, f0 in BRANCHES:
            csv = HERE / "data" / f"family_{number}_{branch}.csv"
            family = load_family_csv(str(csv))
            print(f"family {number:2d} {branch:9s}: {len(family):4d} members, mu={mu}", flush=True)
            add_er3bp_family(
                writer,
                f"broucke-{number}-{branch}",
                family,
                title=f"Broucke family {number} {branch}",
                group=f"Broucke family {number}",
                branch=branch,
                mu=mu,
                f0=f0,
                propagate=propagate_planar,
                n_samples=N_SAMPLES,
            )
    container = writer.to_bytes()
    print(f"container: {len(container) / 1e6:.1f} MB, sampled in {time.time() - t0:.0f} s")

    (HERE / "broucke_families.astv").write_bytes(container)
    html = build_html(container, runtime_path.read_text(encoding="utf-8"), title="Broucke families")
    out = HERE / "broucke_families.html"
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({len(html) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
