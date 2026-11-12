#!/usr/bin/env bash
# Checks the native iOS SDK's public Swift API against the files in api/, or with --update,
# rewrites them. Same command on a developer's Mac and in Native iOS CI.
#
#   packages/ios/scripts/api-surface.sh            # exit 1 when the API changed
#   packages/ios/scripts/api-surface.sh --update   # accept the change; commit api/
#
# The API files are the module interfaces the compiler prints for a library-evolution build:
# every public declaration, as Swift. They are the Swift counterpart of the Android library's
# .api file, so a PR that changes what customers can call shows it as a diff in api/. What
# changes with the compiler rather than the code is left out or normalised: the `// swift-`
# header (compiler version and flags), the toolchain's own `_`-prefixed implicit imports, and
# module selectors. Xcode 27's compiler prints `Swift::String` and
# `GroundcoverRum::Outer.GroundcoverRum::Inner` where Xcode 26's prints `Swift.String` and
# `GroundcoverRum.Outer.Inner`; the files keep the second spelling, whichever Xcode printed them.
#
# It builds the package for the simulator (both slices; the arm64 one is read), so it is also
# a build check: the SDK and its Objective-C facade have to compile with library evolution on.
# The build warns that "scoped imports are not yet supported in module interfaces": that is the
# resource accessor SwiftPM generates for the privacy manifest, and it doesn't reach the API files.
#
# GroundcoverRumSwiftLog is built apart, with its interface printed but library evolution off:
# swift-log itself doesn't compile with it on, and the flag reaches every target in a build.
# Without library evolution the compiler also prints a struct's non-public stored properties and
# `@_hasInitialValue`, which customers can't see, so those are dropped from that module's file.
#
# Enum raw values aren't in any API file (a resilient interface prints the cases alone); the
# SDK's tests pin them (PublicAPITests.theRawValuesAreTheContract).
set -euo pipefail

cd "$(dirname "$0")/.."

update=false
if [[ "${1:-}" == "--update" ]]; then
  update=true
fi

MODULES=(GroundcoverRum GroundcoverRumObjC GroundcoverRumSwiftLog)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The package compiles the git-ignored copy of the engine; write it first, so a stale copy can't
# stand in for the code under review.
node ../../scripts/vendor-engine.mjs > /dev/null

# The facade's scheme builds the SDK too.
xcodebuild build -quiet \
  -scheme GroundcoverRumObjC \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$work/DerivedData" \
  BUILD_LIBRARY_FOR_DISTRIBUTION=YES

# The compiler warns that interfaces need library evolution, once per module and slice.
xcodebuild build -quiet \
  -scheme GroundcoverRumSwiftLog \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$work/DerivedDataSwiftLog" \
  SWIFT_EMIT_MODULE_INTERFACE=YES 2>&1 \
  | { grep -v 'module interfaces are only supported with -enable-library-evolution' || true; }

products="$work/DerivedData/Build/Products/Debug-iphonesimulator"
cp -R "$work/DerivedDataSwiftLog/Build/Products/Debug-iphonesimulator/GroundcoverRumSwiftLog.swiftmodule" \
  "$products/"
changed=0
for module in "${MODULES[@]}"; do
  printed="$products/$module.swiftmodule/arm64-apple-ios-simulator.swiftinterface"
  # A selector after a `.` qualifies a nested name and is dropped; any other becomes a `.`.
  grep -vE '^(// swift-|import _)' "$printed" \
    | sed -E 's/\.[A-Za-z_][A-Za-z0-9_]*::/./g; s/::/./g' > "$work/$module.swiftinterface"
  if [[ "$module" == GroundcoverRumSwiftLog ]]; then
    # A non-public member, after any attributes, and the initial-value marker on public ones.
    grep -vE '^[[:space:]]*(@[A-Za-z_]+(\([^)]*\))?[[:space:]]+)*(private|fileprivate|internal)[[:space:](]' \
      "$work/$module.swiftinterface" | sed -E 's/@_hasInitialValue //' > "$work/$module.public"
    mv "$work/$module.public" "$work/$module.swiftinterface"
  fi
  committed="api/$module.swiftinterface"
  if $update; then
    mkdir -p api
    cp "$work/$module.swiftinterface" "$committed"
  elif ! diff -u "$committed" "$work/$module.swiftinterface"; then
    changed=1
  fi
done

if $update; then
  echo "api/ updated; review and commit it"
elif [[ $changed -ne 0 ]]; then
  echo "error: the public API differs from packages/ios/api (diff above)." >&2
  echo "If the change is intended, run packages/ios/scripts/api-surface.sh --update and commit api/." >&2
  exit 1
else
  echo "public API matches packages/ios/api"
fi
