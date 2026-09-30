# Tycho

Animated, interactive astrodynamics visualizations that ship as a single HTML
file: black background, frames switched as a view operation, families you can
slide through, panels you arrange by drag and drop. Open it from disk, put it
on a website, or drop it into a reveal.js slide.

Tycho only draws. The physics (propagation, continuation, stability) stays in
[PyDylan](https://github.com/beeson-group/pydylan) or whatever produced your
data; pytycho turns those arrays into a page.

| Package | Registry | What it is |
|---|---|---|
| `pytycho` | PyPI | Python API: data container writer, PyDylan adapter, HTML builder (bundles the runtime) |
| `pytycho` | npm | the browser runtime: `<tycho-viewer>` web component, as ES module and IIFE |

## Quick start

```sh
pip install pytycho
```

```python
import pytycho
from pytycho.adapters.pydylan import er3bp_propagator, load_family

family = load_family("family_7_periapsis.csv")   # written by PeriodicOrbitFamily.save_family_data_to_file
writer = pytycho.ContainerWriter()
pytycho.add_er3bp_family(
    writer, "f7-peri", family,
    title="Broucke family 7 periapsis", group="family 7", branch="periapsis",
    mu=0.012155, f0=0.0, propagate=er3bp_propagator(make_er3bp),  # make_er3bp(mu, e) -> pydylan.eom.ER3BP
)
pytycho.write_html("family7.html", writer.to_bytes(), title="Broucke family 7")
```

Without PyDylan, pass any `propagate(initial_state, mu, e, f0, f_grid)` that
returns rotating-pulsating states on `f0 + f_grid`, and build `pytycho.Family`
from plain arrays.

The full example, all six Broucke branches of families 7, 8 and 11 in one
page, is `examples/broucke/build.py`.

## Files

| Extension | What |
|---|---|
| `.tyd` | Tycho data container: `TYCD` magic, JSON header, 8-byte aligned typed arrays |
| `.html` | the deliverable: container gzipped and inlined, runtime inlined |

## Development

```sh
cd web && npm ci && npm run build    # runtime -> web/dist and src/pytycho/_static/tycho.js
cd .. && pip install -e ".[test]" && pytest
```

`docs/ARCHITECTURE.md` explains how the pipeline works and why.

## License

To be decided before the first release.
