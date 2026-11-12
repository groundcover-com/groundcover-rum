import Foundation
import GroundcoverRum
import ObjectiveC
import Testing

@testable import GroundcoverRumObjC

// The Objective-C facade's options land where the Swift config expects them. Its own tests call
// it from Objective-C, where a swapped or truncated value still starts the SDK, so the mapping is
// checked here, value by value.

@Suite struct FacadeMappingTests {
    private func config() -> GCRumConfig {
        GCRumConfig(apiKey: "key", dsn: "dsn", cluster: "c", environment: "dev", appId: "app")
    }

    @Test func everyFacadeOptionReachesTheSwiftConfig() throws {
        let config = config()
        config.namespaceName = "ns"
        config.releaseId = "1.0.0"
        config.sessionId = "fixed"
        config.user = GCRumUser(id: "u_123")
        config.enabledEvents = ["interaction", "appStart"]
        config.sessionSampleRate = 0.25
        // Fractions of a second, so a conversion through an integer would show.
        config.sessionMaxDuration = 0.5
        config.debug = true
        config.excludedUrls = [
            "https://api.example.com/health", try NSRegularExpression(pattern: "/m$"),
        ]
        config.privacyLevel = .maskAll
        config.propagationUrls = ["https://api.myapp.com/*"]
        config.batchSize = 20
        config.batchTimeout = 0.5
        config.compression = false
        config.appVersion = "1.2.3"
        config.appBuild = "45"
        config.hangThreshold = 1.5
        config.vitalsMaxSegment = 30.5
        config.manualTimeToInteractive = true
        config.viewControllerHook = false
        config.touchesHook = true
        config.textFieldsHook = false
        config.urlSessionHook = false

        let swift = try config.swiftConfig()
        #expect(swift.namespace == "ns")
        #expect(swift.releaseId == "1.0.0")
        #expect(swift.sessionId == "fixed")
        #expect(swift.user?.id == "u_123")
        let options = swift.options
        #expect(options.enabledEvents == [.interaction, .appStart])
        #expect(options.sessionSampleRate == 0.25)
        #expect(options.sessionMaxDuration == 0.5)
        #expect(options.debug == true)
        let excluded = try #require(options.excludedUrls)
        #expect(excluded.count == 2)
        if case .string(let url) = excluded[0] {
            #expect(url == "https://api.example.com/health")
        } else {
            Issue.record("the first excluded URL isn't a string")
        }
        if case .regex(let regex) = excluded[1] {
            #expect(regex.pattern == "/m$")
        } else {
            Issue.record("the second excluded URL isn't a regex")
        }
        #expect(options.privacy?.level == .maskAll)
        #expect(options.tracing?.propagationUrls == ["https://api.myapp.com/*"])
        #expect(options.transport?.batchSize == 20)
        #expect(options.transport?.batchTimeout == 0.5)
        #expect(options.transport?.compression == false)
        #expect(options.appVersion == "1.2.3")
        #expect(options.appBuild == "45")
        #expect(options.native?.hangThreshold == 1.5)
        #expect(options.native?.vitalsMaxSegment == 30.5)
        #expect(options.native?.tti == .manual)
        #expect(!options.hooks.viewControllers)
        #expect(options.hooks.touches)
        #expect(!options.hooks.textFields)
        #expect(!options.hooks.urlSession)
    }

    // An Objective-C app filters and scrubs through the same hooks a Swift app does: custom events
    // are never redacted, so enrichEvent is the one place their contents can be cleaned.
    @Test func theHooksAndRedactionKeysReachTheSwiftConfig() throws {
        let config = config()
        config.sensitiveKeys = ["pin", "otp"]
        config.maskInteractionLabels = true
        config.beforeSend = { event in event.type != "log" }
        config.enrichEvent = { event in
            event.attributes["email"] = nil
            event.attributes["tier"] = "gold"
        }
        let options = try config.swiftConfig().options

        #expect(options.privacy?.level == nil)
        #expect(options.privacy?.sensitiveKeys == ["pin", "otp"])
        #expect(options.privacy?.maskInteractionLabels == true)
        let log = RumEvent(type: "log", id: "1", spanId: "s", attributes: ["email": "a@b.c"])
        let custom = RumEvent(type: "custom", id: "2", spanId: "s", attributes: ["email": "a@b.c"])
        #expect(try options.beforeSend?(log) == false)
        #expect(try options.beforeSend?(custom) == true)
        let enriched = try #require(try options.enrichEvent?(custom))
        #expect(enriched.attributes["email"] == nil)
        #expect(enriched.attributes["tier"] as? String == "gold")
    }

    @Test func unsetOptionsStayDefaults() throws {
        let options = try config().swiftConfig().options
        #expect(options.enabledEvents == nil)
        #expect(options.sessionSampleRate == nil)
        #expect(options.debug == nil)
        #expect(options.excludedUrls == nil)
        #expect(options.privacy == nil)
        #expect(options.beforeSend == nil && options.enrichEvent == nil)
        #expect(options.tracing == nil)
        #expect(options.native?.tti == nil)
        #expect(
            options.hooks.viewControllers && options.hooks.touches && options.hooks.textFields
                && options.hooks.urlSession)
    }

    @Test func anUnknownEventNameFailsRatherThanEnablingEverything() {
        let config = config()
        config.enabledEvents = ["crash"]
        #expect(throws: GroundcoverInitError.self) { try config.swiftConfig() }
    }

    @Test func anExcludedUrlOfAnotherTypeFails() {
        let config = config()
        config.excludedUrls = [URL(string: "https://api.example.com/secret")!]
        #expect(throws: GroundcoverInitError.self) { try config.swiftConfig() }
    }

    /// The facade is for Objective-C++ hosts too, where a C++ keyword can't be a property or a
    /// selector piece (`namespace` is one, hence `namespaceName`). Read off the Objective-C
    /// runtime, as a host sees it.
    @Test func noFacadeNameIsACxxKeyword() {
        let keywords: Set<String> = [
            "alignas", "alignof", "and", "asm", "auto", "bool", "catch", "char", "class", "const",
            "constexpr", "decltype", "delete", "explicit", "export", "extern", "false", "float",
            "friend", "inline", "int", "long", "mutable", "namespace", "new", "noexcept", "not",
            "nullptr", "operator", "or", "private", "protected", "public", "register", "short",
            "signed", "sizeof", "static", "struct", "template", "this", "throw", "true", "try",
            "typedef", "typeid", "typename", "union", "unsigned", "using", "virtual", "void",
            "volatile", "xor",
        ]
        var names: [String] = []
        for type in [GCRum.self, GCRumConfig.self, GCRumUser.self, GCRumTesting.self] as [AnyClass]
        {
            for cls in [type, object_getClass(type)!] {
                var count: UInt32 = 0
                if let properties = class_copyPropertyList(cls, &count) {
                    names += (0..<Int(count)).map {
                        String(cString: property_getName(properties[$0]))
                    }
                    free(properties)
                }
                if let methods = class_copyMethodList(cls, &count) {
                    names += (0..<Int(count)).flatMap {
                        NSStringFromSelector(method_getName(methods[$0])).split(separator: ":")
                            .map(String.init)
                    }
                    free(methods)
                }
            }
        }
        #expect(names.contains("namespaceName"))
        #expect(names.filter(keywords.contains) == [])
    }
}
