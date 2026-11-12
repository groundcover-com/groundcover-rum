#!/usr/bin/env bash
# Writes NativePlayground.xcodeproj from project.yml, with the package versions this app pins.
#
#   apps/ios-playground/generate.sh            # after a change to project.yml, or in a fresh clone
#
# The project is build output (git-ignored), so the pins live beside project.yml as
# Package.resolved and are copied into the project, where Xcode reads them. After resolving
# newer versions on purpose, copy the project's file back over Package.resolved and commit it.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v xcodegen > /dev/null; then
  echo "error: XcodeGen is not installed (brew install xcodegen)" >&2
  exit 1
fi

xcodegen generate --spec project.yml --quiet

resolved=NativePlayground.xcodeproj/project.xcworkspace/xcshareddata/swiftpm
mkdir -p "$resolved"
if [[ -f Package.resolved ]]; then
  cp Package.resolved "$resolved/Package.resolved"
fi
