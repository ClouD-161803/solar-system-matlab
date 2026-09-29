/**
 * Kinematic frame transforms for the ER3BP.
 *
 * This is the only "physics" the runtime owns: pure coordinate changes that
 * need nothing but the mass ratio, the eccentricity and the current true
 * anomaly. Nothing here integrates an equation of motion. The formulas mirror
 * the conversions exposed by PyDylan's ER3BP class
 * (rotating_pulsating_to_rotating, rotating_to_barycentric_inertial,
 * rotating_to_inertial with which_body).
 *
 * Conventions: distances in DU (the primaries' semi-major axis), primary of
 * mass 1-mu at rotating (-mu, 0), secondary of mass mu at (1-mu, 0), rotating
 * frame angle relative to the inertial frame equal to the true anomaly f.
 */

export type FrameId =
  | 'rotating_pulsating'
  | 'rotating'
  | 'barycentric_inertial'
  | 'inertial_primary'
  | 'inertial_secondary';

export interface FrameSpec {
  id: FrameId;
  label: string;
  axes: [string, string];
  /** colormap for family members in this frame, following the reference figures */
  cmap: 'viridis' | 'plasma' | 'cividis' | 'blues' | 'reds';
}

export const FRAMES: FrameSpec[] = [
  { id: 'rotating_pulsating', label: 'rotating-pulsating', axes: ['x [DU]', 'y [DU]'], cmap: 'viridis' },
  { id: 'rotating', label: 'rotating', axes: ['x̃ [DU]', 'ỹ [DU]'], cmap: 'blues' },
  { id: 'barycentric_inertial', label: 'barycentric inertial', axes: ['ξ [DU]', 'η [DU]'], cmap: 'plasma' },
  { id: 'inertial_primary', label: 'inertial, centred on m₁', axes: ['ξ₁ [DU]', 'η₁ [DU]'], cmap: 'reds' },
  { id: 'inertial_secondary', label: 'inertial, centred on m₂', axes: ['ξ₂ [DU]', 'η₂ [DU]'], cmap: 'cividis' },
];

export interface ER3BPSystem {
  mu: number;
  e: number;
  /** True anomaly at the start of the trajectory (0 periapsis, pi apoapsis). */
  f0: number;
}

/** Primary-secondary separation over the semi-major axis at true anomaly f. */
export function rho(e: number, f: number): number {
  return (1 - e * e) / (1 + e * Math.cos(f));
}

/** Mean anomaly for true anomaly f, unwrapped so it grows monotonically with f. */
function meanAnomaly(e: number, f: number): number {
  const k = Math.round(f / (2 * Math.PI));
  const fr = f - 2 * Math.PI * k;
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(fr / 2), Math.sqrt(1 + e) * Math.cos(fr / 2));
  return E - e * Math.sin(E) + 2 * Math.PI * k;
}

/** Nondimensional time elapsed between true anomalies f0 and f (mean motion 1). */
export function elapsedTime(e: number, f0: number, f: number): number {
  return meanAnomaly(e, f) - meanAnomaly(e, f0);
}

/**
 * Position of a body in a given frame at absolute true anomaly f.
 * Writes [x, y] into `out` at `offset`.
 */
export function bodyPosition(
  body: 'primary' | 'secondary',
  sys: ER3BPSystem,
  frame: FrameId,
  f: number,
  out: Float32Array,
  offset = 0,
): void {
  const xr = body === 'primary' ? -sys.mu : 1 - sys.mu; // rotating-pulsating x, y = 0
  const r = rho(sys.e, f);
  const c = Math.cos(f);
  const s = Math.sin(f);
  switch (frame) {
    case 'rotating_pulsating':
      out[offset] = xr;
      out[offset + 1] = 0;
      return;
    case 'rotating':
      out[offset] = r * xr;
      out[offset + 1] = 0;
      return;
    case 'barycentric_inertial':
      out[offset] = r * xr * c;
      out[offset + 1] = r * xr * s;
      return;
    case 'inertial_primary': {
      const d = body === 'primary' ? 0 : r; // separation between the bodies is rho
      out[offset] = d * c;
      out[offset + 1] = d * s;
      return;
    }
    case 'inertial_secondary': {
      const d = body === 'secondary' ? 0 : -r;
      out[offset] = d * c;
      out[offset + 1] = d * s;
      return;
    }
  }
}

/**
 * Transforms a rotating-pulsating trajectory into `frame`.
 * `xy` holds M pairs, `fRel` M true anomalies relative to sys.f0. Output is
 * M triples (z = 0) suitable for a three.js position attribute.
 */
export function transformTrajectory(
  xy: Float32Array,
  fRel: ArrayLike<number>,
  sys: ER3BPSystem,
  frame: FrameId,
  out: Float32Array,
): Float32Array {
  const m = fRel.length;
  const tmp = new Float32Array(2);
  for (let i = 0; i < m; i++) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    const f = sys.f0 + fRel[i];
    let X: number;
    let Y: number;
    if (frame === 'rotating_pulsating') {
      X = x;
      Y = y;
    } else {
      const r = rho(sys.e, f);
      if (frame === 'rotating') {
        X = r * x;
        Y = r * y;
      } else {
        const c = Math.cos(f);
        const s = Math.sin(f);
        X = r * (x * c - y * s);
        Y = r * (x * s + y * c);
        if (frame !== 'barycentric_inertial') {
          bodyPosition(frame === 'inertial_primary' ? 'primary' : 'secondary', sys, 'barycentric_inertial', f, tmp);
          X -= tmp[0];
          Y -= tmp[1];
        }
      }
    }
    out[3 * i] = X;
    out[3 * i + 1] = Y;
    out[3 * i + 2] = 0;
  }
  return out;
}

/** Path of a body over the trajectory's true anomaly grid, as M triples. */
export function bodyTrail(
  body: 'primary' | 'secondary',
  fRel: ArrayLike<number>,
  sys: ER3BPSystem,
  frame: FrameId,
  out: Float32Array,
): Float32Array {
  const tmp = new Float32Array(2);
  for (let i = 0; i < fRel.length; i++) {
    bodyPosition(body, sys, frame, sys.f0 + fRel[i], tmp);
    out[3 * i] = tmp[0];
    out[3 * i + 1] = tmp[1];
    out[3 * i + 2] = 0;
  }
  return out;
}

/**
 * True anomaly reached after nondimensional time `tau` from `f0` (mean motion 1),
 * unwrapped so it grows monotonically. Newton iteration on Kepler's equation.
 */
export function trueAnomalyFromTime(e: number, f0: number, tau: number): number {
  const M = meanAnomaly(e, f0) + tau;
  const k = Math.floor(M / (2 * Math.PI));
  const Mr = M - 2 * Math.PI * k;
  let E = e < 0.8 ? Mr : Math.PI;
  for (let i = 0; i < 30; i++) {
    const d = (E - e * Math.sin(E) - Mr) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  let f = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  if (f < 0) f += 2 * Math.PI;
  return f + 2 * Math.PI * k;
}

/** Index i with a[i] <= v < a[i+1] for a sorted array (clamped to [0, n-2]). */
export function segmentIndex(a: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = a.length - 1;
  if (v <= a[0]) return 0;
  if (v >= a[hi]) return hi - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}
