/**
 * three.js scene for one trajectory in one frame, with a 2D axes overlay.
 *
 * Drawing is a pure function of a true anomaly: `showAt(fRel)` draws the state
 * at that epoch and nothing depends on wall-clock time, which is what makes
 * deterministic recording possible. The one exception is cosmetic: the family
 * highlight eases and ripples between members over a short transition.
 *
 * Smoothness follows the reference matplotlib tool: the stored samples are a
 * dense, arclength-adaptive track. The trail is cut from that track at the
 * current epoch rather than joined up from a playback grid, so it lies on the
 * orbit instead of chording across it, and the spacecraft is interpolated
 * between the two samples that bracket the epoch.
 *
 * Colour: the current member's trail and full orbit take that member's colour
 * in the frame's colormap. The spacecraft leaves a comet-style trail: a
 * tapered ribbon sized in screen pixels, bright and wide at the craft, thinning
 * and fading over a fixed stretch of orbit behind it, with a soft additive
 * glow underneath. The other members are drawn with per-vertex alpha: a kernel
 * over parameter distance brightens the neighbours of the current member over
 * their whole orbits, on top of a sparse context set, relaxing fast in and
 * slower out when the member changes.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { colormap, colormapCss } from './colormaps';
import {
  FRAMES,
  type ER3BPSystem,
  type FrameId,
  bodyPosition,
  bodyTrail,
  segmentIndex,
  transformTrajectory,
} from './frames';

/** Okabe-Ito on black, as in the reference animation. */
export interface Palette {
  background: string;
  craft: string;
  primary: string;
  secondary: string;
  grid: string;
  axis: string;
  text: string;
}

export const DARK: Palette = {
  background: '#000000',
  craft: '#F0E442',
  primary: '#56B4E9',
  secondary: '#A8A8A8',
  grid: '#1e1e1e',
  axis: '#555555',
  text: '#cfcfcf',
};

/** A whole family branch: n members, m samples each, rotating-pulsating x,y and relative true anomaly. */
export interface FamilyTracks {
  count: number;
  samples: number;
  positions: Float32Array; // n*m*2
  anomalies: Float32Array; // n*m
  params: Float64Array; // n
  mu: number;
  f0: number;
}

export type FamilyMode = 'hidden' | 'neighbours' | 'family';

/** Highlight kernel width as a fraction of the family's parameter range. */
const NEIGHBOUR_SIGMA = 0.05;
/** Alpha of the nearest neighbours' trail; the current member itself is drawn separately. */
const NEIGHBOUR_PEAK = 0.55;
/** About this many members are drawn as the family's context in 'family' mode. */
const SPARSE_COUNT = 40;
const SPARSE_ALPHA = 0.4;
/** Spacecraft trail: length as a fraction of the period, core and glow widths in CSS pixels at the craft. */
const TRAIL_FRACTION = 0.3;
/** Nose: the ribbon grows from a point at the craft to full width over this fraction of the trail. */
const TRAIL_NOSE = 0.07;
const TRAIL_CORE_PX = 6;
const TRAIL_GLOW_PX = 22;
/** Time constants of the alpha relaxation: fast in, slower out, so the trail fades behind. */
const RISE_MS = 60;
const DECAY_MS = 320;

function discTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(32, 32, 28, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

function points(color: string, size: number, tex: THREE.Texture, count: number): THREE.Points {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * count), 3));
  const mat = new THREE.PointsMaterial({
    color,
    size,
    map: tex,
    transparent: true,
    alphaTest: 0.5,
    sizeAttenuation: false,
    depthTest: false,
  });
  return new THREE.Points(geom, mat);
}

function line(color: string, opacity: number, count: number): THREE.Line {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * count), 3));
  // always in the transparent pass so renderOrder decides stacking (opaque objects would draw first)
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
  return new THREE.Line(geom, mat);
}

function niceStep(range: number, target = 6): number {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  const step = r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10;
  return step * mag;
}

export class OrbitViewer {
  readonly host: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  palette: Palette = DARK;

  frame: FrameId = 'rotating_pulsating';
  showGhost = true;
  /** draw the frame name at the top of the overlay (off when a panel header shows it) */
  showTitle = false;
  private threeD = false;

  private sys: ER3BPSystem = { mu: 0.5, e: 0, f0: 0 };
  private xy: Float32Array = new Float32Array(0);
  private fRel: ArrayLike<number> = new Float32Array(0);
  private xyz: Float32Array = new Float32Array(0);
  private fNow = 0;

  // family ghosts
  private tracks: FamilyTracks | null = null;
  private familyMode: FamilyMode = 'hidden';
  private paramRange: [number, number] | null = null;
  private alphaNow = new Float32Array(0); // per member, as drawn
  private alphaFrom = new Float32Array(0); // per member, at the start of the transition
  private alphaTo = new Float32Array(0); // per member, target
  private baseAlpha = new Float32Array(0); // per member, constant context level
  private written = new Float32Array(0); // per member, constant alpha last written, or -1 for per-vertex
  private fadeLast = 0;
  private fadeRaf = 0;

  private orbit: THREE.Line; // crisp centre line of the trail
  private trailCore: THREE.Mesh; // tapered ribbon in the member colour
  private trailGlow: THREE.Mesh; // wider additive halo under it
  private trailPts: Float32Array = new Float32Array(0); // x,y per trail point, craft first
  private trailT: Float32Array = new Float32Array(0); // 0 at the craft, 1 at the trail's end
  private trailCount = 0;
  private memberRgb = [1, 1, 1];
  private ghost: THREE.Line; // the current member's complete orbit
  private family: THREE.LineSegments; // other members, coloured by parameter with per-vertex alpha
  private craft: THREE.Points;
  private primary: THREE.Points;
  private secondary: THREE.Points;
  private primaryTrail: THREE.Line;
  private secondaryTrail: THREE.Line;
  private grid: THREE.GridHelper;
  private ro: ResizeObserver;
  private userMoved = false;

  constructor(host: HTMLElement, frame: FrameId = 'rotating_pulsating') {
    this.host = host;
    this.frame = frame;
    this.canvas = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    for (const c of [this.canvas, this.overlay]) {
      c.style.position = 'absolute';
      c.style.inset = '0';
      c.style.width = '100%';
      c.style.height = '100%';
    }
    this.overlay.style.pointerEvents = 'none';
    host.style.position = 'relative';
    host.appendChild(this.canvas);
    host.appendChild(this.overlay);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(new THREE.Color(this.palette.background), 1);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
    this.camera.position.set(0, 0, 10);
    this.camera.up.set(0, 1, 0);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => {
      this.userMoved = true;
      this.render();
    });

    const tex = discTexture();
    // a 4-component colour attribute gives per-vertex alpha in three.js
    this.family = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, depthTest: false }),
    );
    this.family.visible = false;
    this.ghost = line('#d0d0d0', 0.8, 2); // the current member's complete orbit, recoloured per member
    this.orbit = line('#ffffff', 1, 2); // the trail's centre line, recoloured per member
    const ribbon = (blending: THREE.Blending) =>
      new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false, blending, side: THREE.DoubleSide }),
      );
    this.trailGlow = ribbon(THREE.AdditiveBlending);
    this.trailCore = ribbon(THREE.NormalBlending);
    this.primaryTrail = line(this.palette.primary, 0.3, 2);
    this.secondaryTrail = line(this.palette.secondary, 0.3, 2);
    this.craft = points(this.palette.craft, 9, tex, 1);
    this.primary = points(this.palette.primary, 8, tex, 1);
    this.secondary = points(this.palette.secondary, 6, tex, 1);
    this.grid = new THREE.GridHelper(4, 16, this.palette.axis, this.palette.grid);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.visible = false;
    const stack: THREE.Object3D[] = [
      this.grid,
      this.family,
      this.primaryTrail,
      this.secondaryTrail,
      this.ghost,
      this.trailGlow,
      this.trailCore,
      this.orbit,
      this.primary,
      this.secondary,
      this.craft,
    ];
    stack.forEach((o, i) => (o.renderOrder = i));
    this.scene.add(...stack);
    this.setThreeD(false);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  dispose(): void {
    cancelAnimationFrame(this.fadeRaf);
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }

  get system(): ER3BPSystem {
    return this.sys;
  }

  get epoch(): number {
    return this.fNow;
  }

  /** Colour of the current member in this frame's colormap. */
  private memberColor(): string {
    const r = this.paramRange;
    const u = r && r[1] > r[0] ? (this.sys.e - r[0]) / (r[1] - r[0]) : 0.5;
    return colormapCss(this.spec().cmap, u);
  }

  /**
   * Loads the current member: M (x, y) rotating-pulsating pairs and M relative
   * true anomalies (increasing). The camera is left alone unless `refit`.
   */
  setTrajectory(xy: Float32Array, fRel: ArrayLike<number>, sys: ER3BPSystem, refit = false): void {
    const changed = sys.e !== this.sys.e;
    this.xy = xy;
    this.fRel = fRel;
    this.sys = sys;
    const m = fRel.length;
    if (this.xyz.length !== 3 * m) {
      this.xyz = new Float32Array(3 * m);
      for (const l of [this.ghost, this.primaryTrail, this.secondaryTrail]) {
        l.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * m), 3));
      }
      // one extra vertex for the interpolated spacecraft position
      this.orbit.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * (m + 1)), 3));
      const P = m + 3; // samples, the craft, and two nose points
      this.trailPts = new Float32Array(2 * P);
      this.trailT = new Float32Array(P);
      const index: number[] = [];
      for (let i = 0; i < P - 1; i++) index.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
      for (const r of [this.trailCore, this.trailGlow]) {
        r.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * P), 3));
        r.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(8 * P), 4));
        r.geometry.setIndex(index);
        r.frustumCulled = false;
      }
    }
    this.recompute();
    if (changed) this.focusFamily(false);
    if (refit) this.fit();
  }

  /** Family ghosts: all members of `tracks`, drawn according to `mode`. */
  setFamily(tracks: FamilyTracks | null, mode: FamilyMode): void {
    const rebuild = tracks !== this.tracks;
    this.tracks = tracks;
    this.familyMode = tracks ? mode : 'hidden';
    if (rebuild) this.rebuildFamily();
    this.family.visible = this.familyMode !== 'hidden' && !!tracks;
    this.focusFamily(true);
    this.recolour();
    this.render();
  }

  setFrame(frame: FrameId): void {
    if (frame === this.frame) return;
    this.frame = frame;
    this.recompute();
    this.rebuildFamily();
    this.fit();
  }

  setThreeD(on: boolean): void {
    this.threeD = on;
    this.controls.enableRotate = on;
    this.controls.mouseButtons = on
      ? { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
      : { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = on
      ? { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
      : { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    this.grid.visible = on;
    this.overlay.style.display = on ? 'none' : '';
    if (!on) this.fit();
    else this.render();
  }

  private spec() {
    return FRAMES.find((f) => f.id === this.frame)!;
  }

  /** Rebuilds the family geometry (positions and RGB) for the current frame; alpha comes from the highlight. */
  private rebuildFamily(): void {
    const t = this.tracks;
    if (!t) {
      this.paramRange = null;
      this.family.visible = false;
      return;
    }
    const n = t.count;
    const m = t.samples;
    let pmin = Infinity;
    let pmax = -Infinity;
    for (let i = 0; i < n; i++) {
      pmin = Math.min(pmin, t.params[i]);
      pmax = Math.max(pmax, t.params[i]);
    }
    this.paramRange = [pmin, pmax];
    if (this.alphaNow.length !== n) {
      this.alphaNow = new Float32Array(n);
      this.alphaFrom = new Float32Array(n);
      this.alphaTo = new Float32Array(n);
      this.baseAlpha = new Float32Array(n);
      this.written = new Float32Array(n);
    }
    this.written.fill(-2); // force a full write after the geometry is rebuilt
    const segs = n * (m - 1);
    const pos = new Float32Array(segs * 6);
    const col = new Float32Array(segs * 8);
    const tmp = new Float32Array(3 * m);
    const rgb = [0, 0, 0];
    const cmap = this.spec().cmap;
    let o = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
      const xy = t.positions.subarray(i * m * 2, (i + 1) * m * 2);
      const f = t.anomalies.subarray(i * m, (i + 1) * m);
      transformTrajectory(xy, f, { mu: t.mu, e: t.params[i], f0: t.f0 }, this.frame, tmp);
      const u = pmax > pmin ? (t.params[i] - pmin) / (pmax - pmin) : 0.5;
      colormap(cmap, u, rgb);
      const a = 0;
      for (let k = 0; k < m - 1; k++) {
        pos[o] = tmp[3 * k];
        pos[o + 1] = tmp[3 * k + 1];
        pos[o + 2] = 0;
        pos[o + 3] = tmp[3 * k + 3];
        pos[o + 4] = tmp[3 * k + 4];
        pos[o + 5] = 0;
        o += 6;
        col[c] = col[c + 4] = rgb[0];
        col[c + 1] = col[c + 5] = rgb[1];
        col[c + 2] = col[c + 6] = rgb[2];
        col[c + 3] = col[c + 7] = a;
        c += 8;
      }
    }
    const g = this.family.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.computeBoundingSphere();
    this.family.visible = this.familyMode !== 'hidden';
  }

  /**
   * Target alphas for the current member's neighbourhood: a Gaussian band over
   * parameter distance on top of the sparse context set, then either applied at
   * once or reached by asymmetric relaxation (fast in, slower out).
   */
  private focusFamily(immediate = false): void {
    const t = this.tracks;
    const r = this.paramRange;
    if (!t || !r) return;
    const n = t.count;
    const range = Math.max(1e-9, r[1] - r[0]);
    const sigma = NEIGHBOUR_SIGMA * range;
    const stride = Math.max(1, Math.round(n / SPARSE_COUNT));
    let current = -1;
    for (let i = 0; i < n; i++) if (t.params[i] === this.sys.e) current = i;
    for (let i = 0; i < n; i++) {
      const sparse = this.familyMode === 'family' && (i % stride === 0 || i === n - 1);
      const d = (t.params[i] - this.sys.e) / sigma;
      this.baseAlpha[i] = sparse && i !== current ? SPARSE_ALPHA : 0;
      this.alphaTo[i] = i === current ? 0 : NEIGHBOUR_PEAK * Math.exp(-d * d);
    }
    if (this.familyMode === 'hidden') {
      this.alphaTo.fill(0);
      this.baseAlpha.fill(0);
    }
    cancelAnimationFrame(this.fadeRaf);
    if (immediate || this.familyMode === 'hidden') {
      this.alphaNow.set(this.alphaTo);
      this.writeAlpha();
      return;
    }
    this.fadeLast = performance.now();
    const step = (now: number) => {
      const dt = Math.max(0, now - this.fadeLast);
      this.fadeLast = now;
      const up = 1 - Math.exp(-dt / RISE_MS);
      const down = 1 - Math.exp(-dt / DECAY_MS);
      let maxDiff = 0;
      for (let i = 0; i < n; i++) {
        const a = this.alphaNow[i];
        const b = this.alphaTo[i];
        const next = a + (b - a) * (b > a ? up : down);
        this.alphaNow[i] = next;
        maxDiff = Math.max(maxDiff, Math.abs(b - next));
      }
      if (maxDiff < 0.004) this.alphaNow.set(this.alphaTo);
      this.writeAlpha();
      this.render();
      if (maxDiff >= 0.004) this.fadeRaf = requestAnimationFrame(step);
    };
    this.fadeRaf = requestAnimationFrame(step);
  }

  /** Writes per-member alphas (context level or neighbourhood weight, whichever is larger) into the colour attribute. */
  private writeAlpha(): void {
    const t = this.tracks;
    const attr = this.family.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!t || !attr) return;
    const col = attr.array as Float32Array;
    const per = (t.samples - 1) * 8;
    let dirty = false;
    for (let i = 0; i < t.count; i++) {
      const a = Math.max(this.baseAlpha[i], this.alphaNow[i]);
      if (this.written[i] === a) continue;
      const start = i * per;
      for (let c = start + 3; c < start + per; c += 4) col[c] = a;
      this.written[i] = a;
      dirty = true;
    }
    if (dirty) attr.needsUpdate = true;
  }

  /** Recolours the current member's trail and complete orbit with its colormap colour. */
  private recolour(): void {
    const css = this.memberColor();
    (this.orbit.material as THREE.LineBasicMaterial).color.set(css);
    (this.ghost.material as THREE.LineBasicMaterial).color.set(css);
    const r = this.paramRange;
    const u = r && r[1] > r[0] ? (this.sys.e - r[0]) / (r[1] - r[0]) : 0.5;
    colormap(this.spec().cmap, u, this.memberRgb);
  }

  /** Recomputes the transformed member track and body trails for the current frame. */
  private recompute(): void {
    const m = this.fRel.length;
    if (!m) return;
    transformTrajectory(this.xy, this.fRel, this.sys, this.frame, this.xyz);
    (this.ghost.geometry.getAttribute('position') as THREE.BufferAttribute).set(this.xyz).needsUpdate = true;
    this.ghost.geometry.setDrawRange(0, m);
    this.recolour();
    const pt = this.primaryTrail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const st = this.secondaryTrail.geometry.getAttribute('position') as THREE.BufferAttribute;
    bodyTrail('primary', this.fRel, this.sys, this.frame, pt.array as Float32Array);
    bodyTrail('secondary', this.fRel, this.sys, this.frame, st.array as Float32Array);
    pt.needsUpdate = st.needsUpdate = true;
    this.primaryTrail.geometry.setDrawRange(0, m);
    this.secondaryTrail.geometry.setDrawRange(0, m);
    for (const l of [this.ghost, this.primaryTrail, this.secondaryTrail]) l.geometry.computeBoundingSphere();
    this.showAt(this.fNow);
  }

  /**
   * Draws the epoch `fRel` (relative true anomaly): the trail cut from the stored
   * track up to the bracketing sample plus an interpolated end point, the craft
   * interpolated on the same segment, and the bodies at the exact epoch.
   */
  showAt(fRel: number): void {
    const m = this.fRel.length;
    if (!m) return;
    const f = this.fRel;
    const fr = Math.max(f[0], Math.min(f[m - 1], fRel));
    this.fNow = fr;
    const k = segmentIndex(f, fr);
    const span = f[k + 1] - f[k];
    const u = span > 0 ? (fr - f[k]) / span : 0;
    const x = this.xyz[3 * k] + (this.xyz[3 * k + 3] - this.xyz[3 * k]) * u;
    const y = this.xyz[3 * k + 1] + (this.xyz[3 * k + 4] - this.xyz[3 * k + 1]) * u;

    // trail points, craft first, walking back along the orbit (wrapping, since it is periodic)
    const period = f[m - 1] - f[0];
    const L = TRAIL_FRACTION * period;
    const pts = this.trailPts;
    const tt = this.trailT;
    let n = 0;
    pts[0] = x;
    pts[1] = y;
    tt[0] = 0;
    n = 1;
    let idx = k;
    let wrapped = false;
    while (n < m) {
      const behind = (wrapped ? fr + period : fr) - f[idx];
      if (behind >= L) {
        // end the trail exactly at length L by interpolating toward this sample
        const prev = tt[n - 1] * L;
        const w = (L - prev) / Math.max(1e-12, behind - prev);
        pts[2 * n] = pts[2 * n - 2] + (this.xyz[3 * idx] - pts[2 * n - 2]) * w;
        pts[2 * n + 1] = pts[2 * n - 1] + (this.xyz[3 * idx + 1] - pts[2 * n - 1]) * w;
        tt[n] = 1;
        n++;
        break;
      }
      pts[2 * n] = this.xyz[3 * idx];
      pts[2 * n + 1] = this.xyz[3 * idx + 1];
      tt[n] = behind / L;
      n++;
      if (idx === 0) {
        if (wrapped) break;
        wrapped = true;
        idx = m - 2;
      } else idx--;
    }
    // shape the nose: two extra points on the first segment so the taper from the craft is smooth
    if (n >= 2 && tt[1] > TRAIL_NOSE) {
      for (let i = n - 1; i >= 1; i--) {
        pts[2 * (i + 2)] = pts[2 * i];
        pts[2 * (i + 2) + 1] = pts[2 * i + 1];
        tt[i + 2] = tt[i];
      }
      const seg = tt[3];
      for (let j = 1; j <= 2; j++) {
        const t = (TRAIL_NOSE * j) / 2;
        const w = t / seg;
        pts[2 * j] = pts[0] + (pts[6] - pts[0]) * w;
        pts[2 * j + 1] = pts[1] + (pts[7] - pts[1]) * w;
        tt[j] = t;
      }
      n += 2;
    }
    this.trailCount = n;
    const line = this.orbit.geometry.getAttribute('position') as THREE.BufferAttribute;
    const larr = line.array as Float32Array;
    for (let i = 0; i < n; i++) {
      larr[3 * i] = pts[2 * i];
      larr[3 * i + 1] = pts[2 * i + 1];
      larr[3 * i + 2] = 0;
    }
    line.needsUpdate = true;
    this.orbit.geometry.setDrawRange(0, n);
    this.ghost.visible = this.showGhost;

    const set = (p: THREE.Points, px: number, py: number) => {
      const a = p.geometry.getAttribute('position') as THREE.BufferAttribute;
      a.setXYZ(0, px, py, 0);
      a.needsUpdate = true;
    };
    set(this.craft, x, y);
    const fAbs = this.sys.f0 + fr;
    const tmp = new Float32Array(2);
    bodyPosition('primary', this.sys, this.frame, fAbs, tmp);
    set(this.primary, tmp[0], tmp[1]);
    bodyPosition('secondary', this.sys, this.frame, fAbs, tmp);
    set(this.secondary, tmp[0], tmp[1]);
    this.render();
  }

  /** Fits the camera to the member's orbit plus body trails, resetting any user pan or zoom. */
  fit(): void {
    const m = this.fRel.length;
    if (!m) return;
    const box = new THREE.Box3();
    for (const l of [this.ghost, this.primaryTrail, this.secondaryTrail]) {
      l.geometry.computeBoundingBox();
      if (l.geometry.boundingBox) box.union(l.geometry.boundingBox);
    }
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    const w = Math.max(size.x, 1e-6) * 1.15;
    const h = Math.max(size.y, 1e-6) * 1.15;
    const aspect = this.aspect();
    this.camera.zoom = Math.min((2 * aspect) / w, 2 / h);
    this.camera.position.set(centre.x, centre.y, 10);
    this.camera.up.set(0, 1, 0);
    this.controls.target.set(centre.x, centre.y, 0);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.userMoved = false;
    this.render();
  }

  private aspect(): number {
    const r = this.host.getBoundingClientRect();
    return Math.max(r.width, 1) / Math.max(r.height, 1);
  }

  resize(): void {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width));
    const h = Math.max(1, Math.floor(r.height));
    this.renderer.setSize(w, h, false);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.width = Math.floor(w * dpr);
    this.overlay.height = Math.floor(h * dpr);
    const aspect = w / h;
    this.camera.left = -aspect;
    this.camera.right = aspect;
    this.camera.top = 1;
    this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();
    if (!this.userMoved) this.fit();
    else this.render();
  }

  /** World rectangle visible through the axis-aligned orthographic camera. */
  private visibleRect(): { x0: number; x1: number; y0: number; y1: number } {
    const hw = (this.camera.right - this.camera.left) / (2 * this.camera.zoom);
    const hh = (this.camera.top - this.camera.bottom) / (2 * this.camera.zoom);
    const cx = this.camera.position.x;
    const cy = this.camera.position.y;
    return { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
  }

  /** World units per CSS pixel through the orthographic camera. */
  private pixelSize(): number {
    const w = Math.max(1, this.host.getBoundingClientRect().width);
    return (this.camera.right - this.camera.left) / (this.camera.zoom * w);
  }

  /** Lays the trail ribbons out from the trail points at the current zoom: width and alpha taper along the trail. */
  private layoutRibbon(): void {
    const n = this.trailCount;
    const px = this.pixelSize();
    const [r, g, b] = this.memberRgb;
    for (const [mesh, widthPx, alphaScale] of [
      [this.trailCore, TRAIL_CORE_PX, 1],
      [this.trailGlow, TRAIL_GLOW_PX, 0.32],
    ] as [THREE.Mesh, number, number][]) {
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!pos || !col || n < 2) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      const P = pos.array as Float32Array;
      const C = col.array as Float32Array;
      const pts = this.trailPts;
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(n - 1, i + 1);
        let tx = pts[2 * i1] - pts[2 * i0];
        let ty = pts[2 * i1 + 1] - pts[2 * i0 + 1];
        const len = Math.hypot(tx, ty) || 1;
        tx /= len;
        ty /= len;
        const t = this.trailT[i];
        const nose = t < TRAIL_NOSE ? 1 - Math.pow(1 - t / TRAIL_NOSE, 2) : 1; // pointed at the craft
        const taper = Math.pow(1 - t, 0.8) * nose;
        const half = 0.5 * widthPx * px * taper;
        const nx = -ty * half;
        const ny = tx * half;
        const x = pts[2 * i];
        const y = pts[2 * i + 1];
        P[6 * i] = x + nx;
        P[6 * i + 1] = y + ny;
        P[6 * i + 2] = 0;
        P[6 * i + 3] = x - nx;
        P[6 * i + 4] = y - ny;
        P[6 * i + 5] = 0;
        const a = alphaScale * Math.pow(1 - t, 1.6);
        C[8 * i] = C[8 * i + 4] = r;
        C[8 * i + 1] = C[8 * i + 5] = g;
        C[8 * i + 2] = C[8 * i + 6] = b;
        C[8 * i + 3] = C[8 * i + 7] = a;
      }
      pos.needsUpdate = col.needsUpdate = true;
      mesh.geometry.setDrawRange(0, (n - 1) * 6);
    }
  }

  render(): void {
    this.layoutRibbon();
    this.renderer.render(this.scene, this.camera);
    if (!this.threeD) this.drawOverlay();
  }

  /** Grid, ticks, axis titles, frame name and colourbar, in CSS pixels on the overlay canvas. */
  private drawOverlay(): void {
    const g = this.overlay.getContext('2d');
    if (!g) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = this.overlay.width / dpr;
    const H = this.overlay.height / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const { x0, x1, y0, y1 } = this.visibleRect();
    const sx = (x: number) => ((x - x0) / (x1 - x0)) * W;
    const sy = (y: number) => H - ((y - y0) / (y1 - y0)) * H;
    const font = '12px "Helvetica Neue", Arial, sans-serif';
    g.font = font;
    g.lineWidth = 1;

    const stepX = niceStep(x1 - x0, Math.max(3, W / 110));
    const stepY = niceStep(y1 - y0, Math.max(3, H / 70));
    const decimals = (s: number) => Math.max(0, -Math.floor(Math.log10(s)));
    const dx = decimals(stepX);
    const dy = decimals(stepY);

    g.strokeStyle = this.palette.grid;
    g.fillStyle = this.palette.text;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let x = Math.ceil(x0 / stepX) * stepX; x <= x1; x += stepX) {
      const px = Math.round(sx(x)) + 0.5;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, H);
      g.stroke();
      if (px > 56) g.fillText((Math.abs(x) < 1e-12 ? 0 : x).toFixed(dx), px, H - 30);
    }
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let y = Math.ceil(y0 / stepY) * stepY; y <= y1; y += stepY) {
      const py = Math.round(sy(y)) + 0.5;
      g.beginPath();
      g.moveTo(0, py);
      g.lineTo(W, py);
      g.stroke();
      if (py < H - 40 && py > 22) g.fillText((Math.abs(y) < 1e-12 ? 0 : y).toFixed(dy), 44, py);
    }
    g.strokeStyle = this.palette.axis;
    if (x0 < 0 && x1 > 0) {
      const px = Math.round(sx(0)) + 0.5;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, H);
      g.stroke();
    }
    if (y0 < 0 && y1 > 0) {
      const py = Math.round(sy(0)) + 0.5;
      g.beginPath();
      g.moveTo(0, py);
      g.lineTo(W, py);
      g.stroke();
    }
    const spec = this.spec();
    const halo = (text: string, x: number, y: number) => {
      g.strokeStyle = this.palette.background;
      g.lineWidth = 4;
      g.lineJoin = 'round';
      g.strokeText(text, x, y);
      g.fillStyle = this.palette.text;
      g.fillText(text, x, y);
      g.lineWidth = 1;
    };
    g.font = '13px "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    if (this.showTitle) halo(spec.label, W / 2, 8);
    g.textBaseline = 'bottom';
    halo(spec.axes[0], W / 2, H - 6);
    g.save();
    g.translate(14, H / 2);
    g.rotate(-Math.PI / 2);
    g.textBaseline = 'middle';
    halo(spec.axes[1], 0, 0);
    g.restore();

    // colourbar for the family, with the highlighted band and a marker at the current member
    if (this.paramRange && this.tracks) {
      const [lo, hi] = this.paramRange;
      const bw = 8;
      const bh = Math.min(H * 0.5, 220);
      const bx = W - 46;
      const by = (H - bh) / 2;
      const grad = g.createLinearGradient(0, by + bh, 0, by);
      for (let i = 0; i <= 10; i++) grad.addColorStop(i / 10, colormapCss(spec.cmap, i / 10));
      g.fillStyle = grad;
      g.fillRect(bx, by, bw, bh);
      g.strokeStyle = this.palette.axis;
      g.strokeRect(bx + 0.5, by + 0.5, bw, bh);
      g.fillStyle = this.palette.text;
      g.font = font;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const v = lo + ((hi - lo) * i) / ticks;
        const py = by + bh - (bh * i) / ticks;
        g.fillText(v.toFixed(2), bx + bw + 5, py);
      }
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.fillText('e', bx + bw / 2, by - 4);
      if (hi > lo) {
        const py = by + bh - (bh * (this.sys.e - lo)) / (hi - lo);
        if (this.familyMode !== 'hidden') {
          const half = bh * NEIGHBOUR_SIGMA * 1.5;
          g.fillStyle = 'rgba(255,255,255,0.18)';
          g.fillRect(bx - 3, py - half, bw + 6, 2 * half);
        }
        g.fillStyle = this.palette.text;
        g.beginPath();
        g.moveTo(bx - 2, py);
        g.lineTo(bx - 8, py - 4);
        g.lineTo(bx - 8, py + 4);
        g.closePath();
        g.fill();
      }
    }
  }
}
