/// [text] cut to [maxLength] characters, with [ellipsis] appended when cut.
/// Null becomes `''`; anything else is stringified first.
String truncate(Object? text, {int maxLength = 10000, String ellipsis = ''}) {
  if (text == null) return '';
  final str = text is String ? text : '$text';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + ellipsis;
}

final _whitespace = RegExp(r'\s+');

/// Runs of whitespace, newlines included, collapsed to one space and trimmed:
/// a one-line label from multi-line text.
String normalizeWhitespace(String? text) =>
    (text ?? '').replaceAll(_whitespace, ' ').trim();
