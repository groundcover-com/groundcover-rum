// Opt-in canvas capture bounds (see ReplayCanvasOptions). rrweb re-encodes
// every canvas on every tick whether or not it changed, so fps drives CPU even
// on a static page; it drops frames identical to the previous one, so bytes
// only grow when content changes. fps is also the time resolution: a canvas
// state shorter than 1/fps seconds may never be captured. 1 fps keeps the CPU
// cost lowest and sends the same bytes for charts that change slower than
// that; pages with animated canvases can raise it.
export const DEFAULT_REPLAY_CANVAS_FPS = 1;
export const MIN_REPLAY_CANVAS_FPS = 1;
export const MAX_REPLAY_CANVAS_FPS = 15;
// Default snapshot serialization: lossy webp is far smaller than rrweb's
// default lossless png. Quality is ignored for image/png.
export const DEFAULT_REPLAY_CANVAS_IMAGE_TYPE = "image/webp";
export const DEFAULT_REPLAY_CANVAS_IMAGE_QUALITY = 0.6;
