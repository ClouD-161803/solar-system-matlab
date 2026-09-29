/**
 * three.js scene for one trajectory in one frame, with a 2D axes overlay.
 *
 * Rendering is a pure function of a frame index: `showFrame(i)` draws the
 * state at sample i and nothing depends on wall-clock time. That is what makes
 * deterministic recording possible later.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FRAMES, type ER3BPSystem, type FrameId, bodyPosition, bodyTrail, transformTrajectory } from './frames';

export interface Palette {
  background: string;
  orbit: string;
  ghost: string;
  primary: string;
  secondary: string;
  grid: string;
  axis: string;
  text: string;
}

export const DARK: Palette = {
  background: '#000000',
  orbit: '#f5a142',
  ghost: '#f5a142',
  primary: '#7fb8e6',
  secondary: '#b8b8b8',
  grid: '#1e1e1e',
  axis: '#555555',
  text: '#cfcfcf',
};

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
  const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: false });
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
  private threeD = false;

  private sys: ER3BPSystem = { mu: 0.5, e: 0, f0: 0 };
  private xy: Float32Array = new Float32Array(0);
  private fRel: Float64Array = new Float64Array(0);
  private xyz: Float32Array = new Float32Array(0);
  private index = 0;

  private orbit: THREE.Line;
  private ghost: THREE.Line;
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
    this.setThreeD(false);

    const tex = discTexture();
    this.ghost = line(this.palette.ghost, 0.25, 2);
    this.orbit = line(this.palette.orbit, 1, 2);
    this.primaryTrail = line(this.palette.primary, 0.25, 2);
    this.secondaryTrail = line(this.palette.secondary, 0.25, 2);
    this.craft = points(this.palette.orbit, 9, tex, 1);
    this.primary = points(this.palette.primary, 8, tex, 1);
    this.secondary = points(this.palette.secondary, 6, tex, 1);
    this.grid = new THREE.GridHelper(4, 16, this.palette.axis, this.palette.grid);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.visible = false;
    this.scene.add(this.grid, this.primaryTrail, this.secondaryTrail, this.ghost, this.orbit, this.primary, this.secondary, this.craft);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  dispose(): void {
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }

  get sampleCount(): number {
    return this.fRel.length;
  }

  get frameIndex(): number {
    return this.index;
  }

  get system(): ER3BPSystem {
    return this.sys;
  }

  /** True anomaly relative to f0 at the current sample. */
  get fRelative(): number {
    return this.fRel.length ? this.fRel[this.index] : 0;
  }

  /**
   * Loads a rotating-pulsating trajectory: M (x, y) pairs and M relative true anomalies.
   * The camera is left where it is unless `refit` is set, so sweeping a parameter
   * slider keeps a steady view; callers fit explicitly on dataset changes.
   */
  setTrajectory(xy: Float32Array, fRel: Float64Array, sys: ER3BPSystem, refit = false): void {
    this.xy = xy;
    this.fRel = fRel;
    this.sys = sys;
    const m = fRel.length;
    if (this.xyz.length !== 3 * m) {
      this.xyz = new Float32Array(3 * m);
      for (const l of [this.orbit, this.ghost, this.primaryTrail, this.secondaryTrail]) {
        l.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * m), 3));
      }
    }
    this.index = Math.min(this.index, m - 1);
    this.recompute();
    if (refit) this.fit();
  }

  setFrame(frame: FrameId): void {
    if (frame === this.frame) return;
    this.frame = frame;
    this.recompute();
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
    if (this.grid) this.grid.visible = on;
    this.overlay.style.display = on ? 'none' : '';
    if (!on) this.fit();
    else this.render();
  }

  /** Recomputes the transformed trajectory and body trails for the current frame. */
  private recompute(): void {
    const m = this.fRel.length;
    if (!m) return;
    transformTrajectory(this.xy, this.fRel, this.sys, this.frame, this.xyz);
    (this.orbit.geometry.getAttribute('position') as THREE.BufferAttribute).set(this.xyz).needsUpdate = true;
    (this.ghost.geometry.getAttribute('position') as THREE.BufferAttribute).set(this.xyz).needsUpdate = true;
    this.ghost.geometry.setDrawRange(0, m);
    const pt = this.primaryTrail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const st = this.secondaryTrail.geometry.getAttribute('position') as THREE.BufferAttribute;
    bodyTrail('primary', this.fRel, this.sys, this.frame, pt.array as Float32Array);
    bodyTrail('secondary', this.fRel, this.sys, this.frame, st.array as Float32Array);
    pt.needsUpdate = st.needsUpdate = true;
    this.primaryTrail.geometry.setDrawRange(0, m);
    this.secondaryTrail.geometry.setDrawRange(0, m);
    for (const l of [this.orbit, this.ghost, this.primaryTrail, this.secondaryTrail]) l.geometry.computeBoundingSphere();
    this.showFrame(this.index);
  }

  /** Draws sample i: orbit up to i, bodies and craft at i. Pure in i. */
  showFrame(i: number): void {
    const m = this.fRel.length;
    if (!m) return;
    this.index = Math.max(0, Math.min(m - 1, Math.round(i)));
    this.orbit.geometry.setDrawRange(0, this.index + 1);
    this.ghost.visible = this.showGhost;
    const f = this.sys.f0 + this.fRel[this.index];
    const set = (p: THREE.Points, x: number, y: number) => {
      const a = p.geometry.getAttribute('position') as THREE.BufferAttribute;
      a.setXYZ(0, x, y, 0);
      a.needsUpdate = true;
    };
    set(this.craft, this.xyz[3 * this.index], this.xyz[3 * this.index + 1]);
    const tmp = new Float32Array(2);
    bodyPosition('primary', this.sys, this.frame, f, tmp);
    set(this.primary, tmp[0], tmp[1]);
    bodyPosition('secondary', this.sys, this.frame, f, tmp);
    set(this.secondary, tmp[0], tmp[1]);
    this.render();
  }

  /** Fits the camera to the whole trajectory plus body trails, resetting any user pan or zoom. */
  fit(): void {
    const m = this.fRel.length;
    if (!m) return;
    const box = new THREE.Box3();
    for (const l of [this.orbit, this.ghost, this.primaryTrail, this.secondaryTrail]) {
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

  render(): void {
    this.renderer.render(this.scene, this.camera);
    if (!this.threeD) this.drawOverlay();
  }

  /** Grid, ticks, axis titles and the frame name, drawn in CSS pixels on the overlay canvas. */
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
      if (px > 56) g.fillText((Math.abs(x) < 1e-12 ? 0 : x).toFixed(dx), px, H - 30); // keep clear of the y labels
    }
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let y = Math.ceil(y0 / stepY) * stepY; y <= y1; y += stepY) {
      const py = Math.round(sy(y)) + 0.5;
      g.beginPath();
      g.moveTo(0, py);
      g.lineTo(W, py);
      g.stroke();
      if (py < H - 40 && py > 22) g.fillText((Math.abs(y) < 1e-12 ? 0 : y).toFixed(dy), 44, py); // keep clear of the x labels and title
    }
    // axis lines through the origin
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
    // titles
    const spec = FRAMES.find((f) => f.id === this.frame)!;
    g.fillStyle = this.palette.text;
    g.font = '13px "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillText(spec.label, W / 2, 8);
    g.textBaseline = 'bottom';
    g.fillText(spec.axes[0], W / 2, H - 6);
    g.save();
    g.translate(14, H / 2);
    g.rotate(-Math.PI / 2);
    g.textBaseline = 'middle';
    g.fillText(spec.axes[1], 0, 0);
    g.restore();
  }
}
