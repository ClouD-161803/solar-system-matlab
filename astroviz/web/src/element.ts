/**
 * <astro-viewer>: the embeddable web component.
 *
 * Attributes:
 *   data    "#id" of an embedded script tag, or a URL to a sidecar container
 *   title   page title shown in the header; also keys the remembered layout
 *   layout  JSON of a saved layout (tree, panels with frame and branch, family)
 *   frames  space-separated frame ids to open at start when no layout is given
 *   kiosk   hide all controls and autoplay (for embedding in a slide)
 *
 * Panels tile the stage as a binary split tree (see layout.ts). Drag a frame
 * chip onto a panel's edge to split it there, onto its centre to replace it;
 * drag a panel by its header to move it; drag the gutters to resize. Each
 * panel owns its frame and its family branch, so periapsis and apoapsis can
 * sit side by side. The eccentricity slider, the family tabs, the clock and
 * playback are shared; every panel shows its branch's member nearest the
 * slider's eccentricity. The layout is remembered in the browser.
 */

import { Container, type DatasetRecord, loadContainer } from './container';
import { FRAMES, type ER3BPSystem, type FrameId, elapsedTime, trueAnomalyFromTime } from './frames';
import {
  type DropZone,
  type LayoutNode,
  hasPanel,
  isLayoutNode,
  panelAreas,
  panelIds,
  removePanel,
  setRatio,
  splitAt,
  zoneFor,
} from './layout';
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

interface Panel {
  id: string;
  frame: FrameId;
  branch: string;
  host: HTMLDivElement;
  body: HTMLDivElement;
  title: HTMLSpanElement;
  meta: HTMLSpanElement;
  branchSeg: Seg<string>;
  drop: HTMLDivElement;
  viewer: OrbitViewer;
  tracks: FamilyTracks | null;
  member: number;
  sys: ER3BPSystem;
  fRel: Float32Array;
  period: number;
  tauPeriod: number;
}

interface SavedLayout {
  version: 1;
  group: string;
  e: number;
  tree: LayoutNode | null;
  panels: Record<string, { frame: FrameId; branch: string }>;
}

type DragPayload = { kind: 'frame'; frame: FrameId } | { kind: 'panel'; id: string };

/** Frames per revolution for the readout and keyboard stepping; matches the reference tool's 400 frames. */
const STEPS_PER_REV = 400;
/** At speed 1 a revolution takes this many display frames (four times slower than one frame per step). */
const SLOWDOWN = 4;
const MAX_PANELS = 8;
const BRANCHES = ['periapsis', 'apoapsis'];

const STYLE = `
:host { display: block; position: relative; background: #000; color: #d8d8d8;
  font: 13px/1.4 "Helvetica Neue", Arial, sans-serif; overflow: hidden; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.root { position: absolute; inset: 0; display: grid; grid-template-rows: auto auto 1fr auto; }
.root.kiosk { grid-template-rows: 1fr; }
.root.kiosk header, .root.kiosk .controls, .root.kiosk footer, .root.kiosk .phead { display: none; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 18px; padding: 10px 14px 4px; }
header h1 { font-size: 17px; font-weight: 600; margin: 0; letter-spacing: 0.01em; }
header .caption { color: #9a9a9a; font-variant-numeric: tabular-nums; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 6px 14px 8px; }
.seg { display: inline-flex; border: 1px solid #333; border-radius: 6px; overflow: hidden; }
.seg button { background: #0d0d0d; color: #bbb; border: 0; padding: 5px 11px; cursor: pointer; font: inherit; }
.seg button + button { border-left: 1px solid #333; }
.seg button[aria-pressed="true"] { background: #2b2b2b; color: #fff; }
.seg.mini button { padding: 1px 7px; font-size: 11px; }
.seg button:hover { color: #fff; }
label.field { display: inline-flex; align-items: center; gap: 8px; }
label.field span.k { color: #9a9a9a; }
input[type=range] { accent-color: #E69F00; width: 220px; }
input[type=range].scrub { flex: 1; min-width: 160px; width: auto; }
.chips { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chips .k { color: #9a9a9a; margin-right: 2px; }
.chip { display: inline-flex; align-items: center; gap: 6px; background: #0d0d0d; color: #ccc; border: 1px solid #333;
  border-radius: 6px; padding: 4px 10px 4px 8px; cursor: grab; user-select: none; touch-action: none; }
.chip:hover { color: #fff; border-color: #666; }
.chip .grip { color: #555; font-size: 11px; letter-spacing: -2px; }
.chip .n { min-width: 16px; text-align: center; font-size: 11px; color: #ffd9a8; background: #3a2a14; border-radius: 8px; padding: 0 5px; }
.chip .n:empty { display: none; }
.stage { position: relative; min-height: 120px; background: #141414; display: flex; }
.stage > .split, .stage > .panel { flex: 1 1 0; }
.split { display: flex; min-width: 0; min-height: 0; }
.split.row { flex-direction: row; }
.split.col { flex-direction: column; }
.gutter { flex: 0 0 6px; background: #141414; touch-action: none; }
.split.row > .gutter { cursor: col-resize; }
.split.col > .gutter { cursor: row-resize; }
.gutter:hover, .gutter.active { background: #3a2a14; }
.panel { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: #000; }
.phead { display: flex; align-items: center; gap: 8px; padding: 3px 8px; background: #0a0a0a; border-bottom: 1px solid #1a1a1a;
  cursor: grab; user-select: none; touch-action: none; font-size: 12px; white-space: nowrap; min-width: 0; }
.phead .t { font-weight: 600; color: #ddd; flex: 0 1 auto; min-width: 3em; overflow: hidden; text-overflow: ellipsis; }
.phead .m { color: #8a8a8a; font-variant-numeric: tabular-nums; flex: 0 10 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.phead .sp { flex: 1 0 0; }
.phead .seg, .phead .x { flex: 0 0 auto; }
.phead .x { background: none; border: 0; color: #777; cursor: pointer; font: inherit; font-size: 14px; padding: 0 4px; }
.phead .x:hover { color: #fff; }
.phead .home { display: inline-flex; align-items: center; }
.pbody { position: relative; flex: 1 1 0; min-height: 0; }
.drop { position: absolute; inset: 0; background: rgba(230,159,0,0.18); border: 2px solid rgba(230,159,0,0.7); pointer-events: none; z-index: 2; }
.drop.centre { background: rgba(86,180,233,0.16); border-color: rgba(86,180,233,0.7); }
.ghostchip { position: fixed; z-index: 10; pointer-events: none; background: #2b2b2b; color: #fff; border: 1px solid #666;
  border-radius: 6px; padding: 4px 10px; font-size: 12px; transform: translate(12px, 12px); }
.hint { flex: 1; display: grid; place-items: center; color: #777; background: #000; }
.hint.over { color: #ffd9a8; background: #120d05; }
footer { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; padding: 8px 14px 10px; border-top: 1px solid #1a1a1a; }
footer button { background: #0d0d0d; color: #ddd; border: 1px solid #333; border-radius: 6px; padding: 5px 12px; cursor: pointer; font: inherit; min-width: 68px; }
footer button:hover { border-color: #666; color: #fff; }
.readout { color: #bbb; font-variant-numeric: tabular-nums; white-space: nowrap; }
.fps { color: #8a8a8a; font-variant-numeric: tabular-nums; min-width: 5.5em; text-align: right; }
.legend { display: inline-flex; gap: 10px; color: #9a9a9a; }
.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
select { background: #0d0d0d; color: #ddd; border: 1px solid #333; border-radius: 6px; padding: 4px 6px; font: inherit; }
.check { display: inline-flex; align-items: center; gap: 5px; color: #bbb; cursor: pointer; }
.check input { accent-color: #E69F00; }
.status { position: absolute; inset: 0; display: grid; place-items: center; color: #888; }
.warn { color: #e0a24a; }
`;

interface Seg<T extends string> {
  el: HTMLDivElement;
  set(id: T): void;
}

function seg<T extends string>(items: { id: T; label: string }[], onPick: (id: T) => void, cls = 'seg'): Seg<T> {
  const el = document.createElement('div');
  el.className = cls;
  const buttons = new Map<T, HTMLButtonElement>();
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    b.addEventListener('click', () => onPick(it.id));
    buttons.set(it.id, b);
    el.appendChild(b);
  }
  return {
    el,
    set(id: T) {
      for (const [k, b] of buttons) b.setAttribute('aria-pressed', String(k === id));
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

function frameLabel(f: FrameId): string {
  return FRAMES.find((s) => s.id === f)?.label ?? f;
}

export class AstroViewerElement extends HTMLElement {
  private container: Container | null = null;
  private families: FamilyDataset[] = [];
  private groups: string[] = [];
  private group = '';
  private e = 0; // shared target eccentricity; each panel snaps to its branch's nearest member
  private eStep = 0.005;
  private eMax = 1;
  private playing = false;
  private speed = 1;
  private spacing: Spacing = 'anomaly';
  private readonly ghostMode: FamilyMode = 'family';
  private progress = 0;
  private raf = 0;
  private showGhost = true;
  private threeD = false;
  private fpsEma = 0;
  private lastTick = 0;
  private kiosk = false;

  private tree: LayoutNode | null = null;
  private panels = new Map<string, Panel>();
  private nextId = 1;
  private tracksCache = new Map<string, FamilyTracks>();

  private root!: HTMLDivElement;
  private titleEl!: HTMLHeadingElement;
  private captionEl!: HTMLSpanElement;
  private groupSeg!: Seg<string>;
  private chips = new Map<FrameId, HTMLSpanElement>();
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
    this.kiosk = this.hasAttribute('kiosk');
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    this.root = document.createElement('div');
    this.root.className = this.kiosk ? 'root kiosk' : 'root';
    root.appendChild(this.root);

    const header = document.createElement('header');
    this.titleEl = document.createElement('h1');
    this.titleEl.textContent = this.getAttribute('title') ?? '';
    this.captionEl = document.createElement('span');
    this.captionEl.className = 'caption';
    header.append(this.titleEl, this.captionEl);

    const controls = document.createElement('div');
    controls.className = 'controls';
    this.groupSeg = seg<string>([], () => undefined);
    const sliderField = document.createElement('label');
    sliderField.className = 'field';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = 'e';
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.addEventListener('input', () => this.setE(Number(this.slider.value)));
    this.sliderOut = document.createElement('span');
    sliderField.append(k, this.slider, this.sliderOut);
    const chips = document.createElement('div');
    chips.className = 'chips';
    const ck = document.createElement('span');
    ck.className = 'k';
    ck.textContent = 'frames';
    chips.appendChild(ck);
    for (const f of FRAMES) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = 'drag onto a panel to split it there or replace it; click to add';
      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.textContent = '⠇';
      const n = document.createElement('span');
      n.className = 'n';
      chip.append(grip, document.createTextNode(f.label), n);
      chip.addEventListener('pointerdown', (ev) => this.startDrag(ev, { kind: 'frame', frame: f.id }, chip));
      this.chips.set(f.id, chip);
      chips.appendChild(chip);
    }
    controls.append(this.groupSeg.el, sliderField, chips);

    this.stage = document.createElement('div');
    this.stage.className = 'stage';
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'status';
    this.statusEl.textContent = 'loading…';
    this.hint = document.createElement('div');
    this.hint.className = 'hint';
    this.hint.textContent = 'drag a frame here';
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
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'reset layout';
    reset.addEventListener('click', () => {
      this.forget();
      this.applyDefaultLayout();
    });
    this.readout = document.createElement('span');
    this.readout.className = 'readout';
    this.fpsEl = document.createElement('span');
    this.fpsEl.className = 'fps';
    this.fpsEl.textContent = '— fps';
    const legend = document.createElement('span');
    legend.className = 'legend';
    for (const [css, label] of [
      ['#F0E442', 'spacecraft'],
      ['#56B4E9', 'm₁'],
      ['#A8A8A8', 'm₂'],
    ]) {
      const item = document.createElement('span');
      const dot = document.createElement('i');
      dot.style.background = css;
      item.append(dot, document.createTextNode(label));
      legend.appendChild(item);
    }
    footer.append(this.playBtn, this.scrub, speed, spacing, ghost, threeD, reset, legend, this.readout, this.fpsEl);

    this.root.append(header, controls, this.stage, footer);

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

  // ---- data ---------------------------------------------------------------

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
    const saved = this.kiosk ? null : this.recall();
    const fromAttr = this.parseLayout(this.getAttribute('layout'));
    const layout = saved ?? fromAttr;
    if (layout && this.groups.includes(layout.group)) {
      this.group = layout.group;
      this.groupSeg.set(this.group);
      this.rangeForGroup();
      this.e = Math.min(layout.e, this.eMax);
      this.restore(layout);
    } else {
      if (this.groups.length) {
        this.group = this.groups[0];
        this.groupSeg.set(this.group);
        this.rangeForGroup();
      }
      this.applyDefaultLayout();
    }
    if (this.kiosk) this.play();
  }

  private branchDataset(branch: string): FamilyDataset | undefined {
    return this.families.find((d) => d.group === this.group && d.branch === branch);
  }

  private tracksFor(d: FamilyDataset): FamilyTracks {
    let t = this.tracksCache.get(d.id);
    if (t) return t;
    const c = this.container!;
    const info = c.viewInfo(d.positions.view);
    t = {
      count: info.shape[0],
      samples: info.shape[1],
      positions: c.f32(d.positions.view),
      anomalies: c.f32(d.independent_variable.view),
      params: c.f64(d.parameter.view),
      mu: d.system.mu,
      f0: d.system.f0,
    };
    this.tracksCache.set(d.id, t);
    return t;
  }

  /** Slider range and step from the union of the group's branches. */
  private rangeForGroup(): void {
    let max = 0;
    let step = Infinity;
    for (const d of this.families.filter((d) => d.group === this.group)) {
      const p = this.tracksFor(d).params;
      max = Math.max(max, p[p.length - 1]);
      for (let i = 1; i < p.length; i++) step = Math.min(step, Math.abs(p[i] - p[i - 1]));
    }
    this.eMax = max;
    this.eStep = Number.isFinite(step) && step > 0 ? step : 0.005;
    this.slider.max = String(this.eMax);
    this.slider.step = String(this.eStep);
    this.e = Math.min(this.e, this.eMax);
  }

  private setGroup(g: string): void {
    this.group = g;
    this.groupSeg.set(g);
    this.rangeForGroup();
    for (const p of this.panels.values()) this.loadPanel(p, true);
    this.drawAll();
    this.updateCaption();
    this.remember();
  }

  private setE(e: number): void {
    this.e = Math.max(0, Math.min(this.eMax, e));
    for (const p of this.panels.values()) this.loadPanel(p, false);
    this.drawAll();
    this.updateCaption();
    this.remember();
  }

  /** Points a panel at its branch's member nearest the shared eccentricity. */
  private loadPanel(p: Panel, refit: boolean): void {
    const d = this.branchDataset(p.branch);
    if (!d) {
      p.tracks = null;
      p.fRel = new Float32Array(0);
      p.meta.textContent = 'no data';
      return;
    }
    const t = this.tracksFor(d);
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < t.count; i++) {
      const dd = Math.abs(t.params[i] - this.e);
      if (dd < best) {
        best = dd;
        idx = i;
      }
    }
    const m = t.samples;
    const changedTracks = p.tracks !== t;
    p.tracks = t;
    p.member = idx;
    const xy = t.positions.subarray(idx * m * 2, (idx + 1) * m * 2);
    p.fRel = d.independent_variable.per_member ? t.anomalies.subarray(idx * m, (idx + 1) * m) : t.anomalies.subarray(0, m);
    p.sys = { mu: t.mu, e: t.params[idx], f0: t.f0 };
    p.period = p.fRel[m - 1];
    p.tauPeriod = elapsedTime(p.sys.e, p.sys.f0, p.sys.f0 + p.period);
    if (changedTracks) p.viewer.setFamily(t, this.ghostMode);
    p.viewer.setTrajectory(xy, p.fRel, p.sys, refit);
    let warn = '';
    if (d.closure_error) {
      const ce = this.container!.f32(d.closure_error.view)[idx];
      if (ce > 1e-4) warn = ` · closure ${ce.toExponential(1)}`;
    }
    p.meta.textContent = `e = ${p.sys.e.toFixed(4)}${warn}`;
    p.meta.classList.toggle('warn', warn !== '');
  }

  // ---- panels and layout --------------------------------------------------

  private createPanel(frame: FrameId, branch: string, id?: string): Panel {
    const pid = id ?? `p${this.nextId++}`;
    const num = Number(pid.slice(1));
    if (Number.isFinite(num) && num >= this.nextId) this.nextId = num + 1;
    const host = document.createElement('div');
    host.className = 'panel';
    host.dataset.id = pid;
    const head = document.createElement('div');
    head.className = 'phead';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = frameLabel(frame);
    const meta = document.createElement('span');
    meta.className = 'm';
    const sp = document.createElement('span');
    sp.className = 'sp';
    const branchSeg = seg<string>(
      [
        { id: 'periapsis', label: 'peri' },
        { id: 'apoapsis', label: 'apo' },
      ],
      (b) => {
        const p = this.panels.get(pid);
        if (!p) return;
        p.branch = b;
        p.branchSeg.set(b);
        this.loadPanel(p, false);
        this.drawAll();
        this.updateCaption();
        this.remember();
      },
      'seg mini',
    );
    branchSeg.set(branch);
    const home = document.createElement('button');
    home.className = 'x home';
    home.type = 'button';
    home.title = 'reset the view';
    home.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2.2 1.8 7.6h1.7V13.5h3.3V9.7h2.4v3.8h3.3V7.6h1.7z" fill="currentColor"/></svg>';
    home.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    home.addEventListener('click', () => this.panels.get(pid)?.viewer.fit());
    const close = document.createElement('button');
    close.className = 'x';
    close.type = 'button';
    close.title = 'close panel';
    close.textContent = '×';
    close.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    close.addEventListener('click', () => this.closePanel(pid));
    head.append(title, meta, sp, branchSeg.el, home, close);
    head.addEventListener('pointerdown', (ev) => this.startDrag(ev, { kind: 'panel', id: pid }, head));
    const body = document.createElement('div');
    body.className = 'pbody';
    const drop = document.createElement('div');
    drop.className = 'drop';
    drop.hidden = true;
    host.append(head, body);
    const viewer = new OrbitViewer(body, frame);
    body.appendChild(drop); // above the canvases
    viewer.showGhost = this.showGhost;
    viewer.setThreeD(this.threeD);
    const p: Panel = {
      id: pid,
      frame,
      branch,
      host,
      body,
      title,
      meta,
      branchSeg,
      drop,
      viewer,
      tracks: null,
      member: 0,
      sys: { mu: 0.5, e: 0, f0: 0 },
      fRel: new Float32Array(0),
      period: 0,
      tauPeriod: 0,
    };
    this.panels.set(pid, p);
    this.loadPanel(p, true);
    return p;
  }

  private destroyPanel(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    p.viewer.dispose();
    p.host.remove();
    this.panels.delete(id);
  }

  private closePanel(id: string): void {
    if (!this.tree) return;
    this.tree = removePanel(this.tree, id);
    this.destroyPanel(id);
    this.renderLayout();
    this.remember();
  }

  /** Adds a panel by splitting the largest panel along its longer side (or filling an empty stage). */
  private addPanel(frame: FrameId, branch?: string): void {
    if (this.panels.size >= MAX_PANELS) return;
    const b = branch ?? this.defaultBranch();
    if (!this.tree) {
      const p = this.createPanel(frame, b);
      this.tree = { kind: 'panel', id: p.id };
    } else {
      const target = panelAreas(this.tree).sort((x, y) => y.area - x.area)[0];
      const tp = this.panels.get(target.id)!;
      const r = tp.host.getBoundingClientRect();
      const p = this.createPanel(frame, b);
      this.tree = splitAt(this.tree, target.id, p.id, r.width >= r.height ? 'right' : 'bottom');
    }
    this.renderLayout();
    this.drawAll();
    this.remember();
  }

  private defaultBranch(): string {
    const last = [...this.panels.values()].pop();
    return last?.branch ?? BRANCHES[0];
  }

  /** Places a new or existing panel relative to `targetId` in `zone`. */
  private dropOn(targetId: string, zone: DropZone, payload: DragPayload): void {
    if (!this.tree) return;
    if (payload.kind === 'panel') {
      if (payload.id === targetId) return;
      if (zone === 'centre') {
        // swap frame and branch between the two panels
        const a = this.panels.get(payload.id)!;
        const b = this.panels.get(targetId)!;
        [a.frame, b.frame] = [b.frame, a.frame];
        [a.branch, b.branch] = [b.branch, a.branch];
        for (const p of [a, b]) {
          p.viewer.setFrame(p.frame);
          p.title.textContent = frameLabel(p.frame);
          p.branchSeg.set(p.branch);
          this.loadPanel(p, true);
        }
      } else {
        this.tree = removePanel(this.tree, payload.id) ?? this.tree;
        this.tree = splitAt(this.tree, targetId, payload.id, zone);
      }
    } else if (zone === 'centre') {
      const p = this.panels.get(targetId)!;
      p.frame = payload.frame;
      p.viewer.setFrame(p.frame);
      p.title.textContent = frameLabel(p.frame);
      this.loadPanel(p, true);
    } else {
      if (this.panels.size >= MAX_PANELS) return;
      const p = this.createPanel(payload.frame, this.panels.get(targetId)!.branch);
      this.tree = splitAt(this.tree, targetId, p.id, zone);
    }
    this.renderLayout();
    this.drawAll();
    this.remember();
  }

  /** Rebuilds the stage DOM from the tree; panel hosts are re-parented, not recreated. */
  private renderLayout(): void {
    for (const el of [...this.stage.children]) if (el !== this.hint) el.remove();
    this.hint.hidden = !!this.tree;
    if (this.tree) this.stage.appendChild(this.build(this.tree));
    for (const p of this.panels.values()) p.viewer.resize();
    const counts = new Map<FrameId, number>();
    for (const p of this.panels.values()) counts.set(p.frame, (counts.get(p.frame) ?? 0) + 1);
    for (const [f, chip] of this.chips) chip.querySelector('.n')!.textContent = counts.get(f) ? String(counts.get(f)) : '';
    this.updateCaption();
  }

  private build(node: LayoutNode): HTMLElement {
    if (node.kind === 'panel') {
      const p = this.panels.get(node.id);
      if (!p) throw new Error(`layout references unknown panel ${node.id}`);
      p.host.style.flex = '';
      return p.host;
    }
    const el = document.createElement('div');
    el.className = `split ${node.dir}`;
    const a = this.build(node.a);
    const b = this.build(node.b);
    a.style.flex = `${node.ratio} 1 0`;
    b.style.flex = `${1 - node.ratio} 1 0`;
    const g = document.createElement('div');
    g.className = 'gutter';
    g.addEventListener('pointerdown', (ev) => this.startResize(ev, node, el, a, b, g));
    el.append(a, g, b);
    return el;
  }

  private startResize(ev: PointerEvent, node: LayoutNode, el: HTMLElement, a: HTMLElement, b: HTMLElement, g: HTMLElement): void {
    if (node.kind !== 'split') return;
    ev.preventDefault();
    g.classList.add('active');
    g.setPointerCapture(ev.pointerId);
    let ratio = node.ratio;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      ratio = node.dir === 'row' ? (e.clientX - r.left) / Math.max(1, r.width) : (e.clientY - r.top) / Math.max(1, r.height);
      ratio = Math.max(0.1, Math.min(0.9, ratio));
      a.style.flex = `${ratio} 1 0`;
      b.style.flex = `${1 - ratio} 1 0`;
    };
    const up = () => {
      g.classList.remove('active');
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      if (this.tree) this.tree = setRatio(this.tree, node, ratio);
      for (const p of this.panels.values()) p.viewer.resize();
      this.remember();
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  }

  // ---- drag and drop (pointer events, so it also works on touch) ----------

  private startDrag(ev: PointerEvent, payload: DragPayload, source: HTMLElement): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const sx = ev.clientX;
    const sy = ev.clientY;
    let ghost: HTMLDivElement | null = null;
    let target: { id: string; zone: DropZone } | null = null;
    let overHint = false;
    const root = this.shadowRoot!;
    source.setPointerCapture(ev.pointerId);
    const clearDrop = () => {
      for (const p of this.panels.values()) p.drop.hidden = true;
      this.hint.classList.remove('over');
    };
    const move = (e: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
        ghost = document.createElement('div');
        ghost.className = 'ghostchip';
        ghost.textContent = payload.kind === 'frame' ? frameLabel(payload.frame) : frameLabel(this.panels.get(payload.id)!.frame);
        root.appendChild(ghost);
      }
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
      clearDrop();
      target = null;
      overHint = false;
      const under = root.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (under && (under === this.hint || this.hint.contains(under))) {
        overHint = true;
        this.hint.classList.add('over');
        return;
      }
      const host = under?.closest('.panel') as HTMLElement | null;
      if (!host) return;
      const id = host.dataset.id!;
      if (payload.kind === 'panel' && payload.id === id) return;
      const p = this.panels.get(id)!;
      const r = p.body.getBoundingClientRect();
      const zone = zoneFor(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
      target = { id, zone };
      const d = p.drop;
      d.hidden = false;
      d.classList.toggle('centre', zone === 'centre');
      d.style.inset =
        zone === 'left' ? '0 50% 0 0' : zone === 'right' ? '0 0 0 50%' : zone === 'top' ? '0 0 50% 0' : zone === 'bottom' ? '50% 0 0 0' : '0';
    };
    const up = () => {
      source.removeEventListener('pointermove', move);
      source.removeEventListener('pointerup', up);
      source.removeEventListener('pointercancel', up);
      clearDrop();
      const dragged = !!ghost;
      ghost?.remove();
      if (!dragged) {
        if (payload.kind === 'frame') this.addPanel(payload.frame);
        return;
      }
      if (overHint && payload.kind === 'frame' && !this.tree) this.addPanel(payload.frame);
      else if (target) this.dropOn(target.id, target.zone, payload);
    };
    source.addEventListener('pointermove', move);
    source.addEventListener('pointerup', up);
    source.addEventListener('pointercancel', up);
  }

  // ---- layouts: default, saved, attribute ---------------------------------

  private applyDefaultLayout(): void {
    for (const id of [...this.panels.keys()]) this.destroyPanel(id);
    this.tree = null;
    const initial = (this.getAttribute('frames') ?? 'rotating_pulsating').split(/[\s,]+/) as FrameId[];
    for (const f of initial) if (FRAMES.some((s) => s.id === f)) this.addPanel(f);
    this.renderLayout();
    this.drawAll();
  }

  private restore(layout: SavedLayout): void {
    for (const id of [...this.panels.keys()]) this.destroyPanel(id);
    this.tree = null;
    let tree = layout.tree;
    for (const [id, spec] of Object.entries(layout.panels)) {
      if (!tree || !hasPanel(tree, id)) continue;
      if (!FRAMES.some((s) => s.id === spec.frame)) {
        tree = removePanel(tree, id);
        continue;
      }
      this.createPanel(spec.frame, BRANCHES.includes(spec.branch) ? spec.branch : BRANCHES[0], id);
    }
    for (const id of panelIds(tree)) if (tree && !this.panels.has(id)) tree = removePanel(tree, id);
    this.tree = tree;
    if (!this.tree) {
      this.applyDefaultLayout();
      return;
    }
    this.renderLayout();
    this.drawAll();
  }

  private snapshot(): SavedLayout {
    const panels: SavedLayout['panels'] = {};
    for (const p of this.panels.values()) panels[p.id] = { frame: p.frame, branch: p.branch };
    return { version: 1, group: this.group, e: this.e, tree: this.tree, panels };
  }

  /** The current layout as JSON, usable as the `layout` attribute of an export. */
  get layoutJSON(): string {
    return JSON.stringify(this.snapshot());
  }

  private storageKey(): string {
    return `astroviz:layout:${this.getAttribute('title') ?? ''}`;
  }

  private remember(): void {
    if (this.kiosk) return;
    try {
      localStorage.setItem(this.storageKey(), this.layoutJSON);
    } catch {
      /* storage unavailable: the layout just is not remembered */
    }
  }

  private forget(): void {
    try {
      localStorage.removeItem(this.storageKey());
    } catch {
      /* ignore */
    }
  }

  private recall(): SavedLayout | null {
    try {
      return this.parseLayout(localStorage.getItem(this.storageKey()));
    } catch {
      return null;
    }
  }

  private parseLayout(text: string | null): SavedLayout | null {
    if (!text) return null;
    try {
      const v = JSON.parse(text) as Partial<SavedLayout>;
      if (v.version !== 1 || typeof v.group !== 'string' || typeof v.e !== 'number') return null;
      if (v.tree !== null && !isLayoutNode(v.tree)) return null;
      if (!v.panels || typeof v.panels !== 'object') return null;
      return v as SavedLayout;
    } catch {
      return null;
    }
  }

  // ---- drawing and readouts -----------------------------------------------

  private currentF(p: Panel): number {
    const pr = Math.max(0, Math.min(1, this.progress));
    switch (this.spacing) {
      case 'anomaly':
        return pr * p.period;
      case 'time':
        return trueAnomalyFromTime(p.sys.e, p.sys.f0, pr * p.tauPeriod) - p.sys.f0;
      case 'arclength': {
        const m = p.fRel.length;
        if (m < 2) return 0;
        const x = pr * (m - 1);
        const k = Math.min(m - 2, Math.floor(x));
        return p.fRel[k] + (p.fRel[k + 1] - p.fRel[k]) * (x - k);
      }
    }
  }

  private firstPanel(): Panel | undefined {
    const ids = panelIds(this.tree);
    return ids.length ? this.panels.get(ids[0]) : undefined;
  }

  private drawAll(): void {
    for (const p of this.panels.values()) if (p.fRel.length) p.viewer.showAt(this.currentF(p));
    this.updateReadout();
  }

  private updateCaption(): void {
    const branches = [...new Set([...this.panels.values()].map((p) => p.branch))].join(' and ');
    const mu = this.branchDataset(BRANCHES[0])?.system.mu ?? this.branchDataset(BRANCHES[1])?.system.mu;
    this.captionEl.textContent = this.group
      ? `${this.group}${branches ? `, ${branches}` : ''}, e ≈ ${this.e.toFixed(3)}${mu !== undefined ? `, μ = ${mu}` : ''}`
      : '';
    this.slider.value = String(this.e);
    this.sliderOut.textContent = this.e.toFixed(4);
  }

  private updateReadout(): void {
    const p = this.firstPanel();
    if (!p || !p.fRel.length) {
      this.readout.textContent = '';
      return;
    }
    const f = this.currentF(p);
    const tau = elapsedTime(p.sys.e, p.sys.f0, p.sys.f0 + f);
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
    if (this.playing) return;
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
      this.progress += this.speed / (STEPS_PER_REV * SLOWDOWN);
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
        this.setE(this.e + this.eStep * (ev.shiftKey ? 10 : 1));
        break;
      case 'ArrowDown':
        ev.preventDefault();
        this.setE(this.e - this.eStep * (ev.shiftKey ? 10 : 1));
        break;
    }
  }
}

export function define(tag = 'astro-viewer'): void {
  if (!customElements.get(tag)) customElements.define(tag, AstroViewerElement);
}
