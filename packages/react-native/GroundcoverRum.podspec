require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "GroundcoverRum"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => "13.4" }

  # Required, not optional: the pod is mostly Swift, and with no swift_version
  # here and no .swift-version file CocoaPods falls back to the host target's
  # SWIFT_VERSION — which the RN template did not define until it gained a Swift
  # AppDelegate in 0.77. Below that, `pod install` fails outright with "Unable to
  # determine Swift version for the following pods".
  s.swift_version = "5.0"
  s.source       = { :http => "https://registry.npmjs.org/@groundcover/react-native/-/react-native-#{s.version}.tgz" }

  s.default_subspec = "Bridge"

  # The engine is deliberately React-free (the native iOS SDK builds the same
  # engine); the RN bridge is a thin adapter on top. CocoaPods
  # enforces the boundary at build time — an accidental `import React` in the
  # engine fails to compile here rather than being caught in review.
  s.subspec "Engine" do |engine|
    engine.source_files = "ios/Engine/**/*.{h,m,mm,swift}"
    engine.dependency "KSCrash/Recording", "~> 2.2"

    # Apple's privacy manifest. It goes in a resource bundle rather than `resources` because pods
    # link as static libraries by default, and a static library has no bundle of its own to carry
    # the file. A bundle is where Xcode's privacy report and App Store Connect look for it. It
    # lives on the engine because every install includes the engine (Bridge depends on it).
    engine.resource_bundles = { "GroundcoverRum_Privacy" => ["ios/PrivacyInfo.xcprivacy"] }
  end

  s.subspec "Bridge" do |bridge|
    bridge.source_files = "ios/Bridge/**/*.{h,m,mm,swift}"
    bridge.dependency "GroundcoverRum/Engine"
    bridge.dependency "React-Core"
  end
end
