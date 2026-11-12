import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/api/runtime.dart';

/// [testWidgets] for a test that starts the SDK. The SDK wraps debugPrint,
/// and the test binding checks debugPrint is restored as soon as the body
/// ends, before any tearDown: so the SDK is reset inside the body.
void testWidgetsWithRum(
  String description,
  WidgetTesterCallback body, {
  bool semanticsEnabled = true,
}) => testWidgets(description, semanticsEnabled: semanticsEnabled, (
  tester,
) async {
  try {
    await body(tester);
  } finally {
    RumRuntime.instance.debugReset();
  }
});
