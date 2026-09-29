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
- `<astro-viewer data="#id|url" [layout='{...}'] [frames="..."] [kiosk]>` is
  the embeddable element. Panels tile the stage as a binary split tree
  (`web/src/layout.ts`): drag a frame chip onto a panel's edge to split it
  there, onto its centre to replace it, drag a panel by its header to move it
  (centre drop swaps), drag gutters to resize, click a chip to add by
  splitting the largest panel. Any count up to eight, never an empty cell.
  Each panel owns its frame and its family branch (periapsis or apoapsis),
  so both branches can be compared side by side; the eccentricity slider,
  family tabs, clock and playback are shared and each panel shows its
  branch's member nearest the slider. The layout is remembered in the
  browser per page title; `layout` (the JSON from the element's `layoutJSON`
  getter, or `build_html(layout=...)`) sets the initial layout of an export
  and `kiosk` hides the controls and autoplays, for slides.
- Family members coloured by parameter with a colourbar (one colormap per
  frame, as in the reference figures), Okabe-Ito markers, fps counter,
  keyboard (space, arrows, shift+arrows; up and down step the eccentricity).
- The spacecraft leaves a comet-style trail in the current member's colormap
  colour: a tapered ribbon sized in screen pixels (6 px core, 22 px additive
  glow at the craft) that thins and fades over 30% of the period behind it,
  rebuilt each frame from the stored track. The member's full orbit is drawn
  under it at lower alpha.
- About forty members are drawn as context and members near the current one
  (Gaussian kernel over parameter distance) are lit over their whole orbits,
  relaxing about 60 ms in and 320 ms out when the slider moves. Always on.
- Camera policy: a panel is fitted when opened, resized and when the family
  changes; the parameter slider and branch toggle never move it.

## Known limitations of the prototype

- Each panel owns a WebGL context; with all members ghosted in several panels
  this is fine on a GPU but slow under software rendering. One renderer with a
  scissor rectangle per panel is the planned fix.
- Planar only; the data path carries z = 0 but the exporter does not yet
  accept 3D states.
- No recording, no notebook widget, no sidecar loading UI yet.
