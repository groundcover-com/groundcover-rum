#!/usr/bin/env bash
# Checks a tree build-mirror.sh wrote, the way customers will use it. release-ios.yml runs it
# before anything reaches groundcover-rum-ios.
#
#   packages/ios/scripts/check-mirror.sh <dir> <version>
#
# 1. The tree builds as a package of its own, for the simulator and for devices, with nothing from
#    this repository around it.
# 2. An app's package resolves it as the README says to, by version from a git repository tagged
#    <version>, and builds against all three products.
#
# Both build from copies in a temporary directory, so <dir> is left exactly as it was: SwiftPM
# writes .swiftpm/ and Package.resolved next to any manifest it builds.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <dir> <version>" >&2
  exit 2
fi
mirror="$(cd "$1" && pwd)"
version="$2"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

copy_tree() {
  mkdir -p "$2"
  (cd "$1" && tar --exclude ./.git -cf - .) | (cd "$2" && tar -xf -)
}

echo "== the package on its own"
copy_tree "$mirror" "$work/standalone"
for destination in 'generic/platform=iOS Simulator' 'generic/platform=iOS'; do
  (cd "$work/standalone" && xcodebuild build -quiet \
    -scheme GroundcoverRum-Package \
    -destination "$destination" \
    -derivedDataPath "$work/standalone-dd")
done

echo "== an app's package, resolving $version by tag"
# Named as the real repository, since SwiftPM names a package after its URL's last component and
# the README's `package: "groundcover-rum-ios"` must resolve.
repo="$work/groundcover-rum-ios"
copy_tree "$mirror" "$repo"
git -C "$repo" init -q -b main
git -C "$repo" add -A
git -C "$repo" -c user.name=check-mirror -c user.email=check-mirror@localhost \
  commit -q -m "GroundcoverRum $version"
git -C "$repo" tag "$version"

consumer="$work/consumer"
mkdir -p "$consumer/Sources/MirrorConsumer"
cat > "$consumer/Package.swift" <<EOF
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MirrorConsumer",
    platforms: [.iOS(.v15)],
    products: [.library(name: "MirrorConsumer", targets: ["MirrorConsumer"])],
    dependencies: [
        .package(url: "file://$repo", exact: "$version"),
    ],
    targets: [
        .target(
            name: "MirrorConsumer",
            dependencies: [
                .product(name: "GroundcoverRum", package: "groundcover-rum-ios"),
                .product(name: "GroundcoverRumObjC", package: "groundcover-rum-ios"),
                .product(name: "GroundcoverRumSwiftLog", package: "groundcover-rum-ios"),
            ]
        ),
    ]
)
EOF
cat > "$consumer/Sources/MirrorConsumer/Start.swift" <<'EOF'
import GroundcoverRum
import GroundcoverRumObjC
import GroundcoverRumSwiftLog

public func startGroundcover() throws {
    try Groundcover.start(GroundcoverConfig(
        apiKey: "key",
        dsn: "https://example.invalid",
        cluster: "cluster",
        environment: "check",
        appId: "mirror-check"))
    _ = GroundcoverLogHandler(label: "mirror-check")
    _ = GCRum.self
}
EOF
(cd "$consumer" && xcodebuild build -quiet \
  -scheme MirrorConsumer \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$work/consumer-dd")
resolved="$(find "$consumer" -name Package.resolved -print -quit)"
if [[ -z "$resolved" ]] || ! grep -q "\"version\" : \"$version\"" "$resolved"; then
  echo "error: the app's package didn't resolve groundcover-rum-ios at $version" >&2
  exit 1
fi

echo "groundcover-rum-ios $version: builds on its own and from an app's package"
