import 'package:flutter/material.dart' hide Card;
import 'package:groundcover_rum/groundcover_rum.dart';
import 'package:groundcover_rum/testing.dart';

import '../config_presets.dart';
import '../ui.dart';

/// Everything the e2e suite needs that is neither a captured signal nor a
/// gesture: which preset the app booted with, the public API methods no other
/// screen calls, and the hooks the session specs drive.
class ConfigScreen extends StatefulWidget {
  const ConfigScreen({super.key, required this.preset});

  final String preset;

  @override
  State<ConfigScreen> createState() => _ConfigScreenState();
}

class _ConfigScreenState extends State<ConfigScreen> {
  var _sessionId = '—';
  var _done = '—';

  void _mark(String what) {
    if (mounted) setState(() => _done = '$what: done');
  }

  @override
  Widget build(BuildContext context) {
    return PageBody(
      children: [
        const PageTitle('Config & lifecycle'),
        // The preset spec gate: every preset spec waits for this line to read
        // back the preset it asked for. One string, so an exact getByText
        // matches, and no semantics label, which would replace the text.
        Text('preset: ${widget.preset}'),
        // Status lines sit above every card, so a spec that scrolled to a
        // control lower down can still see them.
        Text('Session: $_sessionId'),
        Text('Last action: $_done'),
        const PageHint(
          'The preset comes from e2e-preset.json in the app\'s documents '
          'directory, written by the harness. Relaunch to boot with another.',
        ),
        Card(
          children: [
            // Carries the marker the `callbacks` preset's beforeSend drops on.
            // The unmarked survivor beside it is what makes the drop mean
            // something: "no event arrived" is also what a dead SDK sends.
            Button(
              label: 'tap $dropMarker (beforeSend drops this)',
              testId: 'config-dropme',
              onPressed: () => _mark('dropme'),
            ),
            Button(
              label: 'tap survivor (beforeSend keeps this)',
              testId: 'config-survivor',
              onPressed: () => _mark('survivor'),
            ),
          ],
        ),
        const PageTitle('Public API'),
        const PageHint(
          'Methods no other screen calls: clearing the identity, reading and '
          'setting the session id, manual navigation, the manual TTI mark, and '
          'turning navigation tracking off.',
        ),
        Card(
          children: [
            Button(
              label: 'show session id',
              testId: 'config-show-session',
              onPressed: () => setState(() {
                final id = GroundcoverRum.getSessionId();
                _sessionId = id.isEmpty ? '(not ready)' : id;
              }),
            ),
            Button(
              label: 'setSessionId fixed',
              testId: 'config-set-session',
              // A recognisable id, so a spec can tell the SDK adopted this one
              // rather than rotating to any new value.
              onPressed: () =>
                  GroundcoverRum.setSessionId('e2e-fixed-session-id')
                      .then((_) => _mark('setSessionId')),
            ),
            Button(
              label: 'clear identity',
              testId: 'config-clear-user',
              onPressed: () {
                GroundcoverRum.updateConfig(
                  const GroundcoverConfigUpdate(clearUser: true),
                );
                _mark('clearIdentity');
              },
            ),
            Button(
              label: 'manual navigation',
              testId: 'config-manual-nav',
              // The screen name is required: a record without one is dropped.
              onPressed: () {
                GroundcoverRum.startNavigation('ManualScreen', key: 'manual-1');
                GroundcoverRum.endNavigation({'e2e_manual': 'end'});
                _mark('manualNav');
              },
            ),
            Button(
              label: 'manual navigation unnamed',
              testId: 'config-manual-nav-unnamed',
              onPressed: () {
                GroundcoverRum.startNavigation(
                  '',
                  metadata: {'e2e_manual': 'nameless'},
                );
                GroundcoverRum.endNavigation({'e2e_manual': 'nameless'});
                _mark('manualNavUnnamed');
              },
            ),
            Button(
              label: 'markAppInteractive',
              testId: 'config-mark-interactive',
              onPressed: () {
                GroundcoverRum.markAppInteractive();
                _mark('markInteractive');
              },
            ),
            Button(
              label: 'stopNavigationTracking',
              testId: 'config-stop-nav-tracking',
              onPressed: () {
                GroundcoverRum.stopNavigationTracking();
                _mark('stopNavTracking');
              },
            ),
          ],
        ),
        const PageTitle('Session anchors (DEBUG)'),
        const PageHint(
          'The SDK reads the persisted session at launch, so changing it and '
          'relaunching is the on-device stand-in for a mocked clock. Relaunch '
          'after tapping.',
        ),
        Card(
          children: [
            Button(
              label: 'backdate activity 31m',
              testId: 'config-backdate-activity',
              onPressed: () => GroundcoverRumTesting.backdateLastActivity(
                const Duration(minutes: 31),
              ).then((_) => _mark('backdateActivity')),
            ),
            Button(
              label: 'backdate session start 5h',
              testId: 'config-backdate-start',
              onPressed: () => GroundcoverRumTesting.backdateSessionStart(
                const Duration(hours: 5),
              ).then((_) => _mark('backdateStart')),
            ),
            Button(
              label: 'forget session',
              testId: 'config-forget-session',
              // The next launch starts a session no user has touched yet, the
              // only way to reach the ghost-session gate on a device.
              onPressed: () => GroundcoverRumTesting.forgetSession().then(
                (_) => _mark('forgetSession'),
              ),
            ),
          ],
        ),
      ],
    );
  }
}
