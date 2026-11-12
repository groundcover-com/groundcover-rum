import 'package:flutter/material.dart' hide Card;
import 'package:flutter/scheduler.dart';
import 'package:groundcover_rum/testing.dart';

import '../ui.dart';

/// How long "Block main thread" and "Block Dart thread" block for. The hang
/// specs assert against it.
const hangStallMs = 3000;

/// A named widget rather than a bare Text, so a tap's component path names
/// something a product engineer recognises.
class ScrollRow extends StatelessWidget {
  const ScrollRow({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Text(label, style: const TextStyle(fontSize: 16)),
  );
}

/// Drives the native signals from the UI, and holds the lists the gesture
/// specs drag.
///
/// Crash and hang come from the plugin's development-only native hooks
/// (`GroundcoverRumTesting`), as rn-playground's come from its native module.
/// "Block Dart thread" is Flutter's own: a stall in Dart code rather than in
/// native code, which the native watchdog sees because Dart runs on the main
/// thread.
class NativeScreen extends StatefulWidget {
  const NativeScreen({super.key});

  @override
  State<NativeScreen> createState() => _NativeScreenState();
}

class _NativeScreenState extends State<NativeScreen> {
  var _note = '';

  VoidCallback _run(String label, Future<void> Function() action) => () {
    setState(() => _note = '$label: triggered');
    action().catchError((Object error) {
      if (mounted) setState(() => _note = '$label: failed ($error)');
    });
  };

  /// Busy-waits in Dart, after the frame that shows the note, so the stall is
  /// Dart's own work rather than a native sleep.
  Future<void> _blockDart() async {
    SchedulerBinding.instance.addPostFrameCallback((_) {
      final stall = Stopwatch()..start();
      while (stall.elapsedMilliseconds < hangStallMs) {}
    });
  }

  Future<void> _openModal() {
    // A full-screen dialog route: a separate route on the root navigator, the
    // Flutter counterpart of RN's Modal surface. Unnamed, so navigation
    // tracking skips it.
    return Navigator.of(context, rootNavigator: true).push(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (context) => const _ModalList(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return PageBody(
      // This screen owns a list, so the page itself does not scroll.
      scroll: false,
      children: [
        const PageTitle('Native signals'),
        const PageHint(
          'Crashes, hangs, app start and frame vitals come from the native '
          'engine. A crash is reported on the NEXT launch, under the session it '
          'happened in.',
        ),
        Card(
          children: [
            Button(
              label: 'Crash natively',
              testId: 'native-crash',
              semanticsLabel: 'Crash natively',
              onPressed: _run(
                'crash',
                () => GroundcoverRumTesting.triggerTestCrash('native'),
              ),
            ),
            Button(
              label: 'Block main thread',
              testId: 'native-hang',
              semanticsLabel: 'Block main thread',
              onPressed: _run(
                'hang',
                () => GroundcoverRumTesting.blockMainThread(
                  const Duration(milliseconds: hangStallMs),
                ),
              ),
            ),
            Button(
              label: 'Block Dart thread',
              testId: 'native-dart-hang',
              semanticsLabel: 'Block Dart thread',
              onPressed: _run('dart stall', _blockDart),
            ),
            Text(_note),
          ],
        ),
        const PageHint(
          'Scroll this list to exercise gesture capture: the SDK classifies the '
          'swipe from the pointer stream.',
        ),
        Button(
          label: 'Open modal',
          semanticsLabel: 'Open modal',
          onPressed: _openModal,
        ),
        SizedBox(
          height: 220,
          child: Semantics(
            identifier: 'native-scroll-list',
            label: 'Scrollable list',
            child: ListView.builder(
              itemCount: 60,
              itemBuilder: (context, i) => ScrollRow(label: 'Row ${i + 1}'),
            ),
          ),
        ),
      ],
    );
  }
}

class _ModalList extends StatelessWidget {
  const _ModalList();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const PageTitle('Modal list'),
              const SizedBox(height: 12),
              Button(
                label: 'Close modal',
                semanticsLabel: 'Close modal',
                onPressed: () => Navigator.of(context).pop(),
              ),
              const SizedBox(height: 12),
              SizedBox(
                height: 220,
                child: Semantics(
                  identifier: 'modal-scroll-list',
                  label: 'Modal scrollable list',
                  child: ListView.builder(
                    itemCount: 60,
                    itemBuilder: (context, i) =>
                        ScrollRow(label: 'Modal row ${i + 1}'),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
