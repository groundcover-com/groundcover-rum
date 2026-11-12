// swift-tools-version: 5.9

import PackageDescription

// GroundcoverRum, groundcover's native iOS RUM SDK.
let package = Package(
    name: "GroundcoverRum",
    platforms: [
        // RN and Flutter keep the engine's 13.4; the native SDKs start at iOS 15.
        .iOS(.v15)
    ],
    products: [
        .library(name: "GroundcoverRum", targets: ["GroundcoverRum"]),
        .library(name: "GroundcoverRumObjC", targets: ["GroundcoverRumObjC"]),
        // The swift-log bridge, a product of its own so an app that doesn't use swift-log never
        // links it.
        .library(name: "GroundcoverRumSwiftLog", targets: ["GroundcoverRumSwiftLog"]),
    ],
    dependencies: [
        // The crash reporter's recorder, in the Flutter plugin's range. An exact pin would stop
        // SwiftPM resolving this package beside another package that pins its own version.
        .package(url: "https://github.com/kstenerud/KSCrash.git", "2.2.0"..<"3.0.0"),
        // For GroundcoverRumSwiftLog only. A range, for the same reason as KSCrash's.
        .package(url: "https://github.com/apple/swift-log.git", "1.5.0"..<"2.0.0"),
    ],
    targets: [
        // The SDK: its API, capture and pipeline, with the engine compiled into the same module,
        // so what the engine marks `internal` stays visible to it.
        .target(
            name: "GroundcoverRum",
            dependencies: [
                .product(name: "Recording", package: "KSCrash"),
                "GroundcoverRumBoot",
            ],
            // Apple's privacy manifest, bundled with the SDK.
            resources: [.process("PrivacyInfo.xcprivacy")]
        ),
        // The engine's Objective-C launch anchors (GCRumProcessBoot), stamped from a load-time
        // constructor. Their own target because a Swift package can't mix Objective-C into the
        // Swift target that reads them, as in the Flutter plugin.
        .target(
            name: "GroundcoverRumBoot",
            linkerSettings: [
                .linkedFramework("QuartzCore"),
                .linkedFramework("UIKit"),
            ]
        ),
        // The Objective-C facade: @objc classes over the Swift API, for Objective-C and
        // Objective-C++ hosts. Swift, not Objective-C, because Objective-C can't call the
        // Swift structs and enums it wraps.
        .target(
            name: "GroundcoverRumObjC",
            dependencies: ["GroundcoverRum"]
        ),
        // A swift-log LogHandler that sends what an app logs through swift-log as log events.
        .target(
            name: "GroundcoverRumSwiftLog",
            dependencies: [
                "GroundcoverRum",
                .product(name: "Logging", package: "swift-log"),
            ]
        ),
    ]
)

// MARK: - Development only
//
// groundcover-rum-ios, the repository customers install from, gets this manifest down to the
// line above: scripts/build-mirror.sh cuts it there. The rest is for this repository alone.
//
// Sources/GroundcoverRum/Engine and Sources/GroundcoverRumBoot are the native engine, copied from
// packages/core by scripts/vendor-engine.mjs and git-ignored. Run `node scripts/vendor-engine.mjs`
// (or `pnpm install`) before building from a fresh checkout, and edit the engine under
// packages/core.
package.targets += [
    // Run on a simulator: `xcodebuild test -scheme GroundcoverRum-Package -destination
    // 'platform=iOS Simulator,name=<a simulator>'`. `swift test` can't run them, since the
    // package is iOS only.
    .testTarget(
        name: "GroundcoverRumTests",
        dependencies: ["GroundcoverRum", "GroundcoverRumObjC", "GroundcoverRumSwiftLog"],
        // packages/core/wire, through a symlink: the golden reads the shared fixtures from the
        // test bundle, since a simulator test can't read the checkout itself everywhere.
        resources: [.copy("Wire")]
    ),
    // The Objective-C facade, called from Objective-C, as an Objective-C host calls it.
    .testTarget(
        name: "GroundcoverRumObjCTests",
        dependencies: ["GroundcoverRumObjC"]
    ),
]
