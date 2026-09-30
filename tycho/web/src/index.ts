/**
 * Tycho browser runtime entry point.
 * Bundled as an IIFE exposing `tycho` on window (and as an ES module); registers <tycho-viewer>.
 */

export { Container, loadContainer, decodeEmbedded } from './container';
export { FRAMES, rho, elapsedTime, trueAnomalyFromTime, segmentIndex, transformTrajectory, bodyPosition, bodyTrail } from './frames';
export { colormap, colormapCss } from './colormaps';
export { OrbitViewer, DARK } from './viewer';
export { TychoViewerElement, define } from './element';

import { define } from './element';

define();
