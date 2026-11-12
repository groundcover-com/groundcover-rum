// Taps, gestures and text input, captured through GroundcoverWidget's
// Listener, with semantics OFF: users' phones usually have no semantics tree,
// so nothing here may depend on one.
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' hide Card;
import 'package:flutter/material.dart' as material show Card;
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/groundcover_rum.dart';
import 'package:groundcover_rum/src/api/runtime.dart';
import 'package:groundcover_rum/src/core/events/captures.dart';
import 'package:groundcover_rum/src/instrumentation/interaction_target.dart';
import 'package:groundcover_rum/src/instrumentation/interactions.dart';

import '../support/fake_platform.dart';
import '../support/recording_pipeline.dart';
import '../support/rum_widgets.dart';

// Playground-shaped widgets: the app's own HomeScreen, Card and Button.
class Button extends StatelessWidget {
  const Button({
    super.key,
    required this.label,
    this.hint,
    this.semanticsLabel,
  });
  final String label;
  final String? hint;
  final String? semanticsLabel;
  @override
  Widget build(BuildContext context) => Semantics(
    hint: hint,
    child: FilledButton(
      onPressed: () {},
      child: Text(label, semanticsLabel: semanticsLabel),
    ),
  );
}

class Card extends StatelessWidget {
  const Card({super.key, required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(14),
    child: Column(children: children),
  );
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});
  @override
  Widget build(BuildContext context) => ListView(
    children: [
      Card(
        children: [
          const Button(
            label: 'Well-tagged button (tapped 0)',
            semanticsLabel: 'Increment counter',
            hint: 'Adds one to the counter',
          ),
          const Button(label: 'Bare button'),
          const GroundcoverPrivate(
            child: Button(label: 'Private action (masked)'),
          ),
          Semantics(
            selected: true,
            expanded: true,
            value: 'forty two percent',
            child: const Button(label: 'A11y annotated button'),
          ),
          const TextField(
            decoration: InputDecoration(
              labelText: 'Search field',
              hintText: 'Type here, then tap away…',
            ),
          ),
          // Material's own Card stays out of the path; the app's Card above stays in.
          const material.Card(child: Button(label: 'In a material card')),
        ],
      ),
      for (var i = 1; i <= 60; i++) SizedBox(height: 44, child: Text('Row $i')),
    ],
  );
}

late RecordingPipeline pipeline;

Future<void> pumpApp(
  WidgetTester tester, {
  Widget home = const HomeScreen(),
}) async {
  await tester.runAsync(
    () => GroundcoverRum.init(
      const GroundcoverConfig(
        apiKey: 'k',
        dsn: 'd',
        cluster: 'c',
        environment: 'e',
        appId: 'a',
      ),
    ),
  );
  await tester.pumpWidget(
    GroundcoverWidget(
      child: MaterialApp(home: Scaffold(body: home)),
    ),
  );
}

void main() {
  setUp(() {
    pipeline = RecordingPipeline();
    RumRuntime.instance.debugReset(
      pipeline: () => pipeline,
      platform: (_) async => FakePlatform(),
    );
  });
  tearDown(() => RumRuntime.instance.debugReset());

  testWidgetsWithRum(
    semanticsEnabled: false,
    'a tap names the target from the Element tree, semantics off',
    (tester) async {
      await pumpApp(tester);
      expect(SemanticsBinding.instance.semanticsEnabled, isFalse);
      await tester.tap(find.text('Well-tagged button (tapped 0)'));
      final tap = pipeline.interactions.single;
      expect(tap.kind, InteractionKind.tap);
      expect(tap.gesture, isNull);
      // The text it shows, over its different accessibility label: RN's
      // contract (fiber-walk.ts), which the shared e2e specs assert.
      expect(tap.target.label, 'Well-tagged button (tapped 0)');
      expect(tap.target.role, 'button');
      expect(tap.target.hint, 'Adds one to the counter');
      expect(tap.target.component, 'Button');
      expect(tap.target.componentPath, contains('Card > Button'));
      expect(tap.target.componentPath, contains('HomeScreen'));
      expect(tap.target.componentPath, isNot(contains('FilledButton')));
      expect(tap.target.masked, isFalse);
      expect(pipeline.calls.first, 'presence');
    },
  );

  testWidgetsWithRum(
    'a tap on a button with no label of its own uses its visible text',
    (tester) async {
      await pumpApp(tester);
      final button = find.widgetWithText(FilledButton, 'Bare button');
      // The button's edge, away from the Text itself.
      await tester.tapAt(tester.getTopLeft(button) + const Offset(4, 4));
      expect(pipeline.interactions.single.target.label, 'Bare button');
    },
  );

  testWidgetsWithRum(
    semanticsEnabled: false,
    'GroundcoverPrivate marks the target masked',
    (tester) async {
      await pumpApp(tester);
      await tester.tap(find.text('Private action (masked)'));
      expect(pipeline.interactions.single.target.masked, isTrue);
    },
  );

  testWidgetsWithRum(
    semanticsEnabled: false,
    'a label read from a GroundcoverPrivate descendant masks the target',
    (tester) async {
      await pumpApp(
        tester,
        home: Center(
          child: FilledButton(
            onPressed: () {},
            child: const Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Pay'),
                GroundcoverPrivate(child: Text('4111 1111 1111 1111')),
              ],
            ),
          ),
        ),
      );
      // The button's padding, so the label comes from its descendants.
      final button = find.byType(FilledButton);
      await tester.tapAt(tester.getTopLeft(button) + const Offset(4, 4));
      expect(pipeline.interactions.single.target.masked, isTrue);
    },
  );

  testWidgetsWithRum(
    semanticsEnabled: false,
    'a tap names what is shown, never a hidden sibling under it',
    (tester) async {
      await pumpApp(
        tester,
        home: const Center(
          child: IndexedStack(
            children: [
              Button(label: 'Shown tab'),
              Button(label: 'Hidden tab'),
            ],
          ),
        ),
      );
      await tester.tap(find.text('Shown tab'));
      expect(pipeline.interactions.single.target.label, 'Shown tab');
    },
  );

  group('the target, as RN\'s fiber walk finds it', () {
    InteractionTarget tapTarget() => pipeline.interactions.single.target;

    testWidgetsWithRum(
      semanticsEnabled: false,
      'text past the 200-character budget is no label',
      (tester) async {
        await pumpApp(tester, home: Center(child: Text('word ' * 80)));
        await tester.tap(find.byType(Text));
        expect(tapTarget().label, '');
      },
    );

    testWidgetsWithRum(
      semanticsEnabled: false,
      'a toggle is its own role, with its state',
      (tester) async {
        Future<InteractionTarget> tapOn(Widget control) async {
          pipeline.captures.clear();
          await pumpApp(tester, home: Center(child: control));
          await tester.tap(find.byWidget(control));
          return tapTarget();
        }

        final checkbox = await tapOn(Checkbox(value: true, onChanged: (_) {}));
        expect(checkbox.role, 'checkbox');
        expect(checkbox.state, {'checked': true});
        final toggle = await tapOn(Switch(value: true, onChanged: (_) {}));
        expect(toggle.role, 'switch');
        expect(toggle.state, {'checked': true});
        final mixed = await tapOn(
          Checkbox(value: null, tristate: true, onChanged: (_) {}),
        );
        expect(mixed.state, {'checked': 'mixed'});
        final radio = await tapOn(
          RadioGroup<int>(
            groupValue: 1,
            onChanged: (_) {},
            child: const Radio<int>(value: 1),
          ),
        );
        expect(radio.role, 'radio');
      },
    );

    testWidgetsWithRum(
      semanticsEnabled: false,
      'a container with no role is named by its text',
      (tester) async {
        await pumpApp(
          tester,
          home: const Center(
            child: Padding(
              key: ValueKey('card'),
              padding: EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [Text('Order #1234'), Text('Shipped')],
              ),
            ),
          ),
        );
        final card = find.byKey(const ValueKey('card'));
        await tester.tapAt(tester.getTopLeft(card) + const Offset(4, 4));
        expect(tapTarget().label, 'Order #1234 Shipped');
      },
    );

    testWidgetsWithRum(
      semanticsEnabled: false,
      "the text a control shows beats its semanticsLabel; a glyph's names it",
      (tester) async {
        Future<String> labelOf(String shown, {bool corner = false}) async {
          pipeline.captures.clear();
          await pumpApp(
            tester,
            home: Center(
              child: FilledButton(
                key: const ValueKey('button'),
                onPressed: () {},
                child: Text(shown, semanticsLabel: 'Named'),
              ),
            ),
          );
          final button = find.byKey(const ValueKey('button'));
          if (corner) {
            await tester.tapAt(tester.getTopLeft(button) + const Offset(3, 3));
          } else {
            await tester.tap(find.text(shown));
          }
          return tapTarget().label;
        }

        expect(await labelOf('Visible'), 'Visible');
        expect(await labelOf('→'), 'Named');
        // Off the glyph: the label is read from the text under the button.
        expect(await labelOf('→', corner: true), 'Named');
      },
    );

    testWidgetsWithRum(
      semanticsEnabled: false,
      'a text field is named by its label, never by the text it draws',
      (tester) async {
        await pumpApp(
          tester,
          home: const Center(
            child: TextField(
              decoration: InputDecoration(
                labelText: 'Search field',
                hintText: 'Type here',
                counterText: '0/50',
              ),
            ),
          ),
        );
        await tester.tap(find.text('0/50'), warnIfMissed: false);
        expect(tapTarget().label, 'Search field');
        expect(tapTarget().role, 'textbox');
      },
    );

    testWidgetsWithRum(
      semanticsEnabled: false,
      'a control in a text field is named on its own',
      (tester) async {
        await pumpApp(
          tester,
          home: Center(
            child: CupertinoTextField(
              placeholder: 'Search',
              suffix: CupertinoButton(
                onPressed: () {},
                child: const Text('Clear'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Search'));
        expect(tapTarget().label, 'Search');
        pipeline.captures.clear();
        // A control in its decoration is named on its own.
        await tester.tap(find.text('Clear'));
        expect(tapTarget().label, 'Clear');
      },
    );

    testWidgetsWithRum(
      semanticsEnabled: false,
      'a field with no label of its own is named by the text beside it',
      (tester) async {
        await pumpApp(
          tester,
          home: const Row(
            children: [
              Text('Email'),
              Expanded(
                child: TextField(
                  decoration: InputDecoration(helperText: 'Required'),
                ),
              ),
            ],
          ),
        );
        await tester.enterText(find.byType(TextField), 'a@b.c');
        pipeline.captures.clear();
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pump();
        expect(pipeline.interactions.single.target.label, 'Email');
      },
    );

    testWidgets('a long Text.rich is never flattened whole on a touch', (
      tester,
    ) async {
      // A code viewer, a book chapter: one Text.rich, offered as text on
      // every ancestor of the touch. Flattened each time, it would cost
      // milliseconds per touch, for a text over the budget, so no label.
      await tester.pumpWidget(
        MaterialApp(
          home: SingleChildScrollView(
            child: Text.rich(
              key: const ValueKey('code'),
              _CountingSpan(
                children: [
                  for (var i = 0; i < 1000; i++) ...[
                    const TextSpan(text: 'final '),
                    TextSpan(text: 'value$i = "string $i";\n'),
                  ],
                ],
              ),
            ),
          ),
        ),
      );
      _CountingSpan.flattened = 0;
      final at =
          tester.getTopLeft(find.byKey(const ValueKey('code'))) +
          const Offset(20, 20);
      expect(targetOf(elementAt(at)).label, '');
      expect(_CountingSpan.flattened, 0);
    });

    test('a span tree past the budget is not built, however it is split', () {
      // One leaf can be the whole long text (a log viewer's single span):
      // copying it in only to drop it would cost milliseconds per touch.
      for (final tree in [
        TextSpan(text: 'x' * 100000),
        TextSpan(
          text: 'head ',
          children: [TextSpan(text: 'x' * 100000)],
        ),
      ]) {
        expect(spanTextWithin(tree, 200), (text: '', fits: false));
      }
      expect(
        spanTextWithin(
          const TextSpan(
            text: 'Pay ',
            children: [TextSpan(text: 'now')],
          ),
          200,
        ),
        (text: 'Pay now', fits: true),
      );
    });

    testWidgets(
      "a text field's text never becomes the value, even through Semantics",
      (tester) async {
        // An app may mirror a field's text into Semantics(value:) for screen
        // readers; typed text must still never leave the device.
        final controller = TextEditingController(text: 'secret-typed-text');
        addTearDown(controller.dispose);
        await tester.pumpWidget(
          MaterialApp(
            home: Material(
              child: Center(
                child: SizedBox(
                  width: 240,
                  child: Semantics(
                    value: controller.text,
                    child: TextField(controller: controller),
                  ),
                ),
              ),
            ),
          ),
        );
        final target = targetOf(
          elementAt(tester.getCenter(find.byType(TextField))),
        );
        expect(target.role, 'textbox');
        expect(target.valueText, isNull);
      },
    );

    testWidgets('a short Text.rich still names its control', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Center(
            child: FilledButton(
              key: const ValueKey('pay'),
              onPressed: () {},
              child: const Text.rich(
                TextSpan(
                  text: 'Pay ',
                  children: [
                    TextSpan(text: '£5', semanticsLabel: 'five pounds'),
                    WidgetSpan(child: Icon(Icons.lock, size: 12)),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      // As toPlainText reads it: a span's semanticsLabel over its text, and
      // a placeholder for the widget.
      const label = 'Pay five pounds\uFFFC';
      final button = find.byKey(const ValueKey('pay'));
      expect(targetOf(elementAt(tester.getCenter(button))).label, label);
      // Off the text, the label is read from under the button.
      expect(
        targetOf(
          elementAt(tester.getTopLeft(button) + const Offset(3, 3)),
        ).label,
        label,
      );
    });

    testWidgetsWithRum(
      semanticsEnabled: false,
      'the nearest state wins whole, never merged with an outer one',
      (tester) async {
        await pumpApp(
          tester,
          home: Center(
            child: Semantics(
              selected: true,
              child: const FilledButton(onPressed: null, child: Text('Off')),
            ),
          ),
        );
        await tester.tap(find.text('Off'), warnIfMissed: false);
        expect(tapTarget().state, {'disabled': true});
      },
    );
  });

  testWidgetsWithRum(
    semanticsEnabled: false,
    'Semantics flags and value become state and value',
    (tester) async {
      await pumpApp(tester);
      await tester.tap(find.text('A11y annotated button'));
      final target = pipeline.interactions.single.target;
      expect(target.state, {'selected': true, 'expanded': true});
      expect(target.valueText, 'forty two percent');
    },
  );

  testWidgetsWithRum("Material's Card is not in the path; the app's is", (
    tester,
  ) async {
    await pumpApp(tester);
    await tester.tap(find.text('In a material card'));
    final path = pipeline.interactions.single.target.componentPath;
    expect(path, 'HomeScreen > Card > Button');
  });

  testWidgetsWithRum(
    semanticsEnabled: false,
    'a long press is reported with its measure',
    (tester) async {
      await pumpApp(tester);
      // Synthesized pointers carry a zero timestamp unless given one; a device's
      // carry real ones.
      final gesture = await tester.startGesture(
        tester.getCenter(find.text('Row 3')),
      );
      await tester.pump(const Duration(milliseconds: 700));
      await gesture.up(timeStamp: const Duration(milliseconds: 700));
      final press = pipeline.interactions.single;
      expect(press.kind, InteractionKind.longPress);
      expect(press.target.label, 'Row 3');
      expect(press.gesture!.durationMs, greaterThan(500));
      expect(press.gesture!.pointerCount, 1);
    },
  );

  testWidgetsWithRum(
    semanticsEnabled: false,
    'a fast fling is a swipe, a slow drag a scroll',
    (tester) async {
      await pumpApp(tester);
      await tester.timedDrag(
        find.text('Row 3'),
        const Offset(0, -60),
        const Duration(seconds: 1),
      );
      await tester.pumpAndSettle();
      await tester.fling(
        find.textContaining('Row ').first,
        const Offset(0, -300),
        2000,
      );
      await tester.pumpAndSettle();
      final [scroll, swipe] = pipeline.interactions;
      expect(swipe.kind, InteractionKind.swipe);
      expect(swipe.gesture!.direction, GestureDirection.up);
      expect(swipe.gesture!.distanceDp, closeTo(300, 2));
      expect(scroll.kind, InteractionKind.scroll);
      expect(scroll.gesture!.distanceDp, closeTo(60, 2));
      expect(scroll.gesture!.velocityDpS, lessThan(300));
    },
  );

  testWidgetsWithRum(
    semanticsEnabled: false,
    'release velocity holds up when touches arrive in bursts',
    (tester) async {
      await pumpApp(tester);
      final from = tester.getCenter(find.text('Row 3'));
      Duration ms(int value) => Duration(milliseconds: value);

      // A 50 dp drag over a second whose last move lands late and catches up,
      // as a loaded simulator delivers them: 7 dp in 20 ms is 350 dp/s.
      final slow = await tester.createGesture();
      await slow.down(from, timeStamp: Duration.zero);
      for (var t = 100; t <= 900; t += 100) {
        await slow.moveTo(from - Offset(0, t * 0.043), timeStamp: ms(t));
      }
      await slow.moveTo(from - const Offset(0, 43), timeStamp: ms(1000));
      await slow.moveTo(from - const Offset(0, 50), timeStamp: ms(1020));
      await slow.up(timeStamp: ms(1020));
      await tester.pumpAndSettle();

      // A 450 dp flick over 116 ms whose moves mostly arrive at the end: the
      // last two samples alone read about 24,000 dp/s.
      final flick = await tester.createGesture();
      await flick.down(from, timeStamp: ms(5000));
      await flick.moveTo(from - const Offset(0, 30), timeStamp: ms(5060));
      await flick.moveTo(from - const Offset(0, 60), timeStamp: ms(5100));
      await flick.moveTo(from - const Offset(0, 450), timeStamp: ms(5116));
      await flick.up(timeStamp: ms(5116));
      await tester.pumpAndSettle();

      final [scroll, swipe] = pipeline.interactions;
      expect(scroll.kind, InteractionKind.scroll);
      expect(scroll.gesture!.velocityDpS, lessThan(150));
      expect(swipe.kind, InteractionKind.swipe);
      // The flick's average is 3,879 dp/s.
      expect(swipe.gesture!.velocityDpS, inInclusiveRange(1300, 11600));
    },
  );

  testWidgetsWithRum(
    semanticsEnabled: false,
    'a finished edit is one input, with no text and no coordinates',
    (tester) async {
      await pumpApp(tester);
      await tester.enterText(find.byType(TextField), 'secret typed value');
      pipeline.captures.clear();
      // Focus moves away: the edit is finished.
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      final input = pipeline.interactions.single;
      expect(input.kind, InteractionKind.input);
      expect(input.target.label, 'Search field');
      expect(input.x, isNull);
      expect(
        '${input.target.label}${input.target.valueText}',
        isNot(contains('secret')),
      );
    },
  );

  testWidgetsWithRum(
    semanticsEnabled: false,
    'focus in and out without a change is no input',
    (tester) async {
      await pumpApp(tester);
      await tester.tap(find.byType(TextField));
      pipeline.captures.clear();
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      expect(pipeline.interactions, isEmpty);
    },
  );

  testWidgetsWithRum(
    semanticsEnabled: false,
    'an unsampled session captures nothing',
    (tester) async {
      pipeline.sampled = false;
      await pumpApp(tester);
      await tester.tap(find.text('Bare button'));
      expect(pipeline.interactions, isEmpty);
    },
  );

  group('classifyGesture', () {
    PointerSample at(double x, double y, int ms) =>
        (position: Offset(x, y), time: Duration(milliseconds: ms));

    test('the RN rules', () {
      expect(
        classifyGesture(
          start: at(0, 0, 0),
          previous: at(0, 0, 0),
          end: at(5, 5, 100),
          pointerCount: 1,
          cancelled: false,
        )!.kind,
        InteractionKind.tap,
      );
      expect(
        classifyGesture(
          start: at(0, 0, 0),
          previous: at(0, 0, 0),
          end: at(5, 5, 600),
          pointerCount: 1,
          cancelled: false,
        )!.kind,
        InteractionKind.longPress,
      );
      expect(
        classifyGesture(
          start: at(0, 0, 0),
          previous: at(0, 0, 0),
          end: at(0, 20, 100),
          pointerCount: 1,
          cancelled: false,
        ),
        isNull,
        reason: 'moved past the slop but short of a swipe',
      );
      final swipe = classifyGesture(
        start: at(0, 0, 0),
        previous: at(0, 80, 80),
        end: at(0, 100, 100),
        pointerCount: 1,
        cancelled: false,
      )!;
      expect(
        (swipe.kind, swipe.measure!.direction, swipe.measure!.velocityDpS),
        (InteractionKind.swipe, GestureDirection.down, 1000),
      );
      final scroll = classifyGesture(
        start: at(0, 0, 0),
        previous: at(-38, 0, 900),
        end: at(-40, 0, 1000),
        pointerCount: 1,
        cancelled: false,
      )!;
      expect(
        (scroll.kind, scroll.measure!.direction),
        (InteractionKind.scroll, GestureDirection.left),
      );
      expect(
        classifyGesture(
          start: at(0, 0, 0),
          previous: at(0, 0, 0),
          end: at(0, 15, 50),
          pointerCount: 1,
          cancelled: true,
        )!.measure!.partial,
        isTrue,
      );
      expect(
        classifyGesture(
          start: at(0, 0, 0),
          previous: at(0, 0, 0),
          end: at(0, 0, 50),
          pointerCount: 2,
          cancelled: false,
        )!.kind,
        InteractionKind.pinch,
      );
    });
  });
}

/// A span tree's root that counts whole-tree flattenings: toPlainText calls
/// computeToPlainText on the root, which recurses into the children.
final class _CountingSpan extends TextSpan {
  const _CountingSpan({super.children});

  static var flattened = 0;

  @override
  void computeToPlainText(
    StringBuffer buffer, {
    bool includeSemanticsLabels = true,
    bool includePlaceholders = true,
  }) {
    flattened++;
    super.computeToPlainText(
      buffer,
      includeSemanticsLabels: includeSemanticsLabels,
      includePlaceholders: includePlaceholders,
    );
  }
}
