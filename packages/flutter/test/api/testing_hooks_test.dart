// The native test hooks as a harness calls them: they never throw into it,
// and a block is bounded whatever it asks for.
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/platform/rum_api.g.dart';
import 'package:groundcover_rum/testing.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a hook with no plugin to answer it completes, rather than throwing '
      'into the harness', () async {
    // No handler registered: no plugin, as in a widget test or on desktop.
    await GroundcoverRumTesting.triggerTestCrash();
    await GroundcoverRumTesting.blockMainThread(const Duration(seconds: 1));
  });

  test('a block is capped at 30 s, whatever the caller asks', () async {
    const channel =
        'dev.flutter.pigeon.groundcover_rum.RumHostApi.blockMainThread';
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    int? sent;
    messenger.setMockMessageHandler(channel, (message) async {
      final args =
          RumHostApi.pigeonChannelCodec.decodeMessage(message)!
              as List<Object?>;
      sent = args.single! as int;
      return RumHostApi.pigeonChannelCodec.encodeMessage(<Object?>[null]);
    });
    addTearDown(() => messenger.setMockMessageHandler(channel, null));

    await GroundcoverRumTesting.blockMainThread(const Duration(hours: 1));
    expect(sent, 30000);

    await GroundcoverRumTesting.blockMainThread(const Duration(seconds: 3));
    expect(sent, 3000);
  });
}
