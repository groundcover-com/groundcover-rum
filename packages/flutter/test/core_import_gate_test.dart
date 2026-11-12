// The platform gate for lib/src/core, the Dart counterpart of packages/core's
// tsconfig + eslint gate. The core is a port of a platform-free TypeScript core,
// so it must stay free of Flutter and of the host: everything platform-shaped
// is injected from lib/src/platform.
//
// Fail-closed: an import passes only if it stays inside lib/src/core or names a
// library on the allow-list below. Widening the list is a design decision, not
// a fix for a red gate.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const coreDir = 'lib/src/core';

/// Pure Dart: no I/O, no UI, no JS interop. dart:io is deliberately absent —
/// transport and storage live in lib/src/platform.
const allowedDartLibraries = {
  'dart:async',
  'dart:collection',
  'dart:convert',
  'dart:core',
  'dart:math',
  'dart:typed_data',
};

/// Third-party packages the core may use. Empty on purpose.
const allowedPackages = <String>{};

// `part` too: a part file's code runs under its library's imports, so `part` and
// `part of` must not cross the boundary either.
final _directive = RegExp(
  r'''^\s*(?:import|export|part)\s+([\s\S]*?);''',
  multiLine: true,
);
final _uri = RegExp(r'''['"]([^'"]+)['"]''');

/// [source] with its comments blanked out and its string literals kept.
///
/// One left-to-right pass rather than a regex per comment kind: that way a
/// comment marker inside a string (`'*/*'`, `'file:///x'`) or inside another
/// comment (`// src/*.ts`) cannot swallow the code after it. String
/// interpolation is not parsed, which is safe here: directives come before any
/// declaration, so no interpolated string can precede one.
String withoutComments(String source) {
  final out = StringBuffer();
  var i = 0;
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      final end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (source.startsWith('/*', i)) {
      // Dart block comments nest.
      var depth = 0;
      do {
        if (source.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (source.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      } while (depth > 0 && i < source.length);
      out.write(' ');
    } else if (source[i] == "'" || source[i] == '"') {
      final raw = i > 0 && source[i - 1] == 'r';
      final triple = source[i] * 3;
      final quote = source.startsWith(triple, i) ? triple : source[i];
      final start = i;
      i += quote.length;
      while (i < source.length && !source.startsWith(quote, i)) {
        i += !raw && source[i] == r'\' ? 2 : 1;
      }
      i = i < source.length ? i + quote.length : source.length;
      out.write(source.substring(start, i));
    } else {
      out.write(source[i]);
      i++;
    }
  }
  return out.toString();
}

/// Every URI a directive names: imports, exports and parts, conditional
/// imports included.
List<String> directiveUris(String source) {
  final code = withoutComments(source);
  return [
    for (final directive in _directive.allMatches(code))
      for (final uri in _uri.allMatches(directive.group(1)!)) uri.group(1)!,
  ];
}

/// Why [uri], imported from [file], is not allowed in the core, or null.
String? violation(String file, String uri) {
  if (uri.startsWith('dart:')) {
    return allowedDartLibraries.contains(uri)
        ? null
        : '$uri is not on the dart: allow-list';
  }
  if (uri.startsWith('package:')) {
    // Normalised first, so `src/core/../platform/` cannot pass as the core.
    final normalized = Uri.parse(uri).normalizePath().toString();
    const self = 'package:groundcover_rum/src/core/';
    if (normalized.startsWith(self)) return null;
    final package = normalized.substring('package:'.length).split('/').first;
    if (package == 'groundcover_rum') {
      return '$uri reaches outside $coreDir';
    }
    return allowedPackages.contains(package)
        ? null
        : 'package:$package is not on the allow-list';
  }
  // A relative path: it must resolve inside the core directory.
  final resolved = File(file).parent.uri.resolve(uri).toFilePath();
  final root = Directory(coreDir).absolute.uri.toFilePath();
  return File(resolved).absolute.path.startsWith(root)
      ? null
      : '$uri reaches outside $coreDir';
}

void main() {
  test('lib/src/core imports only itself and pure dart: libraries', () {
    final dir = Directory(coreDir);
    expect(dir.existsSync(), isTrue, reason: 'run from packages/flutter');

    final files = dir
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'))
        .toList();
    expect(files, isNotEmpty);

    final problems = [
      for (final file in files)
        for (final uri in directiveUris(file.readAsStringSync()))
          if (violation(file.path, uri) case final reason?)
            '${file.path}: $reason',
    ];
    expect(
      problems,
      isEmpty,
      reason: 'the core must stay platform-free; see this file',
    );
  });

  // The gate is only worth something if it can fail. These pin the judgements
  // it makes, without having to plant a bad file in lib/src/core.
  group('violation', () {
    const file = '$coreDir/session.dart';

    test('rejects Flutter, dart:ui, dart:io and other layers', () {
      expect(violation(file, 'package:flutter/widgets.dart'), isNotNull);
      expect(violation(file, 'dart:ui'), isNotNull);
      expect(violation(file, 'dart:io'), isNotNull);
      expect(
        violation(file, 'package:groundcover_rum/src/platform/platform.dart'),
        isNotNull,
      );
      expect(violation(file, '../platform/platform.dart'), isNotNull);
      expect(
        violation(
          file,
          'package:groundcover_rum/src/core/../platform/platform.dart',
        ),
        isNotNull,
      );
    });

    test('accepts the core itself and the pure dart: libraries', () {
      expect(violation(file, 'dart:convert'), isNull);
      expect(violation(file, 'events.dart'), isNull);
      expect(
        violation(file, 'package:groundcover_rum/src/core/events.dart'),
        isNull,
      );
    });

    test(
      'reads every URI, including conditional imports and ones split over lines',
      () {
        const source = '''
// import 'package:flutter/material.dart';
import 'dart:convert';
import 'stub.dart'
    if (dart.library.io) 'package:flutter/foundation.dart';
export "events.dart";
''';
        expect(directiveUris(source), [
          'dart:convert',
          'stub.dart',
          'package:flutter/foundation.dart',
          'events.dart',
        ]);
      },
    );

    test('a comment marker inside a comment or a string hides nothing', () {
      const source = '''
// Port of packages/core/ts/src/session/*.ts
import 'dart:io';
/* nested /* block */ comment */
part 'session_part.dart';
const accept = '*/*';
const home = 'file:///tmp';
''';
      expect(directiveUris(source), ['dart:io', 'session_part.dart']);
    });
  });
}
