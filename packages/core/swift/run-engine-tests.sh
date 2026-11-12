#!/usr/bin/env bash
# Runs the iOS engine's unit tests. Same command on a developer's Mac and in CI.
#
# On a machine with full Xcode selected, `swift test` just works. On one with
# only the Command Line Tools — which is the common case, and what a Mac without
# a 15GB Xcode install has — the swift-testing runtime IS present, but under
# Library/Developer rather than anywhere the compiler or dyld looks by default,
# so `swift test` fails with "no such module 'Testing'". The flags below point
# at it: -F for the compiler, -rpath so the built test bundle can still find it
# at load time (DYLD_FRAMEWORK_PATH does not survive into the SIP-protected
# helper that actually runs the bundle).
set -euo pipefail

cd "$(dirname "$0")"

DEVELOPER_DIR="$(xcode-select -p 2>/dev/null || echo "")"

if [[ "$DEVELOPER_DIR" == *"CommandLineTools"* ]]; then
  FRAMEWORKS="$DEVELOPER_DIR/Library/Developer/Frameworks"
  LIBS="$DEVELOPER_DIR/Library/Developer/usr/lib"

  if [[ ! -d "$FRAMEWORKS/Testing.framework" ]]; then
    echo "error: no Testing.framework under $FRAMEWORKS" >&2
    echo "Install a newer Command Line Tools release, or select full Xcode:" >&2
    echo "  sudo xcode-select -s /Applications/Xcode.app" >&2
    exit 1
  fi

  echo "Command Line Tools toolchain — pointing swift-testing at $FRAMEWORKS"
  exec swift test "$@" \
    -Xswiftc -F -Xswiftc "$FRAMEWORKS" \
    -Xlinker -F -Xlinker "$FRAMEWORKS" \
    -Xlinker -rpath -Xlinker "$FRAMEWORKS" \
    -Xlinker -rpath -Xlinker "$LIBS"
fi

exec swift test "$@"
