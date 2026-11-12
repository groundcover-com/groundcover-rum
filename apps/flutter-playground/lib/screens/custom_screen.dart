import 'package:flutter/material.dart' hide Card;
import 'package:groundcover_rum/groundcover_rum.dart';

import '../ui.dart';

class CustomScreen extends StatefulWidget {
  const CustomScreen({super.key});

  @override
  State<CustomScreen> createState() => _CustomScreenState();
}

class _CustomScreenState extends State<CustomScreen> {
  var _sessionId = '—';

  @override
  Widget build(BuildContext context) {
    return PageBody(
      children: [
        const PageTitle('Custom & identity'),
        const PageHint(
          'Custom events and user identification. Then background the app: '
          'the SDK flushes buffered events and persists the activity clock.',
        ),
        Card(
          children: [
            Button(
              label: 'sendCustomEvent',
              testId: 'custom-send',
              onPressed: () => GroundcoverRum.sendCustomEvent(
                'checkout_completed',
                {'total': 42, 'currency': 'USD'},
              ),
            ),
            Button(
              label: 'identifyUser',
              testId: 'custom-identify',
              onPressed: () => GroundcoverRum.identifyUser(
                const RumUser(
                  id: 'user-123',
                  email: 'demo@example.com',
                  name: 'Demo User',
                ),
              ),
            ),
            Button(
              label: 'show session id',
              testId: 'custom-session',
              onPressed: () => setState(() {
                final id = GroundcoverRum.getSessionId();
                _sessionId = id.isEmpty ? '(not ready)' : id;
              }),
            ),
            Text('Session: $_sessionId'),
          ],
        ),
      ],
    );
  }
}
