/**
 * <astro-viewer>: the embeddable web component.
 *
 * Attributes:
 *   data   "#id" of an embedded script tag, or a URL to a sidecar container
 *   title  page title shown in the header
 *
 * It owns the controls (family tabs, branch toggle, parameter slider, frame
 * selector, transport) and delegates drawing to OrbitViewer. Playback advances
 * a frame index per animation tick; drawing is always showFrame(index).
 */

import { Container, type DatasetRecord, loadContainer } from './container';
import { FRAMES, type FrameId, elapsedTime } from './frames';
import { OrbitViewer } from './viewer';

interface FamilyDataset extends DatasetRecord {
  kind: 'periodic_orbit_family';
  group: string;
  branch: string;
  system: { model: string; mu: number; f0: number; primary: string; secondary: string };
  independent_variable: { symbol: string; view: string };
  parameter: { name: string; symbol: string; view: string };
  positions: { view: string };
  closure_error?: { view: string };
}

const STYLE = `
:host { display: block; position: relative; background: #000; color: #d8d8d8;
  font: 13px/1.4 "Helvetica Neue", Arial, sans-serif; overflow: hidden; }
* { box-sizing: border-box; }
.root { position: absolute; inset: 0; display: grid; grid-template-rows: auto auto 1fr auto; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 18px; padding: 10px 14px 4px; }
header h1 { font-size: 17px; font-weight: 600; margin: 0; letter-spacing: 0.01em; }
header .caption { color: #9a9a9a; font-variant-numeric: tabular-nums; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 6px 14px 8px; }
.seg { display: inline-flex; border: 1px solid #333; border-radius: 6px; overflow: hidden; }
.seg button { background: #0d0d0d; color: #bbb; border: 0; padding: 5px 11px; cursor: pointer; font: inherit; }
.seg button + button { border-left: 1px solid #333; }
.seg button[aria-pressed="true"] { background: #2b2b2b; color: #fff; }
.seg button:hover { color: #fff; }
label.field { display: inline-flex; align-items: center; gap: 8px; }
label.field span.k { color: #9a9a9a; }
input[type=range] { accent-color: #f5a142; width: 220px; }
input[type=range].scrub { flex: 1; min-width: 160px; width: auto; }
.stage { position: relative; min-height: 120px; }
footer { display: flex; align-items: center; gap: 12px; padding: 8px 14px 10px; border-top: 1px solid #1a1a1a; }
footer button { background: #0d0d0d; color: #ddd; border: 1px solid #333; border-radius: 6px; padding: 5px 12px; cursor: pointer; font: inherit; min-width: 68px; }
footer button:hover { border-color: #666; color: #fff; }
.readout { color: #bbb; font-variant-numeric: tabular-nums; white-space: nowrap; }
select { background: #0d0d0d; color: #ddd; border: 1px solid #333; border-radius: 6px; padding: 4px 6px; font: inherit; }
.check { display: inline-flex; align-items: center; gap: 5px; color: #bbb; cursor: pointer; }
.check input { accent-color: #f5a142; }
.status { position: absolute; inset: 0; display: grid; place-items: center; color: #888; }
.warn { color: #e0a24a; }
`;

function seg<T extends string>(items: { id: T; label: string }[], onPick: (id: T) => void): { el: HTMLDivElement; set(id: T): void } {
  const el = document.createElement('div');
  el.className = 'seg';
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
  };
}

export class AstroViewerElement extends HTMLElement {
  private viewer: OrbitViewer | null = null;
  private container: Container | null = null;
  private families: FamilyDataset[] = [];
  private groups: string[] = [];
  private group = '';
  private branch = 'periapsis';
  private member = 0;
  private frame: FrameId = 'rotating_pulsating';
  private playing = false;
  private speed = 1;
  private cursor = 0; // fractional frame index while playing
  private raf = 0;

  // UI handles
  private titleEl!: HTMLHeadingElement;
  private captionEl!: HTMLSpanElement;
  private groupSeg!: ReturnType<typeof seg<string>>;
  private branchSeg!: ReturnType<typeof seg<string>>;
  private frameSeg!: ReturnType<typeof seg<FrameId>>;
  private slider!: HTMLInputElement;
  private sliderOut!: HTMLSpanElement;
  private scrub!: HTMLInputElement;
  private playBtn!: HTMLButtonElement;
  private readout!: HTMLSpanElement;
  private statusEl!: HTMLDivElement;

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
      (f) => this.setFrame(f),
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

    const stage = document.createElement('div');
    stage.className = 'stage';
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'status';
    this.statusEl.textContent = 'loading…';
    stage.appendChild(this.statusEl);

    const footer = document.createElement('footer');
    this.playBtn = document.createElement('button');
    this.playBtn.type = 'button';
    this.playBtn.textContent = 'play';
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.scrub = document.createElement('input');
    this.scrub.type = 'range';
    this.scrub.className = 'scrub';
    this.scrub.min = '0';
    this.scrub.step = '1';
    this.scrub.addEventListener('input', () => {
      this.pause();
      this.cursor = Number(this.scrub.value);
      this.viewer?.showFrame(this.cursor);
      this.updateReadout();
    });
    const speed = document.createElement('select');
    for (const s of [0.25, 0.5, 1, 2, 4]) {
      const o = document.createElement('option');
      o.value = String(s);
      o.textContent = `${s}×`;
      if (s === 1) o.selected = true;
      speed.appendChild(o);
    }
    speed.addEventListener('change', () => (this.speed = Number(speed.value)));
    const ghost = this.checkbox('full orbit', true, (on) => {
      if (this.viewer) {
        this.viewer.showGhost = on;
        this.viewer.showFrame(this.viewer.frameIndex);
      }
    });
    const threeD = this.checkbox('3D orbit camera', false, (on) => this.viewer?.setThreeD(on));
    const fit = document.createElement('button');
    fit.type = 'button';
    fit.textContent = 'fit';
    fit.addEventListener('click', () => this.viewer?.fit());
    this.readout = document.createElement('span');
    this.readout.className = 'readout';
    footer.append(this.playBtn, this.scrub, speed, ghost, threeD, fit, this.readout);

    wrap.append(header, controls, stage, footer);

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
        this.viewer = new OrbitViewer(stage);
        this.viewer.setFrame(this.frame);
        this.populate();
      })
      .catch((err: unknown) => {
        this.statusEl.textContent = `failed to load data: ${(err as Error).message}`;
      });
  }

  disconnectedCallback(): void {
    this.pause();
    this.viewer?.dispose();
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
  }

  private current(): FamilyDataset | undefined {
    return this.families.find((d) => d.group === this.group && d.branch === this.branch);
  }

  private setGroup(g: string): void {
    this.group = g;
    this.groupSeg.set(g);
    if (!this.current()) {
      const any = this.families.find((d) => d.group === g);
      if (any) this.branch = any.branch;
    }
    this.branchSeg.set(this.branch);
    this.loadMember(0);
  }

  private setBranch(b: string): void {
    // keep the eccentricity as close as possible across the switch
    const before = this.current();
    const e = before ? (this.container!.f64(before.parameter.view)[this.member] ?? 0) : 0;
    this.branch = b;
    this.branchSeg.set(b);
    const after = this.current();
    let idx = 0;
    if (after) {
      const p = this.container!.f64(after.parameter.view);
      let best = Infinity;
      for (let i = 0; i < p.length; i++) {
        const d = Math.abs(p[i] - e);
        if (d < best) {
          best = d;
          idx = i;
        }
      }
    }
    this.loadMember(idx);
  }

  private setFrame(f: FrameId): void {
    this.frame = f;
    this.frameSeg.set(f);
    this.viewer?.setFrame(f);
    this.updateReadout();
  }

  private setMember(i: number): void {
    this.loadMember(i, true);
  }

  private loadMember(i: number, keepCursor = false): void {
    const d = this.current();
    if (!d || !this.viewer) return;
    const c = this.container!;
    const params = c.f64(d.parameter.view);
    const fRel = c.f64(d.independent_variable.view);
    const pos = c.f32(d.positions.view);
    const info = c.viewInfo(d.positions.view);
    const m = info.shape[1];
    this.member = Math.max(0, Math.min(params.length - 1, i));
    const xy = pos.subarray(this.member * m * 2, (this.member + 1) * m * 2);
    this.slider.max = String(params.length - 1);
    this.slider.value = String(this.member);
    this.sliderOut.textContent = params[this.member].toFixed(4);
    this.scrub.max = String(m - 1);
    if (!keepCursor) this.cursor = 0;
    this.viewer.setTrajectory(xy, fRel, { mu: d.system.mu, e: params[this.member], f0: d.system.f0 });
    this.viewer.showFrame(this.cursor);
    this.scrub.value = String(Math.round(this.cursor));
    this.updateCaption();
    this.updateReadout();
  }

  private updateCaption(): void {
    const d = this.current();
    if (!d) return;
    const e = this.container!.f64(d.parameter.view)[this.member];
    let closure = '';
    if (d.closure_error) {
      const ce = this.container!.f32(d.closure_error.view)[this.member];
      if (ce > 1e-4) closure = ` · <span class="warn">closure error ${ce.toExponential(1)}</span>`;
    }
    this.captionEl.innerHTML =
      `${d.group} ${d.branch}, e = ${e.toFixed(3)}, μ = ${d.system.mu}, f₀ = ${d.system.f0.toFixed(d.system.f0 ? 5 : 0)}` +
      `${closure}`;
  }

  private updateReadout(): void {
    const v = this.viewer;
    const d = this.current();
    if (!v || !d) return;
    const fr = v.fRelative;
    const sys = v.system;
    const tau = elapsedTime(sys.e, sys.f0, sys.f0 + fr);
    this.readout.textContent =
      `f − f₀ = ${fr.toFixed(2)} rad τ = ${tau.toFixed(2)} TU frame ${v.frameIndex}/${v.sampleCount - 1}`;
    this.scrub.value = String(v.frameIndex);
  }

  private togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.playing || !this.viewer) return;
    this.playing = true;
    this.playBtn.textContent = 'pause';
    const tick = () => {
      if (!this.playing || !this.viewer) return;
      const m = this.viewer.sampleCount;
      this.cursor += this.speed;
      if (this.cursor > m - 1) this.cursor -= m - 1;
      this.viewer.showFrame(this.cursor);
      this.updateReadout();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing = false;
    this.playBtn.textContent = 'play';
    cancelAnimationFrame(this.raf);
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.viewer) return;
    const m = this.viewer.sampleCount;
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        this.togglePlay();
        break;
      case 'ArrowRight':
        ev.preventDefault();
        this.pause();
        this.cursor = (this.viewer.frameIndex + (ev.shiftKey ? 10 : 1)) % m;
        this.viewer.showFrame(this.cursor);
        this.updateReadout();
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        this.pause();
        this.cursor = (this.viewer.frameIndex - (ev.shiftKey ? 10 : 1) + m) % m;
        this.viewer.showFrame(this.cursor);
        this.updateReadout();
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
