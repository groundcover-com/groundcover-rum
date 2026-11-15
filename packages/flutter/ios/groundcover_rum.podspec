# The CocoaPods half of the iOS plugin; groundcover_rum/Package.swift is the Swift Package
# Manager half. Keep their sources, dependencies and floor in step.
Pod::Spec.new do |s|
  s.name             = 'groundcover_rum'
  # The pubspec's version; the package's tests keep the two equal.
  s.version          = '0.0.1-rc.2'
  s.summary          = 'groundcover Real User Monitoring (RUM) SDK for Flutter.'
  s.homepage         = 'https://docs.groundcover.com/investigate/real-user-monitoring-rum'
  s.license          = { :file => '../LICENSE' }
  s.author           = 'groundcover'
  s.source           = { :path => '.' }
  # The plugin, plus the native engine: its Swift under groundcover_rum/Engine, and its Objective-C
  # launch anchors under GroundcoverRumBoot (their own target in the Swift package; one module
  # here, where CocoaPods mixes the two languages).
  s.source_files     = [
    'groundcover_rum/Sources/groundcover_rum/**/*.swift',
    'groundcover_rum/Sources/GroundcoverRumBoot/**/*.{h,m}',
  ]
  # Apple's privacy manifest, the same file the Swift package processes.
  s.resource_bundles = {
    'groundcover_rum_privacy' => ['groundcover_rum/Sources/groundcover_rum/PrivacyInfo.xcprivacy']
  }
  s.dependency 'Flutter'
  # As in the RN podspec's Engine subspec.
  s.dependency 'KSCrash/Recording', '~> 2.2'
  # The engine's floor, as in the RN podspec.
  s.platform = :ios, '13.4'

  # Flutter.framework does not contain a i386 slice.
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.swift_version = '5.0'
end
