// The defaults and clamps for NativeOptions. A value out of range falls back
// to the default rather than reaching native, where a nonsense threshold
// would arm a watchdog that fires constantly or never.
import 'types.dart';

/// The main-thread stall before an app hang is reported on iOS: 2 s, a
/// common default, since iOS has no system hang bar of its own.
const defaultHangThresholdMs = 2000;

/// Android's, higher on purpose: the platform's own ANR threshold is 5 s, so
/// reporting sooner would flag stalls the OS itself tolerates.
const defaultAndroidHangThresholdMs = 5000;

/// The longest a frame-vitals segment runs before it is closed anyway. A
/// safety valve, not a cadence: segments normally end on a navigation or on
/// backgrounding.
const defaultVitalsMaxSegmentMs = 60000;

const _minHangThresholdMs = 250;
const _maxHangThresholdMs = 60000;
const _minVitalsMaxSegmentMs = 1000;
const _maxVitalsMaxSegmentMs = 300000;

// Whole milliseconds, rounded, as RN rounds: the two engines read these
// fields as different numeric types, so a fraction would configure one value
// on Android and another on iOS.
int _withinOr(Duration? value, int min, int max, int fallback) {
  if (value == null) return fallback;
  final ms = (value.inMicroseconds / 1000).round();
  return ms < min || ms > max ? fallback : ms;
}

/// The hang threshold for the platform running ([android], or iOS): that
/// platform's value, or its own default. A platform left out of a
/// [HangThreshold.perPlatform] never borrows the other's value.
int resolveHangThresholdMs(HangThreshold? threshold, {required bool android}) {
  return _withinOr(
    android ? threshold?.android : threshold?.ios,
    _minHangThresholdMs,
    _maxHangThresholdMs,
    android ? defaultAndroidHangThresholdMs : defaultHangThresholdMs,
  );
}

int resolveVitalsMaxSegmentMs(Duration? value) => _withinOr(
  value,
  _minVitalsMaxSegmentMs,
  _maxVitalsMaxSegmentMs,
  defaultVitalsMaxSegmentMs,
);
