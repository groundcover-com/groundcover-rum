import 'package:flutter/material.dart' hide Card;
import 'package:groundcover_rum/groundcover_rum.dart';

import '../ui.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  var _count = 0;

  void _increment() => setState(() => _count++);

  @override
  Widget build(BuildContext context) {
    return PageBody(
      children: [
        const PageTitle('Taps'),
        const PageHint(
          'Each tap emits an `interaction` event. Compare the labels: a '
          'well-tagged button vs. a bare one shows how much comes from '
          'Semantics hygiene.',
        ),
        Card(
          children: [
            Button(
              label: 'Well-tagged button (tapped $_count)',
              testId: 'home-counter-button',
              semanticsLabel: 'Increment counter',
              hint: 'Adds one to the counter',
              onPressed: _increment,
            ),
            Button(
              label: 'Bare button (no testID/label)',
              onPressed: _increment,
            ),
            GroundcoverPrivate(
              child: Button(
                label: 'Private action (masked)',
                testId: 'home-private-button',
                semanticsLabel: 'Private action',
                onPressed: _increment,
              ),
            ),
            Button(
              label: 'Go to Detail screen',
              testId: 'home-to-detail',
              onPressed: () => Navigator.of(context).pushNamed('Detail'),
            ),
            // Selected, expanded and a value, the Flutter counterparts of RN's
            // accessibilityState / accessibilityValue. No label that replaces
            // the text: it has to stay findable by its text.
            Semantics(
              selected: true,
              expanded: true,
              value: 'forty two percent',
              child: Button(
                label: 'A11y annotated button',
                testId: 'home-a11y-button',
                onPressed: _increment,
              ),
            ),
          ],
        ),
        const PageTitle('Typing'),
        const PageHint(
          'Editing a field emits ONE `input` interaction when you finish (blur '
          'or submit), labelled from its label, never the text you typed.',
        ),
        const Card(
          children: [
            Field(
              label: 'Search field',
              testId: 'home-text-input',
              placeholder: 'Type here, then tap away…',
            ),
          ],
        ),
      ],
    );
  }
}
