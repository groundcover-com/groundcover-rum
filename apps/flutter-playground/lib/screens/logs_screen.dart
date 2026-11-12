import 'dart:async';

import 'package:flutter/material.dart' hide Card;
import 'package:groundcover_rum/groundcover_rum.dart';

import '../ui.dart';

class LogsScreen extends StatelessWidget {
  const LogsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PageBody(
      children: [
        const PageTitle('Logs'),
        const PageHint(
          'Captured `debugPrint` and the explicit `GroundcoverRum.logger` API '
          'both emit `log` events through the same redaction contract.',
        ),
        Card(
          children: [
            Button(
              label: 'debugPrint',
              testId: 'logs-debug-print',
              onPressed: () => debugPrint('playground debugPrint'),
            ),
            Button(
              label: 'logger.info',
              testId: 'logs-logger-info',
              onPressed: () => GroundcoverRum.logger.info(
                'explicit logger.info',
                {'via': 'api'},
              ),
            ),
            Button(
              label: 'logger.warn',
              testId: 'logs-logger-warn',
              onPressed: () =>
                  GroundcoverRum.logger.warn('explicit logger.warn'),
            ),
          ],
        ),
        const PageTitle('Errors'),
        const PageHint(
          'A handled error reported with captureException, and an uncaught '
          'async throw the SDK sees through PlatformDispatcher.onError. Both '
          'emit an `exception` event; the app\'s own handling is untouched.',
        ),
        Card(
          children: [
            Button(
              label: 'captureException',
              testId: 'errors-capture',
              onPressed: () => GroundcoverRum.captureException(
                StateError('handled e2e error'),
                stackTrace: StackTrace.current,
                metadata: {'screen': 'Logs'},
              ),
            ),
            Button(
              label: 'throw uncaught',
              testId: 'errors-uncaught',
              // Thrown from a timer, outside any framework callback, so it
              // reaches PlatformDispatcher.onError, as RN's setTimeout throw
              // reaches ErrorUtils.
              onPressed: () =>
                  Timer.run(() => throw StateError('uncaught e2e error')),
            ),
          ],
        ),
        const PageTitle('Privacy fixtures'),
        const PageHint(
          'Sensitive payloads for the privacy matrix. Deliberately last on the '
          'screen: a control inserted above shifts the ones the specs tap '
          'without scrolling. Append here; never insert above.',
        ),
        Card(
          children: [
            Button(
              label: 'log sensitive',
              testId: 'logs-sensitive',
              // Secrets in both halves of a log event, the free-text message
              // and the attributes, which take different redaction paths.
              onPressed: () => GroundcoverRum.logger.info(
                'user login password=e2e-log-password',
                {
                  'api_key': 'e2e-log-apikey',
                  'order_id': 'A-1',
                  'email': 'demo@example.com',
                },
              ),
            ),
            Button(
              label: 'capture sensitive error',
              testId: 'errors-sensitive',
              onPressed: () => GroundcoverRum.captureException(
                StateError('auth failed for token=e2e-error-token'),
                stackTrace: StackTrace.current,
                metadata: {'password': 'e2e-error-password', 'order_id': 'A-1'},
              ),
            ),
          ],
        ),
      ],
    );
  }
}
