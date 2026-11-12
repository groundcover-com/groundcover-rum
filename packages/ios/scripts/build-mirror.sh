#!/usr/bin/env bash
# Writes the iOS SDK as groundcover-rum-ios ships it into a directory: the repository iOS customers
# install from, with Package.swift at its root. release-ios.yml runs it, checks the result with
# check-mirror.sh, and pushes it to the mirror.
#
#   packages/ios/scripts/build-mirror.sh <dir>
#
# <dir> is created when missing, and must be outside this repository. A git checkout (the mirror's
# own clone) has everything but its .git replaced; any other directory must be empty.
#
# The mirror holds only what SwiftPM builds and what a customer reads:
# - Package.swift: this package's manifest down to its "MARK: - Development only" line, so without
#   the test targets;
# - Sources/: the tracked sources, plus the engine copy scripts/vendor-engine.mjs writes;
# - api/: the public API files the README links to;
# - README.md, CHANGELOG.md and LICENSE.
# Tests/ stays out (its wire fixtures are a symlink into packages/core), and so does scripts/.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <dir>" >&2
  exit 2
fi

pkg="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$pkg/../.." && pwd)"
out="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

case "$out/" in
  "$root"/*)
    echo "error: write the mirror outside this repository, not $out" >&2
    exit 1
    ;;
esac
mkdir -p "$out"
if [[ ! -d "$out/.git" && -n "$(ls -A "$out")" ]]; then
  echo "error: $out is neither empty nor a git checkout" >&2
  exit 1
fi

marker='// MARK: - Development only'
if ! grep -qxF "$marker" "$pkg/Package.swift"; then
  echo "error: Package.swift has no '$marker' line to cut the mirror's manifest at" >&2
  exit 1
fi

# The engine copy is git-ignored; write it from packages/core, so a stale one can't ship.
node "$root/scripts/vendor-engine.mjs" > /dev/null

find "$out" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

# The manifest down to the marker, without the blank lines before it.
awk -v marker="$marker" '
  $0 == marker { exit }
  /^$/ { blanks++; next }
  { while (blanks > 0) { print ""; blanks-- } print }
' "$pkg/Package.swift" > "$out/Package.swift"

# Tracked files only, so nothing a developer left untracked in Sources/ ships.
(cd "$pkg" && git ls-files -z -- Sources api README.md CHANGELOG.md LICENSE) \
  | (cd "$pkg" && tar --null -T - -cf -) \
  | (cd "$out" && tar -xf -)
# The engine copy, as vendor-engine.mjs wrote it.
for engine in Sources/GroundcoverRum/Engine Sources/GroundcoverRumBoot; do
  mkdir -p "$out/$engine"
  (cd "$pkg/$engine" && tar --exclude .DS_Store -cf - .) | (cd "$out/$engine" && tar -xf -)
done

# What the mirror must never hold, whatever changes above.
if grep -q 'testTarget' "$out/Package.swift"; then
  echo "error: the mirror's Package.swift declares a test target" >&2
  exit 1
fi
links="$(find "$out" -path "$out/.git" -prune -o -type l -print)"
if [[ -n "$links" ]]; then
  echo "error: the mirror would hold symlinks:" >&2
  echo "$links" >&2
  exit 1
fi
for required in Package.swift README.md CHANGELOG.md LICENSE \
  Sources/GroundcoverRum/PrivacyInfo.xcprivacy \
  Sources/GroundcoverRumBoot/include/GCRumProcessBoot.h; do
  if [[ ! -f "$out/$required" ]]; then
    echo "error: the mirror has no $required" >&2
    exit 1
  fi
done

count="$(find "$out" -path "$out/.git" -prune -o -type f -print | wc -l | tr -d ' ')"
echo "groundcover-rum-ios: $count files in $out"
