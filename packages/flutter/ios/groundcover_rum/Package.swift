// swift-tools-version: 5.9

import PackageDescription

// The plugin's Swift Package Manager manifest, which Flutter uses when an app has SwiftPM
// enabled. SPM-first because CocoaPods trunk goes read-only on 2026-12-02; the podspec next to
// this directory stays for apps that still use CocoaPods, and the two must list the same
// sources, dependencies and floor.
//
// Sources/groundcover_rum/Engine and Sources/GroundcoverRumBoot are the native engine.
let package = Package(
    name: "groundcover_rum",
    platforms: [
        // The engine's floor, as in the RN podspec.
        .iOS("13.4")
    ],
    products: [
        .library(name: "groundcover-rum", targets: ["groundcover_rum"])
    ],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework"),
        // The crash reporter's recorder, at the floor the RN podspec pins (`~> 2.2`).
        .package(url: "https://github.com/kstenerud/KSCrash.git", "2.2.0"..<"3.0.0"),
    ],
    targets: [
        .target(
            name: "groundcover_rum",
            dependencies: [
                .product(name: "FlutterFramework", package: "FlutterFramework"),
                .product(name: "Recording", package: "KSCrash"),
                "GroundcoverRumBoot",
            ],
            // Apple's privacy manifest: the required-reason APIs the plugin and the engine call
            // (UserDefaults, file timestamps), and the data the SDK collects. The podspec bundles
            // the same file.
            resources: [.process("PrivacyInfo.xcprivacy")]
        ),
        // The engine's Objective-C launch anchors (GCRumProcessBoot), stamped from a load-time
        // constructor. Their own target because a Swift package can't mix Objective-C into the
        // Swift target that reads them.
        .target(
            name: "GroundcoverRumBoot",
            linkerSettings: [
                .linkedFramework("QuartzCore"),
                .linkedFramework("UIKit"),
            ]
        ),
    ]
)
