/// Capture: errors, network (`HttpOverrides`), navigation, taps, input and
/// gestures (a root `Listener` plus an Element-tree walk), logs, native signals
/// and frame vitals (`FrameTiming`).
///
/// Tap labels come from walking the Element tree (Semantics widgets, Text,
/// Tooltip), never from the SemanticsNode tree: that tree exists only while an
/// accessibility service or a test harness has turned it on, so reading it would
/// pass tests and capture nothing in production.
library;
