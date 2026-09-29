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
}

export const FRAMES: FrameSpec[] = [
  { id: 'rotating_pulsating', label: 'rotating-pulsating', axes: ['x [DU]', 'y [DU]'] },
  { id: 'rotating', label: 'rotating', axes: ['x̃ [DU]', 'ỹ [DU]'] },
  { id: 'barycentric_inertial', label: 'barycentric inertial', axes: ['ξ [DU]', 'η [DU]'] },
  { id: 'inertial_primary', label: 'inertial, centred on m₁', axes: ['ξ₁ [DU]', 'η₁ [DU]'] },
  { id: 'inertial_secondary', label: 'inertial, centred on m₂', axes: ['ξ₂ [DU]', 'η₂ [DU]'] },
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
  fRel: Float64Array,
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
  fRel: Float64Array,
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
