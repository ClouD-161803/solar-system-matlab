# astroviz

Visualization layer for astrodynamics data: fast, black-background, interactive
animations that ship as a single HTML file and embed anywhere a web page can go
(a website, a reveal.js slide, an iframe, later a notebook).

The heavy lifting (propagation, continuation, stability) stays in PyDylan or
whatever produced the data. This package only draws.

```
astroviz/
  python/      export side: binary container writer, HTML builder, PyDylan family loader
  web/         browser runtime (TypeScript + three.js): container reader, frames, viewer, <astro-viewer>
  examples/    broucke/: the six Broucke family CSVs and the script that builds one HTML from them
```

## Quick start

```sh
cd astroviz/web && npm install && npm run build        # -> web/dist/astroviz.js
pip install numpy scipy                                 # scipy only for the stand-in propagator
python astroviz/examples/broucke/build.py               # -> examples/broucke/broucke_families.html
```

Open the HTML file in a browser. No server, no network.

## Design

### Physics boundary

The runtime may compute anything that is a change of coordinates; it never
integrates an equation of motion. Concretely:

| Level | What | Where |
|---|---|---|
| 0 | draw arrays | runtime |
| 1 | kinematic frame transforms (`web/src/frames.ts`): pulsating to rotating, rotating to inertial, re-centring on a body | runtime |
| 2 | time resampling and interpolation | runtime (planned) |
| 3 | propagation | PyDylan; possibly its C++ core compiled to WebAssembly later |
| 4 | continuation, correction, stability | PyDylan only |

The Broucke example stores only rotating-pulsating positions; the other four
views are derived in the browser from the mass ratio, the eccentricity and the
true anomaly. `python/astroviz/er3bp.py` is a stand-in scipy propagator so the
example builds without PyDylan. It is not part of the toolkit's contract.

### Sampling and smoothness

Following the matplotlib reference tool, the drawing grid is decoupled from the
playback grid. The exporter propagates each member densely (6000 points in
true anomaly), then keeps 480 samples at equal intervals of *blended on-screen
arclength*: per-step distance normalised by each frame's extent, the largest
over the five frames, divided evenly. Every sample carries its own true
anomaly. In the browser the trail is cut from that track at the current epoch
and the spacecraft is interpolated between the two bracketing samples, so the
orbit is smooth in every frame at any playback spacing. Playback can be
uniform in true anomaly, in nondimensional time (Kepler's equation solved in
the browser), or in arclength.

### Container format

`python/astroviz/container.py` and `web/src/container.ts` implement the same
thing: `ASTV` magic, a version, a JSON header describing typed `views` (offset,
length, dtype, shape) and `datasets` (plain records referencing views by name),
then 8-byte aligned raw buffers. It needs nothing beyond JSON and typed arrays
to read. The HTML builder gzips it and inlines it base64 in a script tag; the
runtime decodes it with the browser's native `DecompressionStream`. The same
container can instead sit next to the HTML as a sidecar file and be fetched,
which is the path for ephemeris-scale data.

### Runtime

- `OrbitViewer`: one three.js scene, orthographic camera, pan and zoom, optional
  3D orbit camera, a 2D overlay canvas for grid, ticks and labels.
- Drawing is a pure function of a sample index (`showFrame(i)`). Playback just
  advances the index. This is what makes deterministic recording to video
  possible without dropped frames.
- `<astro-viewer data="#id|url" frames="rotating_pulsating ...">` is the
  embeddable element: family tabs, branch toggle, parameter slider, frame
  toggles (one synchronized panel per frame), playback spacing, family
  members coloured by parameter with a colourbar (one colormap per frame, as
  in the reference figures), Okabe-Ito markers, fps counter, keyboard (space,
  arrows, shift+arrows).
- The current member's trail and full orbit take its colormap colour. The
  other members are drawn with per-vertex alpha from a Gaussian kernel over
  parameter distance, so the neighbourhood of the current member is bright
  and fades with distance. When the member changes the band cross-fades over
  260 ms and a pulse ripples outward through the family over 700 ms.
- Camera policy: a panel is fitted when opened and when the family changes;
  the parameter slider and branch toggle never move it.

## Known limitations of the prototype

- Each panel owns a WebGL context; with all members ghosted in several panels
  this is fine on a GPU but slow under software rendering. One renderer with a
  scissor rectangle per panel is the planned fix.
- Planar only; the data path carries z = 0 but the exporter does not yet
  accept 3D states.
- No recording, no notebook widget, no sidecar loading UI yet.
