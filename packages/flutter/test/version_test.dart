import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/version.dart';

void main() {
  test('the reported sdk.version is the pubspec version', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final version = RegExp(
      r'^version:\s*(\S+)',
      multiLine: true,
    ).firstMatch(pubspec)![1];
    expect(sdkVersion, version);
  });

  test('the podspec carries the pubspec version', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final podspec = File('ios/groundcover_rum.podspec').readAsStringSync();
    final version = RegExp(
      r'^version:\s*(\S+)',
      multiLine: true,
    ).firstMatch(pubspec)![1];
    final podVersion = RegExp(
      r"^\s*s\.version\s*=\s*'([^']+)'",
      multiLine: true,
    ).firstMatch(podspec)![1];
    expect(podVersion, version);
  });
}
