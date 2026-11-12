#!/usr/bin/env bash
# Whether the Android e2e run may install the apk sitting in artifacts/ instead of
# rebuilding it.
#
# Its own file because it is the one JUDGEMENT in ci-android-e2e.sh — the rest of that
# script is device plumbing that needs a device to mean anything, while this needs only
# a file and two environment variables, and getting it wrong is silent. Sourced by the
# script; exercised directly by support/apk-reuse.test.ts.
#
# Sourced, so no `set -e` and no side effects at load.

APK_PATH="apps/rn-playground/artifacts/android/app-debug.apk"

# 0 = install what is there, 1 = build it.
#
# The file existing is necessary but not sufficient: it says nothing about whether the
# apk matches the tree. `artifacts/` is gitignored, so a build from an earlier branch
# survives indefinitely, and a native-level change — a react-native-screens bump edits
# android/src/main/cpp — lands only in a rebuilt binary. Reinstalling the leftover runs
# the whole suite against the wrong native code and reports normally while doing it.
#
# What makes an apk trustworthy is a KEY, and only CI has one: the workflow restores it
# on a hash of the native sources (or, when the cache misses, downloads the one this run
# built) and hard-fails when it is missing, so on a runner the file is by construction
# the right one, and a re-run never rebuilds what an earlier attempt just built.
#
# GITHUB_ACTIONS, not CI: ci-android-e2e.sh sets CI=false for the Metro subshell on
# purpose, and developers export CI locally often enough to matter.
#
# Locally the answer is therefore "rebuild", with APK_CACHE_HIT=true as the opt-out for
# someone who knows their apk is current — which is what the e2e README
# (tests/e2e/mobile/README.md) documents.
should_reuse_apk() {
  local apk="${1:-$APK_PATH}"
  [ -f "$apk" ] || return 1
  [ "${APK_CACHE_HIT:-}" = "true" ] && return 0
  [ -n "${GITHUB_ACTIONS:-}" ] && return 0
  return 1
}
