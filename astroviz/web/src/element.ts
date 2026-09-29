/**
 * <astro-viewer>: the embeddable web component.
 *
 * Attributes:
 *   data    "#id" of an embedded script tag, or a URL to a sidecar container
 *   title   page title shown in the header
 *   frames  space-separated frame ids to open at start (default rotating_pulsating)
 *
 * It owns the controls (family tabs, branch toggle, parameter slider, frame
 * toggles, transport) and a grid of synchronized OrbitViewer panels, one per
 * enabled frame. Playback advances a progress fraction through one period and
 * maps it to a true anomaly by the chosen spacing (true anomaly, time, or
 * on-screen arclength); every panel draws showAt(f).
 *
 * Camera policy: a panel is fitted when it is created and when the family
 * changes. Moving the parameter slider or switching branch never moves the
 * camera, so the eye can follow how the orbit deforms.
 */

import { Container, type DatasetRecord, loadContainer } from './container';
import { FRAMES, type ER3BPSystem, type FrameId, elapsedTime, trueAnomalyFromTime } from './frames';
import { type FamilyMode, type FamilyTracks, OrbitViewer } from './viewer';

interface FamilyDataset extends DatasetRecord {
  kind: 'periodic_orbit_family';
  group: string;
  branch: string;
  system: { model: string; mu: number; f0: number; primary: string; secondary: string };
  independent_variable: { symbol: string; view: string; per_member?: boolean };
  parameter: { name: string; symbol: string; view: string };
  positions: { view: string };
  closure_error?: { view: string };
}

type Spacing = 'anomaly' | 'time' | 'arclength';

/** Playback steps per revolution at speed 1; matches the reference tool's 400 frames. */
const STEPS_PER_REV = 400;

const STYLE = `
:host { display: block; position: relative; background: #000; color: #d8d8d8;
  font: 13px/1.4 "Helvetica Neue", Arial, sans-serif; overflow: hidden; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.root { position: absolute; inset: 0; display: grid; grid-template-rows: auto auto 1fr auto; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 18px; padding: 10px 14px 4px; }
header h1 { font-size: 17px; font-weight: 600; margin: 0; letter-spacing: 0.01em; }
header .caption { color: #9a9a9a; font-variant-numeric: tabular-nums; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 6px 14px 8px; }
.seg { display: inline-flex; border: 1px solid #333; border-radius: 6px; overflow: hidden; }
.seg button { background: #0d0d0d; color: #bbb; border: 0; padding: 5px 11px; cursor: pointer; font: inherit; }
.seg button + button { border-left: 1px solid #333; }
.seg button[aria-pressed="true"] { background: #2b2b2b; color: #fff; }
.seg.toggles button[aria-pressed="true"] { background: #3a2a14; color: #ffd9a8; box-shadow: inset 0 -2px 0 #E69F00; }
.seg button:hover { color: #fff; }
label.field { display: inline-flex; align-items: center; gap: 8px; }
label.field span.k { color: #9a9a9a; }
input[type=range] { accent-color: #E69F00; width: 220px; }
input[type=range].scrub { flex: 1; min-width: 160px; width: auto; }
.stage { position: relative; min-height: 120px; display: grid; gap: 2px; background: #141414; }
.panel { position: relative; background: #000; min-width: 0; min-height: 0; }
.stage .hint { position: absolute; inset: 0; display: grid; place-items: center; color: #777; background: #000; }
footer { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; padding: 8px 14px 10px; border-top: 1px solid #1a1a1a; }
footer button { background: #0d0d0d; color: #ddd; border: 1px solid #333; border-radius: 6px; padding: 5px 12px; cursor: pointer; font: inherit; min-width: 68px; }
footer button:hover { border-color: #666; color: #fff; }
.readout { color: #bbb; font-variant-numeric: tabular-nums; white-space: nowrap; }
.fps { color: #8a8a8a; font-variant-numeric: tabular-nums; min-width: 5.5em; text-align: right; }
.legend { display: inline-flex; gap: 10px; color: #9a9a9a; }
.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: 0; }
.legend i.line { width: 14px; height: 2px; border-radius: 1px; vertical-align: 2px; }
select { background: #0d0d0d; color: #ddd; border: 1px solid #333; border-radius: 6px; padding: 4px 6px; font: inherit; }
.check { display: inline-flex; align-items: center; gap: 5px; color: #bbb; cursor: pointer; }
.check input { accent-color: #E69F00; }
.status { position: absolute; inset: 0; display: grid; place-items: center; color: #888; }
.warn { color: #e0a24a; }
`;

interface Seg<T extends string> {
  el: HTMLDivElement;
  set(id: T): void;
  setPressed(id: T, on: boolean): void;
}

function seg<T extends string>(items: { id: T; label: string }[], onPick: (id: T) => void, toggles = false): Seg<T> {
  const el = document.createElement('div');
  el.className = toggles ? 'seg toggles' : 'seg';
  const buttons = new Map<T, HTMLButtonElement>();
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => onPick(it.id));
    buttons.set(it.id, b);
    el.appendChild(b);
  }
  return {
    el,
    set(id: T) {
      for (const [k, b] of buttons) b.setAttribute('aria-pressed', String(k === id));
    },
    setPressed(id: T, on: boolean) {
      buttons.get(id)?.setAttribute('aria-pressed', String(on));
    },
  };
}

function select<T extends string>(options: { id: T; label: string }[], initial: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.label;
    if (o.id === initial) opt.selected = true;
    s.appendChild(opt);
  }
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

/** Grid columns for n panels: 1, 2, 3, 2x2, 3+2. */
function columnsFor(n: number): number {
  if (n <= 3) return Math.max(1, n);
  if (n === 4) return 2;
  return 3;
}

export class AstroViewerElement extends HTMLElement {
  private container: Container | null = null;
  private families: FamilyDataset[] = [];
  private groups: string[] = [];
  private group = '';
  private branch = 'periapsis';
  private member = 0;
  private playing = false;
  private speed = 1;
  private spacing: Spacing = 'anomaly';
  private readonly ghostMode: FamilyMode = 'family'; // neighbours plus a sparse context set, always on
  private progress = 0; // fraction of one period
  private raf = 0;
  private showGhost = true;
  private threeD = false;
  private fpsEma = 0;
  private lastTick = 0;

  // current branch and member, shared by all panels
  private tracks: FamilyTracks | null = null;
  private xy: Float32Array = new Float32Array(0);
  private fRel: Float32Array = new Float32Array(0);
  private sys: ER3BPSystem = { mu: 0.5, e: 0, f0: 0 };
  private period = 0;
  private tauPeriod = 0;

  private panels = new Map<FrameId, { host: HTMLDivElement; viewer: OrbitViewer }>();

  private titleEl!: HTMLHeadingElement;
  private captionEl!: HTMLSpanElement;
  private groupSeg!: Seg<string>;
  private branchSeg!: Seg<string>;
  private frameSeg!: Seg<FrameId>;
  private slider!: HTMLInputElement;
  private sliderOut!: HTMLSpanElement;
  private scrub!: HTMLInputElement;
  private playBtn!: HTMLButtonElement;
  private readout!: HTMLSpanElement;
  private fpsEl!: HTMLSpanElement;
  private statusEl!: HTMLDivElement;
  private stage!: HTMLDivElement;
  private hint!: HTMLDivElement;

  connectedCallback(): void {
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    const wrap = document.createElement('div');
    wrap.className = 'root';
    root.appendChild(wrap);

    const header = document.createElement('header');
    this.titleEl = document.createElement('h1');
    this.titleEl.textContent = this.getAttribute('title') ?? '';
    this.captionEl = document.createElement('span');
    this.captionEl.className = 'caption';
    header.append(this.titleEl, this.captionEl);

    const controls = document.createElement('div');
    controls.className = 'controls';
    this.groupSeg = seg<string>([], () => undefined);
    this.branchSeg = seg<string>(
      [
        { id: 'periapsis', label: 'periapsis (f₀ = 0)' },
        { id: 'apoapsis', label: 'apoapsis (f₀ = π)' },
      ],
      (b) => this.setBranch(b),
    );
    this.frameSeg = seg<FrameId>(
      FRAMES.map((f) => ({ id: f.id, label: f.label })),
      (f) => this.togglePanel(f),
      true,
    );
    const sliderField = document.createElement('label');
    sliderField.className = 'field';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = 'e';
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.step = '1';
    this.slider.addEventListener('input', () => this.setMember(Number(this.slider.value)));
    this.sliderOut = document.createElement('span');
    sliderField.append(k, this.slider, this.sliderOut);
    controls.append(this.groupSeg.el, this.branchSeg.el, sliderField, this.frameSeg.el);

    this.stage = document.createElement('div');
    this.stage.className = 'stage';
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'status';
    this.statusEl.textContent = 'loading…';
    this.hint = document.createElement('div');
    this.hint.className = 'hint';
    this.hint.textContent = 'select one or more frames above';
    this.hint.hidden = true;
    this.stage.append(this.statusEl, this.hint);

    const footer = document.createElement('footer');
    this.playBtn = document.createElement('button');
    this.playBtn.type = 'button';
    this.playBtn.textContent = 'play';
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.scrub = document.createElement('input');
    this.scrub.type = 'range';
    this.scrub.className = 'scrub';
    this.scrub.min = '0';
    this.scrub.max = '1000';
    this.scrub.step = '1';
    this.scrub.addEventListener('input', () => {
      this.pause();
      this.progress = Number(this.scrub.value) / 1000;
      this.drawAll();
    });
    const speed = select(
      [0.25, 0.5, 1, 2, 4].map((s) => ({ id: String(s), label: `${s}×` })),
      '1',
      (v) => (this.speed = Number(v)),
    );
    const spacing = select<Spacing>(
      [
        { id: 'anomaly', label: 'uniform in f' },
        { id: 'time', label: 'uniform in τ' },
        { id: 'arclength', label: 'uniform in arclength' },
      ],
      this.spacing,
      (v) => {
        this.spacing = v;
        this.drawAll();
      },
    );
    const ghost = this.checkbox('full orbit', true, (on) => {
      this.showGhost = on;
      for (const p of this.panels.values()) p.viewer.showGhost = on;
      this.drawAll();
    });
    const threeD = this.checkbox('3D orbit camera', false, (on) => {
      this.threeD = on;
      for (const p of this.panels.values()) p.viewer.setThreeD(on);
    });
    const fit = document.createElement('button');
    fit.type = 'button';
    fit.textContent = 'fit';
    fit.addEventListener('click', () => this.fitAll());
    this.readout = document.createElement('span');
    this.readout.className = 'readout';
    this.fpsEl = document.createElement('span');
    this.fpsEl.className = 'fps';
    this.fpsEl.textContent = '— fps';
    const legend = document.createElement('span');
    legend.className = 'legend';
    for (const [css, label, isLine] of [
      ['#F0E442', 'spacecraft', false],
      ['#56B4E9', 'm\u2081', false],
      ['#A8A8A8', 'm\u2082', false],
    ] as [string, string, boolean][]) {
      const item = document.createElement('span');
      const dot = document.createElement('i');
      if (isLine) dot.className = 'line';
      dot.style.background = css;
      item.append(dot, document.createTextNode(label));
      legend.appendChild(item);
    }
    footer.append(this.playBtn, this.scrub, speed, spacing, ghost, threeD, fit, legend, this.readout, this.fpsEl);

    wrap.append(header, controls, this.stage, footer);

    this.tabIndex = 0;
    this.addEventListener('keydown', (ev) => this.onKey(ev));

    const source = this.getAttribute('data');
    if (!source) {
      this.statusEl.textContent = 'no data attribute';
      return;
    }
    loadContainer(source)
      .then((c) => {
        this.container = c;
        this.statusEl.remove();
        this.populate();
      })
      .catch((err: unknown) => {
        this.statusEl.textContent = `failed to load data: ${(err as Error).message}`;
      });
  }

  disconnectedCallback(): void {
    this.pause();
    for (const p of this.panels.values()) p.viewer.dispose();
    this.panels.clear();
  }

  private checkbox(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
    const l = document.createElement('label');
    l.className = 'check';
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = checked;
    c.addEventListener('change', () => onChange(c.checked));
    l.append(c, document.createTextNode(label));
    return l;
  }

  private populate(): void {
    const c = this.container!;
    this.families = c.datasets.filter((d): d is FamilyDataset => d.kind === 'periodic_orbit_family');
    this.groups = [...new Set(this.families.map((d) => d.group))];
    const gs = seg(
      this.groups.map((g) => ({ id: g, label: g.replace(/^Broucke family /, 'family ') })),
      (g) => this.setGroup(g),
    );
    this.groupSeg.el.replaceWith(gs.el);
    this.groupSeg = gs;
    if (this.groups.length) this.setGroup(this.groups[0]);
    const initial = (this.getAttribute('frames') ?? 'rotating_pulsating').split(/[\s,]+/) as FrameId[];
    for (const f of initial) if (FRAMES.some((s) => s.id === f)) this.togglePanel(f);
  }

  // ---- panels -------------------------------------------------------------

  private applyFamily(): void {
    for (const p of this.panels.values()) p.viewer.setFamily(this.tracks, this.ghostMode);
    this.drawAll();
  }

  private togglePanel(frame: FrameId): void {
    const existing = this.panels.get(frame);
    if (existing) {
      existing.viewer.dispose();
      existing.host.remove();
      this.panels.delete(frame);
      this.frameSeg.setPressed(frame, false);
    } else {
      const host = document.createElement('div');
      host.className = 'panel';
      this.stage.appendChild(host); // layout() sorts panels into FRAMES order
      const viewer = new OrbitViewer(host, frame);
      viewer.showGhost = this.showGhost;
      viewer.setThreeD(this.threeD);
      this.panels.set(frame, { host, viewer });
      this.frameSeg.setPressed(frame, true);
      if (this.fRel.length) {
        viewer.setFamily(this.tracks, this.ghostMode);
        viewer.setTrajectory(this.xy, this.fRel, this.sys, true);
        viewer.showAt(this.currentF());
      }
    }
    this.layout();
  }

  private layout(): void {
    const n = this.panels.size;
    this.hint.hidden = n > 0;
    this.stage.style.gridTemplateColumns = `repeat(${columnsFor(n)}, minmax(0, 1fr))`;
    this.stage.style.gridAutoRows = 'minmax(0, 1fr)';
    const order = FRAMES.map((f) => f.id);
    const sorted = [...this.panels.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    for (const [, p] of sorted) this.stage.appendChild(p.host);
    for (const p of this.panels.values()) p.viewer.resize();
  }

  private fitAll(): void {
    for (const p of this.panels.values()) p.viewer.fit();
  }

  /** Relative true anomaly for the current progress under the chosen spacing. */
  private currentF(): number {
    const p = Math.max(0, Math.min(1, this.progress));
    switch (this.spacing) {
      case 'anomaly':
        return p * this.period;
      case 'time':
        return trueAnomalyFromTime(this.sys.e, this.sys.f0, p * this.tauPeriod) - this.sys.f0;
      case 'arclength': {
        const m = this.fRel.length;
        const x = p * (m - 1);
        const k = Math.min(m - 2, Math.floor(x));
        return this.fRel[k] + (this.fRel[k + 1] - this.fRel[k]) * (x - k);
      }
    }
  }

  private drawAll(): void {
    const f = this.currentF();
    for (const p of this.panels.values()) p.viewer.showAt(f);
    this.updateReadout(f);
  }

  // ---- dataset selection --------------------------------------------------

  private current(): FamilyDataset | undefined {
    return this.families.find((d) => d.group === this.group && d.branch === this.branch);
  }

  private loadTracks(d: FamilyDataset): FamilyTracks {
    const c = this.container!;
    const info = c.viewInfo(d.positions.view);
    return {
      count: info.shape[0],
      samples: info.shape[1],
      positions: c.f32(d.positions.view),
      anomalies: c.f32(d.independent_variable.view),
      params: c.f64(d.parameter.view),
      mu: d.system.mu,
      f0: d.system.f0,
    };
  }

  private setGroup(g: string): void {
    this.group = g;
    this.groupSeg.set(g);
    if (!this.current()) {
      const any = this.families.find((d) => d.group === g);
      if (any) this.branch = any.branch;
    }
    this.branchSeg.set(this.branch);
    this.loadBranch();
    this.loadMember(0, { refit: true });
  }

  private setBranch(b: string): void {
    const e = this.tracks ? this.tracks.params[this.member] : 0;
    this.branch = b;
    this.branchSeg.set(b);
    this.loadBranch();
    let idx = 0;
    if (this.tracks) {
      const p = this.tracks.params;
      let best = Infinity;
      for (let i = 0; i < p.length; i++) {
        const d = Math.abs(p[i] - e);
        if (d < best) {
          best = d;
          idx = i;
        }
      }
    }
    this.loadMember(idx, { keepProgress: true });
  }

  private loadBranch(): void {
    const d = this.current();
    this.tracks = d ? this.loadTracks(d) : null;
    for (const p of this.panels.values()) p.viewer.setFamily(this.tracks, this.ghostMode);
  }

  private setMember(i: number): void {
    this.loadMember(i, { keepProgress: true });
  }

  private loadMember(i: number, opts: { keepProgress?: boolean; refit?: boolean } = {}): void {
    const d = this.current();
    const t = this.tracks;
    if (!d || !t) return;
    const m = t.samples;
    this.member = Math.max(0, Math.min(t.count - 1, i));
    this.xy = t.positions.subarray(this.member * m * 2, (this.member + 1) * m * 2);
    this.fRel = d.independent_variable.per_member
      ? t.anomalies.subarray(this.member * m, (this.member + 1) * m)
      : t.anomalies.subarray(0, m);
    this.sys = { mu: t.mu, e: t.params[this.member], f0: t.f0 };
    this.period = this.fRel[m - 1];
    this.tauPeriod = elapsedTime(this.sys.e, this.sys.f0, this.sys.f0 + this.period);
    this.slider.max = String(t.count - 1);
    this.slider.value = String(this.member);
    this.sliderOut.textContent = t.params[this.member].toFixed(4);
    if (!opts.keepProgress) this.progress = 0;
    for (const p of this.panels.values()) p.viewer.setTrajectory(this.xy, this.fRel, this.sys, !!opts.refit);
    this.drawAll();
    this.updateCaption();
  }

  // ---- readouts -----------------------------------------------------------

  private updateCaption(): void {
    const d = this.current();
    if (!d) return;
    const e = this.sys.e;
    let closure = '';
    if (d.closure_error) {
      const ce = this.container!.f32(d.closure_error.view)[this.member];
      if (ce > 1e-4) closure = ` · <span class="warn">closure error ${ce.toExponential(1)}</span>`;
    }
    this.captionEl.innerHTML =
      `${d.group} ${d.branch}, e = ${e.toFixed(3)}, μ = ${d.system.mu}, f₀ = ${d.system.f0.toFixed(d.system.f0 ? 5 : 0)}` +
      `${closure}`;
  }

  private updateReadout(f: number): void {
    if (!this.fRel.length) return;
    const tau = elapsedTime(this.sys.e, this.sys.f0, this.sys.f0 + f);
    const frame = Math.round(this.progress * STEPS_PER_REV);
    this.readout.textContent = `f − f₀ = ${f.toFixed(2)} rad τ = ${tau.toFixed(2)} TU frame ${frame}/${STEPS_PER_REV}`;
    this.scrub.value = String(Math.round(this.progress * 1000));
  }

  // ---- transport ----------------------------------------------------------

  private togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.playing || !this.fRel.length) return;
    this.playing = true;
    this.playBtn.textContent = 'pause';
    this.lastTick = 0;
    this.fpsEma = 0;
    const tick = (now: number) => {
      if (!this.playing) return;
      if (this.lastTick) {
        const inst = 1000 / Math.max(1, now - this.lastTick);
        this.fpsEma = this.fpsEma ? this.fpsEma * 0.9 + inst * 0.1 : inst;
        this.fpsEl.textContent = `${this.fpsEma.toFixed(0)} fps`;
      }
      this.lastTick = now;
      this.progress += this.speed / STEPS_PER_REV;
      if (this.progress >= 1) this.progress -= 1;
      this.drawAll();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing = false;
    this.playBtn.textContent = 'play';
    this.fpsEl.textContent = '— fps';
    cancelAnimationFrame(this.raf);
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.fRel.length) return;
    const step = (ev.shiftKey ? 10 : 1) / STEPS_PER_REV;
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        this.togglePlay();
        break;
      case 'ArrowRight':
        ev.preventDefault();
        this.pause();
        this.progress = (this.progress + step) % 1;
        this.drawAll();
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        this.pause();
        this.progress = (this.progress - step + 1) % 1;
        this.drawAll();
        break;
      case 'ArrowUp':
        ev.preventDefault();
        this.setMember(this.member + 1);
        break;
      case 'ArrowDown':
        ev.preventDefault();
        this.setMember(this.member - 1);
        break;
    }
  }
}

export function define(tag = 'astro-viewer'): void {
  if (!customElements.get(tag)) customElements.define(tag, AstroViewerElement);
}
