// debugPrint capture: the counterpart of the RN SDK's console capture.
// `print` is left alone (capturing it takes a zone), which
// is also how the SDK's own diagnostics stay out of what it reports.
import 'package:flutter/foundation.dart';

import '../core/common/hooks.dart';
import '../core/common/logger.dart';
import '../core/common/patch.dart';
import '../core/pipeline/rum_pipeline.dart';

/// Lines carrying this marker are not captured, as in the other SDKs.
const ignoreMarker = 'groundcoverIgnore';

/// Wraps [debugPrint]: every line still prints, and is also sent as a `log`
/// event at level `log`, the level RN gives `console.log`.
void installDebugPrintCapture(
  PatchSet patches,
  void Function(LogCapture capture) submit,
) => patches.install(
  PatchSpec<DebugPrintCallback>(
    get: () => debugPrint,
    set: (callback) => debugPrint = callback,
    wrap: (previous) => (message, {wrapWidth}) {
      previous(message, wrapWidth: wrapWidth);
      if (message == null ||
          message.isEmpty ||
          message.contains(ignoreMarker) ||
          inUserHook) {
        return;
      }
      try {
        submit(LogCapture(message, LogLevel.log));
      } catch (error) {
        handleError(error);
      }
    },
  ),
);
