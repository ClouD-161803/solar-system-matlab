/**
 * Small colormap lookup tables, sampled from matplotlib's maps, for colouring
 * family members by their continuation parameter. The two single-hue maps are
 * restricted to their brighter half so the low end stays visible on black.
 */

export type ColormapId = 'viridis' | 'plasma' | 'cividis' | 'blues' | 'reds';

const STOPS: Record<ColormapId, number[][]> = {
  viridis: [
    [0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.53], [0.207, 0.372, 0.553],
    [0.164, 0.471, 0.558], [0.128, 0.567, 0.551], [0.135, 0.659, 0.518], [0.267, 0.749, 0.441],
    [0.478, 0.821, 0.318], [0.741, 0.873, 0.15], [0.993, 0.906, 0.144],
  ],
  plasma: [
    [0.05, 0.03, 0.528], [0.294, 0.012, 0.615], [0.492, 0.012, 0.658], [0.665, 0.139, 0.586],
    [0.798, 0.28, 0.47], [0.902, 0.418, 0.36], [0.973, 0.585, 0.252], [0.993, 0.771, 0.155],
    [0.94, 0.975, 0.131],
  ],
  cividis: [
    [0.0, 0.135, 0.304], [0.086, 0.218, 0.396], [0.243, 0.301, 0.42], [0.365, 0.383, 0.432],
    [0.478, 0.466, 0.448], [0.588, 0.55, 0.437], [0.702, 0.638, 0.402], [0.822, 0.73, 0.343],
    [0.945, 0.827, 0.244], [0.996, 0.91, 0.149],
  ],
  blues: [[0.19, 0.42, 0.71], [0.33, 0.6, 0.8], [0.53, 0.76, 0.87], [0.7, 0.85, 0.92], [0.85, 0.93, 0.98]],
  reds: [[0.72, 0.1, 0.1], [0.89, 0.27, 0.2], [0.98, 0.5, 0.36], [0.99, 0.7, 0.58], [1.0, 0.86, 0.78]],
};

/** RGB in [0, 1] at parameter t in [0, 1]. */
export function colormap(id: ColormapId, t: number, out: number[] = [0, 0, 0]): number[] {
  const stops = STOPS[id];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const u = x - i;
  for (let c = 0; c < 3; c++) out[c] = stops[i][c] + (stops[i + 1][c] - stops[i][c]) * u;
  return out;
}

export function colormapCss(id: ColormapId, t: number): string {
  const [r, g, b] = colormap(id, t);
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}
