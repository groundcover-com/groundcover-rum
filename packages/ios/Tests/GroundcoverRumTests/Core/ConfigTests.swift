import Foundation
import Testing

@testable import GroundcoverRum

// The configuration the pipeline runs on: defaults, the DSN, the session cap, what an update may
// change and how it merges, and the privacy every capture path reads.

private func anInput(
    dsn: String = "ingest.example",
    user: RumUser? = nil,
    options: GroundcoverOptions = GroundcoverOptions()
) -> GroundcoverConfig {
    GroundcoverConfig(
        apiKey: "key", dsn: dsn, cluster: "cluster", environment: "env", appId: "app", user: user,
        options: options)
}

private func anUpdate(
    cluster: String? = nil,
    dsn: String? = nil,
    environment: String? = nil,
    releaseId: String? = nil,
    user: UserUpdate? = nil,
    options: GroundcoverOptionsUpdate? = nil
) -> GroundcoverConfigUpdate {
    GroundcoverConfigUpdate(
        dsn: dsn, cluster: cluster, environment: environment, releaseId: releaseId, user: user,
        options: options)
}

@Suite struct SdkConfigTests {
    @Test func appliesTheCoreDefaults() {
        let options = SdkConfig(anInput()).options
        #expect(options.sessionSampleRate == 1)
        #expect(options.debug == false)
        #expect(options.enabledEvents.isEmpty)
        #expect(options.sessionMaxDurationMs == defaultSessionMaxDurationMs)
        #expect(options.tracing.propagationUrls.isEmpty)
        #expect(options.tracing.traceIdHeaderName == "")
        #expect(options.tracing.origin.name == "")
        // resolvePrivacy owns the default, so it can tell an explicit level from an omitted one.
        #expect(options.privacy.level == nil)
    }

    @Test func theEndpointGainsHttpsOnlyWhenTheDsnNamesNoScheme() {
        #expect(SdkConfig(anInput()).endpoint == "https://ingest.example")
        #expect(
            SdkConfig(anInput(dsn: "http://localhost:9393")).endpoint == "http://localhost:9393")
    }

    @Test func aSessionCapWithin1MinuteTo8HoursIsKeptBothEndsIncluded() {
        for seconds: TimeInterval in [60, 6 * 3600, 8 * 3600] {
            let options = SdkConfig(
                anInput(options: GroundcoverOptions(sessionMaxDuration: seconds))
            )
            .options
            #expect(options.sessionMaxDurationMs == Int64(seconds * 1000))
        }
    }

    @Test func aSessionCapOutsideThatRangeFallsBackTo4Hours() {
        for seconds: TimeInterval in [59, 9 * 3600, 0, .nan] {
            let options = SdkConfig(
                anInput(options: GroundcoverOptions(sessionMaxDuration: seconds))
            )
            .options
            #expect(options.sessionMaxDurationMs == defaultSessionMaxDurationMs, "\(seconds)")
        }
    }

    @Test func theSessionCapIsKeptWhenAnUpdateOmitsItOrBringsAValueOutOfRange() {
        let config = SdkConfig(anInput(options: GroundcoverOptions(sessionMaxDuration: 2 * 3600)))
        config.update(anUpdate(options: GroundcoverOptionsUpdate(debug: true)))
        #expect(config.options.sessionMaxDurationMs == 2 * 3_600_000)
        config.update(anUpdate(options: GroundcoverOptionsUpdate(sessionMaxDuration: 12 * 3600)))
        // Out of range: the session keeps the cap it runs on, not a default the app never chose.
        #expect(config.options.sessionMaxDurationMs == 2 * 3_600_000)
        config.update(anUpdate(options: GroundcoverOptionsUpdate(sessionMaxDuration: 3600)))
        #expect(config.options.sessionMaxDurationMs == 3_600_000)
    }

    @Test func anUpdateMergesAPartialTracingOriginAndKeepsItsSiblingField() {
        let config = SdkConfig(
            anInput(
                options: GroundcoverOptions(
                    tracing: TracingOptions(
                        propagationUrls: ["https://a/*"],
                        origin: TracingOrigin(name: "n", value: "v")))))
        config.update(
            anUpdate(
                options: GroundcoverOptionsUpdate(
                    tracing: TracingOptions(traceIdHeaderName: "x-trace"))))
        let tracing = config.options.tracing
        #expect(tracing.propagationUrls == ["https://a/*"])
        #expect(tracing.traceIdHeaderName == "x-trace")
        #expect(tracing.origin.name == "n")
    }

    @Test func anUpdateReplacesListsWholesale() {
        let config = SdkConfig(
            anInput(
                options: GroundcoverOptions(tracing: TracingOptions(propagationUrls: ["a", "b"]))))
        config.update(
            anUpdate(
                options: GroundcoverOptionsUpdate(tracing: TracingOptions(propagationUrls: ["c"]))))
        #expect(config.options.tracing.propagationUrls == ["c"])
    }

    @Test func anUpdateMergesAPartialPrivacyInsteadOfReplacingIt() {
        let config = SdkConfig(
            anInput(
                options: GroundcoverOptions(
                    privacy: PrivacyOptions(level: .maskAll, sensitiveKeys: ["order_id"]))))
        config.update(
            anUpdate(options: GroundcoverOptionsUpdate(privacy: PrivacyOptions(maskLogs: false))))
        #expect(config.options.privacy.level == .maskAll)
        #expect(config.options.privacy.sensitiveKeys == ["order_id"])
        #expect(config.options.privacy.maskLogs == false)
    }

    @Test func anUpdateMergesTransportFieldByField() {
        let config = SdkConfig(
            anInput(options: GroundcoverOptions(transport: TransportOptions(batchSize: 5))))
        config.update(
            anUpdate(
                options: GroundcoverOptionsUpdate(transport: TransportOptions(compression: false))))
        #expect(config.options.transport.batchSize == 5)
        #expect(config.options.transport.compression == false)
    }

    @Test func whatInitFixesSurvivesAnUpdate() {
        let config = SdkConfig(
            anInput(
                options: GroundcoverOptions(
                    enabledEvents: [.crashes], sessionSampleRate: 0.25, appVersion: "1.2.3")))
        config.update(anUpdate(options: GroundcoverOptionsUpdate(debug: true)))
        #expect(config.options.enabledEvents == [.crashes])
        #expect(config.options.sessionSampleRate == 0.25)
        #expect(config.options.appVersion == "1.2.3")
        #expect(config.options.debug == true)
    }

    @Test func aPartialUserMergesIsKeptWhenOmittedAndIsClearedOnRequest() {
        let config = SdkConfig(anInput(user: RumUser(id: "u1", email: "a@b")))
        config.update(anUpdate(user: .set(RumUser(name: "Ann"))))
        #expect(config.user?.id == "u1")
        #expect(config.user?.email == "a@b")
        #expect(config.user?.name == "Ann")

        config.update(anUpdate(cluster: "c2"))
        #expect(config.user?.id == "u1")

        config.update(anUpdate(user: .clear))
        #expect(config.user == nil)
    }

    @Test func userPropertiesAreMadeJsonOnceAsTheyAreSet() throws {
        // Every batch envelope carries them: an app object would be encoded again each time, and
        // a cycle would fail every batch.
        struct Profile: CustomStringConvertible {
            var description: String { "profile #7" }
        }
        let loop = NSMutableDictionary(dictionary: ["a": 1])
        loop["self"] = loop
        let config = SdkConfig(
            anInput(user: RumUser(id: "u1", properties: ["profile": Profile(), "loop": loop])))
        let properties = try #require(config.user?.properties)
        #expect(properties["profile"] as? String == "profile #7")
        #expect((properties["loop"] as? [String: Any])?["self"] as? String == "[Circular]")

        config.update(anUpdate(user: .set(RumUser(properties: ["plan": Profile()]))))
        #expect(config.user?.id == "u1")
        #expect(config.user?.properties?["plan"] as? String == "profile #7")
        #expect(config.user?.properties?["profile"] == nil)
    }

    @Test func identityFieldsChangeOnlyWhenGivenAndNonEmpty() {
        let config = SdkConfig(anInput())
        config.update(anUpdate(dsn: "other.example", environment: "", releaseId: "abc123"))
        #expect(config.dsn == "other.example")
        #expect(config.environment == "env")
        #expect(config.releaseId == "abc123")
        #expect(config.cluster == "cluster")
    }

    @Test func anEventIsEnabledWhenTheListNamesItOrIsEmpty() {
        #expect(isEventEnabled([], .logs))
        #expect(isEventEnabled(nil, .logs))
        #expect(isEventEnabled([.logs], .logs))
        #expect(!isEventEnabled([.crashes], .logs))
    }
}

@Suite struct ConfigManagerTests {
    @Test func holdsTheConfigurationItWasBuiltWithAndItsUpdates() {
        let manager = ConfigManager(anInput())
        #expect(manager.config.appId == "app")
        manager.update(anUpdate(cluster: "c2"))
        #expect(manager.config.cluster == "c2")
    }

    @Test func reResolvesPrivacyAfterAnUpdate() {
        let manager = ConfigManager(anInput())
        #expect(manager.privacy.level == .maskSensitive)
        manager.update(
            anUpdate(options: GroundcoverOptionsUpdate(privacy: PrivacyOptions(level: .allow))))
        #expect(manager.privacy.level == .allow)
    }
}

@Suite struct ResolvePrivacyTests {
    @Test func defaultsToMaskSensitiveWithEveryToggleOn() {
        let privacy = resolvePrivacy(nil)
        #expect(privacy.level == .maskSensitive)
        #expect(privacy.shouldMaskNetworkBodies)
        #expect(privacy.shouldMaskNetworkQueryParams)
        #expect(privacy.shouldMaskLogs)
        #expect(privacy.shouldMaskErrors)
        #expect(!privacy.maskInteractionLabels)
    }

    @Test func turnsEveryToggleOffUnderAllowEvenWhenSetOn() {
        let privacy = resolvePrivacy(PrivacyOptions(level: .allow, maskLogs: true))
        #expect(!privacy.maskLogs)
        #expect(!privacy.shouldMaskLogs)
        #expect(!privacy.shouldMaskNetworkBodies)
    }

    @Test func letsEachToggleBeOverriddenOnItsOwn() {
        let privacy = resolvePrivacy(PrivacyOptions(maskNetworkBodies: false))
        #expect(!privacy.shouldMaskNetworkBodies)
        #expect(privacy.shouldMaskNetworkQueryParams)
    }

    @Test func masksInteractionLabelsUnderMaskAllOrWhenAskedTo() {
        #expect(resolvePrivacy(PrivacyOptions(level: .maskAll)).maskInteractionLabels)
        // As RN: mask-all can't be talked out of masking labels.
        #expect(
            resolvePrivacy(PrivacyOptions(level: .maskAll, maskInteractionLabels: false))
                .maskInteractionLabels)
        #expect(resolvePrivacy(PrivacyOptions(maskInteractionLabels: true)).maskInteractionLabels)
    }

    @Test func carriesTrimmedNonBlankSensitiveKeysAndTheRedactHook() throws {
        let privacy = resolvePrivacy(
            PrivacyOptions(sensitiveKeys: [" order_id ", "", "  "], redact: { _ in "hooked" }))
        #expect(privacy.sensitiveKeys == ["order_id"])
        let field = RedactField(key: "k", value: "v", path: ["k"], kind: .log, sensitive: false)
        #expect(try privacy.redact?(field) as? String == "hooked")
    }

    @Test func aSensitiveKeyIsTrimmedOfLineBreaksToo() {
        // Keys read from a file or remote config often end in one.
        let privacy = resolvePrivacy(
            PrivacyOptions(sensitiveKeys: ["account_number\n", " order_id\r\n", "\n"]))
        #expect(privacy.sensitiveKeys == ["account_number", "order_id"])
    }
}
