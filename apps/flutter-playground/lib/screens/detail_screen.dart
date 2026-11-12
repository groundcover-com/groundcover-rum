import 'package:flutter/material.dart' hide Card;

import '../ui.dart';

class DetailScreen extends StatelessWidget {
  const DetailScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PageBody(
      children: [
        const PageTitle('Detail'),
        const PageHint(
          'Navigating here should emit a `navigation` event and stamp the '
          '`screen` block (name "Detail" plus a per-instance key) on it and on '
          'every later event.',
        ),
        Card(
          children: [
            Button(
              label: 'Back',
              testId: 'detail-back',
              onPressed: () => Navigator.of(context).pop(),
            ),
          ],
        ),
      ],
    );
  }
}
