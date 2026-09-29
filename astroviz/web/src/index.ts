/**
 * astroviz browser runtime entry point.
 * Bundled as an IIFE exposing `astroviz` on window; registers <astro-viewer>.
 */

export { Container, loadContainer, decodeEmbedded } from './container';
export { FRAMES, rho, elapsedTime, trueAnomalyFromTime, segmentIndex, transformTrajectory, bodyPosition, bodyTrail } from './frames';
export { colormap, colormapCss } from './colormaps';
export { OrbitViewer, DARK } from './viewer';
export { AstroViewerElement, define } from './element';

import { define } from './element';

define();
