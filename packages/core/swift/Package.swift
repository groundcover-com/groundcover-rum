// swift-tools-version:5.9
import PackageDescription

// Toolchain note: the manifest is 5.9, but `swift test` here needs Swift 6 /
// Xcode 16 or newer, because the test target uses swift-testing (`import
// Testing`), which ships with the 6.0 toolchain. The tools-version stays at 5.9
// deliberately — 6.0 would default every target to the Swift 6 language mode and
// put strict-concurrency diagnostics across the whole engine, which buys nothing
// for a manifest whose only job is to run pure-logic tests.

// A test harness for the engine's PURE logic — not how the engine ships. Each SDK ships
// a vendored copy of Engine/ (scripts/vendor-engine.mjs); React Native's goes out through
// packages/react-native/GroundcoverRum.podspec. A pod cannot be tested without an Xcode
// project and a simulator, which is too much ceremony for the pieces that break most
// easily (a renamed KSCrash key surfaces only as a missing attribute on a crash nobody
// is watching).
//
// So the files with no KSCrash and no UIKit dependency are also a plain SwiftPM target
// that `swift test` runs in seconds; the rest stay out of `sources` and are covered by
// e2e. That is why the trackers are split as they are — adding a UIKit import to any
// file listed below breaks `swift test`, which is the intended pressure.
let package = Package(
    name: "GroundcoverRumEngine",
    platforms: [.iOS(.v13), .macOS(.v12)],
    products: [
        .library(name: "GroundcoverRumEngine", targets: ["GroundcoverRumEngine"]),
    ],
    targets: [
        .target(
            name: "GroundcoverRumEngine",
            path: "Engine",
            // Everything not listed in `sources` must be excluded too, or SwiftPM
            // warns "found N file(s) which are unhandled" on every build. These are the
            // UIKit- and ObjC-dependent units `swift test` cannot compile; they share
            // directories with pure-logic sources (Vitals, Gestures, AppStart, Hang…),
            // so they cannot be excluded by directory and must be listed one by one.
            // The invariant: adding a UIKit/ObjC file the engine ships must add it here.
            exclude: [
                "GCRumEngine.swift",
                "GCRumMainThread.swift",
                "Crash/GCRumCrashReporter.swift",
                "AppStart/GCRumAppStartTracker.swift",
                // Both halves of the ObjC unit. Swift 6 SwiftPM treats a lone header as
                // handled and does not flag it, but SwiftPM 5.9 warns it is unhandled;
                // exclude it alongside its .m so the manifest is clean on either.
                "AppStart/GCRumProcessBoot.h",
                "AppStart/GCRumProcessBoot.m",
                "Gestures/GCRumGestureTracker.swift",
                "Gestures/GCRumTouchDownRecognizer.swift",
                "Hang/GCRumHangWatchdog.swift",
                "Vitals/GCRumFrameTracker.swift",
            ],
            sources: [
                "GCRumEngineConfig.swift",
                "GCRumDeviceInfo.swift",
                "Crash/GCRumCrashReportMapper.swift",
                "Crash/GCRumSessionSnapshotStore.swift",
                "Vitals/GCRumFrameAggregator.swift",
                "Gestures/GCRumGestureClassifier.swift",
                "Gestures/GCRumAttachmentRegistry.swift",
                "Gestures/GCRumPanSequences.swift",
                "AppStart/GCRumAppStartRules.swift",
                "Hang/GCRumHangRules.swift",
                "Lifecycle/GCRumNotificationObservers.swift",
            ]
        ),
        .testTarget(
            name: "GroundcoverRumEngineTests",
            dependencies: ["GroundcoverRumEngine"],
            path: "EngineTests"
        ),
    ]
)
