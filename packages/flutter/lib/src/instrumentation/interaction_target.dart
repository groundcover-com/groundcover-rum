// What a pointer landed on, from the Element tree: the Flutter counterpart of
// the React Native SDK's fiber walk.
//
// Never the SemanticsNode tree. That tree exists only while an accessibility
// service or a test harness has turned it on, so reading it would pass tests and
// capture nothing in production. Everything here reads widgets, which every
// build has.
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../api/widgets.dart';
import '../core/common/text.dart';
import '../core/pipeline/rum_pipeline.dart';
import 'framework_widgets.g.dart';

const _maxPathSegments = 10;
const _maxPathChars = 200;
// The React Native SDK's label budgets: text past 200 characters is a
// container dump, not a name, and is dropped. RN's 32-node, depth-6 descent
// counts the elements the app wrote; Flutter's Element tree adds the
// framework's own widgets between them (a FilledButton's Text sits a dozen
// elements down), so the node budget is doubled and there is no depth cap.
const _maxLabelChars = 200;
const _maxLabelNodes = 64;

/// The deepest element under [position] (global, logical pixels), searching
/// by paint bounds rather than hit testing, which can disturb render state.
/// Of overlapping branches, the one later in the tree wins, as it paints on
/// top. Only what is onstage is searched: routes below the top one, an
/// Offstage and an IndexedStack's other children keep their bounds, and
/// would win.
Element? elementAt(Offset position) {
  Element? found;
  void visit(Element element, RenderObject? parentRender) {
    final render = element.renderObject;
    // A chain of component elements shares one RenderObject, which the first
    // of them has tested already.
    if (render is RenderBox && !identical(render, parentRender)) {
      if (!render.attached || !render.hasSize) return;
      final rect = MatrixUtils.transformRect(
        render.getTransformTo(null),
        Offset.zero & render.size,
      );
      if (!rect.contains(position)) return;
    }
    if (render is RenderBox) found = element;
    // A sliver can't be tested this cheaply; its box children can.
    element.debugVisitOnstageChildren((child) => visit(child, render));
  }

  WidgetsBinding.instance.rootElement?.debugVisitOnstageChildren(
    (child) => visit(child, null),
  );
  return found;
}

/// The target of an interaction at [element]: RN's fiber walk (`walkFiber`)
/// over the Element tree. On the way up, the first label, role, hint, state
/// and value found win; the app's own widgets make the component path; and a
/// [GroundcoverPrivate] on the way, or under the text a label was read from,
/// masks it.
InteractionTarget targetOf(Element? element) {
  if (element == null) return const InteractionTarget();
  var label = '';
  var role = '';
  var roleIsGeneric = false;
  var pastOwnWidget = false;
  var hint = '';
  Map<String, Object>? state;
  String? valueText;
  var masked = false;
  final segments = <String>[]; // innermost first
  // Inside a text field, the field names the target: what it draws (its
  // label, hint, counter) is its own, as a TextInput's props are in RN, so
  // no label is read below it.
  var field = _enclosingField(element);
  final inField = field != null;

  void consider(Element e) {
    final widget = e.widget;
    // A gesture detector only says "tappable"; a control enclosing it, up to
    // the app's own widget, says what it is (a Checkbox's own GestureDetector
    // sits inside it). RN reads declared roles instead.
    final found = _roleOf(widget);
    if (found.role.isNotEmpty &&
        (role.isEmpty || roleIsGeneric && !found.generic && !pastOwnWidget)) {
      role = found.role;
      roleIsGeneric = found.generic;
    }
    if (identical(e, field)) field = null;
    if (label.isEmpty && field == null) {
      final own = _labelOf(e);
      label = own.label;
      if (own.private) masked = true;
    }
    if (widget is Semantics) {
      final p = widget.properties;
      if (hint.isEmpty && (p.hint ?? '').isNotEmpty) hint = p.hint!;
      // The nearest declaration wins whole, as in RN: a disabled button in
      // a selected row is disabled, not both. A Material button's own
      // Semantics declares only `enabled`, which says nothing until false.
      state ??= _stateOf(p);
      if (valueText == null && (p.value ?? '').isNotEmpty) {
        valueText = p.value;
      }
    }
    if (widget is GroundcoverPrivate) masked = true;
    final name = _componentName(e);
    if (name != null) {
      if (role.isNotEmpty) pastOwnWidget = true;
      if (segments.length < _maxPathSegments) segments.add(name);
    }
  }

  consider(element);
  element.visitAncestorElements((ancestor) {
    consider(ancestor);
    return true;
  });

  final path = truncate(
    segments.reversed.join(' > '),
    maxLength: _maxPathChars,
  );
  return InteractionTarget(
    component: segments.isEmpty ? '' : segments.first,
    label: label,
    role: role,
    hint: hint,
    state: state,
    // A text field's value is what was typed, even when the app mirrors it
    // into Semantics(value:) for screen readers: never captured.
    valueText: inField || role == 'textbox' ? null : valueText,
    componentPath: path,
    masked: masked,
  );
}

const _noLabel = (label: '', private: false);

/// One node's label: RN's `labelOf`. An explicit one wins; then the text the
/// node shows, or the text under it within the budget. Text past the budget,
/// or a glyph, is no label, and the walk goes on up. A text field has only
/// its explicit label.
({String label, bool private}) _labelOf(Element e) {
  final explicit = _explicitLabel(e);
  if (explicit.isNotEmpty || _isTextField(e.widget)) {
    return (label: explicit, private: false);
  }
  final own = _textOf(e.widget, _maxLabelChars);
  if (own != null) {
    final text = own.text.trim();
    if (!own.fits || _isDecorative(text)) return _noLabel;
    return (label: text, private: false);
  }
  final (:text, :private) = _descendantText(e);
  if (_isDecorative(text)) return _noLabel;
  return (label: text, private: private);
}

/// RN's accessibilityLabel, by Flutter's names for it.
String _explicitLabel(Element e) {
  final text = switch (e.widget) {
    Semantics(:final properties) => properties.label,
    Tooltip(:final message) => message,
    TextField(:final decoration) =>
      decoration?.labelText ?? decoration?.hintText,
    CupertinoTextField(:final placeholder) => placeholder,
    _ => null,
  };
  return (text ?? '').trim();
}

bool _isTextField(Widget widget) =>
    widget is TextField || widget is CupertinoTextField;

/// The text field [element] sits in, unless a control of its own (a
/// suffix's button) comes first. EditableText is the field's own.
Element? _enclosingField(Element element) {
  Element? field;
  bool up(Element e) {
    final widget = e.widget;
    if (_isTextField(widget)) {
      field = e;
      return false;
    }
    final (:role, :generic) = _roleOf(widget);
    return role.isEmpty || generic || widget is EditableText;
  }

  if (up(element)) element.visitAncestorElements(up);
  return field;
}

/// The text a [Text] or [RichText] shows, read no further than [budget]
/// characters: past it, `fits` is false. Null for any other widget. Text
/// that reads as text beats a different semanticsLabel, as RN's visible text
/// beats the control's accessibilityLabel; a glyph's semanticsLabel names
/// it, as RN's does an icon-only control. (A direct tap on the glyph meets
/// that label anyway, on the Semantics the Text builds around it.)
({String text, bool fits})? _textOf(Widget widget, int budget) {
  switch (widget) {
    case Text(:final data, :final textSpan, :final semanticsLabel):
      final shown = data != null
          ? _fit(data, budget)
          : spanTextWithin(textSpan!, budget);
      if (shown.fits && _isDecorative(shown.text) && semanticsLabel != null) {
        return _fit(semanticsLabel, budget);
      }
      return shown;
    case RichText(:final text):
      return spanTextWithin(text, budget);
    default:
      return null;
  }
}

({String text, bool fits}) _fit(String text, int budget) =>
    (text: text, fits: text.length <= budget);

/// [InlineSpan.toPlainText], within [budget] characters; past it, nothing is
/// built and `fits` is false. A long Text.rich (a code viewer, a book
/// chapter, a log viewer's single span) is offered as text on every ancestor
/// of a touch: flattened whole each time, it would cost milliseconds per
/// touch, for a text too long to be a label anyway.
@visibleForTesting
({String text, bool fits}) spanTextWithin(InlineSpan root, int budget) {
  final out = StringBuffer();
  // Measured before it is written: one leaf can be the whole long text.
  bool add(String text) {
    if (out.length + text.length > budget) return false;
    out.write(text);
    return true;
  }

  // As computeToPlainText writes it: a span's semanticsLabel over its text,
  // and a placeholder character for a widget.
  bool write(InlineSpan span) {
    switch (span) {
      case TextSpan(:final text, :final semanticsLabel, :final children):
        final own = semanticsLabel ?? text;
        if (own != null && !add(own)) return false;
        return (children ?? const <InlineSpan>[]).every(write);
      case PlaceholderSpan():
        return add(String.fromCharCode(PlaceholderSpan.placeholderCodeUnit));
      default:
        // A custom InlineSpan: its text is reachable only whole.
        return add(span.toPlainText());
    }
  }

  return write(root) ? (text: out.toString(), fits: true) : _overBudget;
}

const _overBudget = (text: '', fits: false);

/// Roles by widget type, matched with `is` (never runtimeType strings, which
/// `--obfuscate` renames). A gesture detector's is generic: any control that
/// encloses one names it better.
({String role, bool generic}) _roleOf(Widget widget) => switch (widget) {
  GestureDetector(:final onTap) when onTap != null => (
    role: 'button',
    generic: true,
  ),
  InkResponse() => (role: 'button', generic: true),
  Semantics(:final properties) when properties.button == true => (
    role: 'button',
    generic: false,
  ),
  Semantics(:final properties) when properties.link == true => (
    role: 'link',
    generic: false,
  ),
  ButtonStyleButton() ||
  MaterialButton() ||
  CupertinoButton() ||
  IconButton() ||
  FloatingActionButton() => (role: 'button', generic: false),
  ListTile(:final onTap) when onTap != null => (role: 'button', generic: false),
  Checkbox() ||
  CheckboxListTile() ||
  CupertinoCheckbox() => (role: 'checkbox', generic: false),
  Switch() ||
  SwitchListTile() ||
  CupertinoSwitch() => (role: 'switch', generic: false),
  Radio() || RadioListTile() => (role: 'radio', generic: false),
  Slider() || CupertinoSlider() => (role: 'adjustable', generic: false),
  TextField() ||
  CupertinoTextField() ||
  EditableText() => (role: 'textbox', generic: false),
  _ => (role: '', generic: false),
};

/// RN's accessibilityState flags. A switch's `toggled` is `checked`, and a
/// mixed checkbox `checked: 'mixed'`, as RN sends them. `disabled` only when
/// a control is: every Flutter button declares `enabled`, and an
/// always-present `disabled: false` would say nothing.
Map<String, Object>? _stateOf(SemanticsProperties p) {
  final Object? checked = p.mixed == true ? 'mixed' : p.checked ?? p.toggled;
  final state = <String, Object>{
    'selected': ?p.selected,
    'checked': ?checked,
    'expanded': ?p.expanded,
    if (p.enabled == false) 'disabled': true,
  };
  return state.isEmpty ? null : state;
}

/// The visible text under [element], within a budget, and whether any of it
/// sits under a [GroundcoverPrivate]. Running past the budget gives no label
/// at all: a partial one would name the wrong control, and a private widget
/// past the budget would go unseen.
({String text, bool private}) _descendantText(Element element) {
  final parts = <String>[];
  var nodes = _maxLabelNodes;
  var chars = _maxLabelChars;
  var overflow = false;
  var private = false;
  void visit(Element e) {
    if (overflow) return;
    if (--nodes < 0) {
      overflow = true;
      return;
    }
    final widget = e.widget;
    // A field's text is its own (see targetOf).
    if (_isTextField(widget)) return;
    if (widget is GroundcoverPrivate) private = true;
    final shown = _textOf(widget, chars);
    if (shown != null) {
      if (!shown.fits) {
        overflow = true;
        return;
      }
      final text = shown.text;
      chars -= text.length;
      if (!_isDecorative(text)) parts.add(text.trim());
      // A Text's own subtree is its RichText: counted once.
      return;
    }
    e.visitChildElements(visit);
  }

  element.visitChildElements(visit);
  if (overflow) return (text: '', private: false);
  return (text: parts.join(' ').trim(), private: private);
}

final _letterOrDigit = RegExp(r'[\p{L}\p{N}]', unicode: true);

bool _isDecorative(String text) => !_letterOrDigit.hasMatch(text);

/// The app's own composite widgets name the path; the framework's, private
/// classes and the SDK's own widgets don't.
String? _componentName(Element element) {
  if (element is! StatelessElement && element is! StatefulElement) return null;
  final widget = element.widget;
  final type = widget.runtimeType;
  if (frameworkWidgetTypes.contains(type)) return null;
  if (widget is GroundcoverWidget || widget is GroundcoverPrivate) return null;
  var name = type.toString();
  final generic = name.indexOf('<');
  if (generic != -1) {
    name = name.substring(0, generic);
    if (frameworkGenericWidgetNames.contains(name)) return null;
  }
  if (name.isEmpty || name.startsWith('_')) return null;
  return name;
}
