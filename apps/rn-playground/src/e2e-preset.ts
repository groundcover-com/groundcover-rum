// E2E-CONTROLLED FILE — the RN analogue of the browser playground's `?gcp=` override. Specs
// rewrite the line below, relaunch, and Metro re-bundles, so the preset is available
// SYNCHRONOUSLY at module load. That is why it is a source file rather than AsyncStorage: the
// SDK initialises at the top of App.tsx, and `startNavigationTracking` before init() is
// warn-dropped rather than buffered, so a slow storage read would silently disable navigation
// tracking for the whole run.
//
// Committed as "default" so a fresh checkout bundles. `support/preset.ts` rewrites and restores
// it; the Config screen renders the active value so a spec can GATE on it being live.
export const E2E_PRESET = "default";
