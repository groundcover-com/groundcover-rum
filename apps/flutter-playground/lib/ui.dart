// The playground's building blocks, the counterpart of apps/rn-playground/src/ui.tsx.
//
// The class names are part of the e2e contract: the specs assert a tap's
// `interaction_target.component` is "Button" and its component path contains
// "Card > Button" and "HomeScreen", so these are the app's own widgets, named
// like RN's components. Material's Card is hidden for that reason.
//
// Locator rules for the tree the harness reads (keep them when adding controls):
//   - Tabs: an explicit Semantics(label: "<Name> tab", excludeSemantics: true).
//     Material NavigationBar appends "Tab N of M" and breaks exact getByLabel.
//   - IDs: Semantics(identifier: ...) around the control. Never MergeSemantics:
//     mobilecli >= 1.0.8 drops the merged node from the tree it reads.
//   - Text fields: locate by test ID. Android's native tree carries a field's
//     label as its hint, which getByLabel doesn't read.
//   - A label that replaces the visible text is Text(semanticsLabel:), the
//     counterpart of RN's accessibilityLabel.
import 'package:flutter/material.dart' hide Card;

class Button extends StatelessWidget {
  const Button({
    super.key,
    required this.label,
    required this.onPressed,
    this.testId,
    this.semanticsLabel,
    this.hint,
  });

  final String label;
  final VoidCallback onPressed;
  final String? testId;

  /// Replaces [label] for queries, like RN's accessibilityLabel.
  final String? semanticsLabel;

  /// Like RN's accessibilityHint.
  final String? hint;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      identifier: testId,
      hint: hint,
      child: FilledButton(
        onPressed: onPressed,
        style: FilledButton.styleFrom(padding: const EdgeInsets.all(14)),
        child: Text(label, semanticsLabel: semanticsLabel),
      ),
    );
  }
}

/// A labelled text field. The SDK reports one `input` interaction when an
/// edit ends, labelled from [label], and never the typed text.
class Field extends StatelessWidget {
  const Field({super.key, required this.label, this.testId, this.placeholder});

  final String label;
  final String? testId;
  final String? placeholder;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      identifier: testId,
      child: TextField(
        decoration: InputDecoration(
          labelText: label,
          hintText: placeholder,
          border: const OutlineInputBorder(),
        ),
      ),
    );
  }
}

/// A scrolling page. Pass `scroll: false` when the screen has its own
/// scrollable, so a drag has exactly one scroller to claim it.
class PageBody extends StatelessWidget {
  const PageBody({super.key, required this.children, this.scroll = true});

  final List<Widget> children;
  final bool scroll;

  @override
  Widget build(BuildContext context) {
    final column = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      spacing: 12,
      children: children,
    );
    const padding = EdgeInsets.all(20);
    if (!scroll) return Padding(padding: padding, child: column);
    return SingleChildScrollView(padding: padding, child: column);
  }
}

class PageTitle extends StatelessWidget {
  const PageTitle(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w500),
  );
}

class PageHint extends StatelessWidget {
  const PageHint(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: const TextStyle(fontSize: 14, color: Color(0xFF666666)),
  );
}

class Card extends StatelessWidget {
  const Card({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0xFFF2F2F7),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          spacing: 10,
          children: children,
        ),
      ),
    );
  }
}
