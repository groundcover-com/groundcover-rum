import Foundation
import Testing

@testable import GroundcoverRum

// The core's building blocks: text, ids, storage that never throws, exact nanoseconds, the SDK's
// own diagnostics, and the scope the app's hooks run in.

@Suite struct TextTests {
    @Test func truncateTurnsNilIntoEmptyAndStringifiesOtherValues() {
        #expect(truncate(nil) == "")
        #expect(truncate("") == "")
        #expect(truncate(0) == "0")
        #expect(truncate(false) == "false")
        #expect(truncate(12345, maxLength: 3) == "123")
    }

    @Test func truncateKeepsTextWithinTheLimitAndCutsAndMarksTextBeyondIt() {
        #expect(truncate("abc", maxLength: 3) == "abc")
        #expect(truncate("abcd", maxLength: 3) == "abc")
        #expect(truncate("abcd", maxLength: 3, ellipsis: "…") == "abc…")
        #expect(truncate("abc", maxLength: 3, ellipsis: "…") == "abc")
        #expect(truncate(String(repeating: "x", count: 10_001)).utf16.count == 10_000)
        #expect(truncate("abc", maxLength: 0) == "")
    }

    @Test func truncateCountsUTF16UnitsAsTheOtherSDKsDoAndNeverCutsACharacterInHalf() {
        // The emoji is two UTF-16 units: a cut after two units would land inside it.
        #expect(truncate("a😀b", maxLength: 3) == "a😀")
        #expect(truncate("a😀b", maxLength: 2) == "a")
    }

    @Test func normalizeWhitespaceCollapsesRunsAndTrims() {
        #expect(normalizeWhitespace("  a \n\t b  ") == "a b")
        #expect(normalizeWhitespace(nil) == "")
    }
}

@Suite struct IdTests {
    private let ids = RandomIdGenerator()

    private func isLowercaseHex(_ value: String) -> Bool {
        !value.isEmpty && value.allSatisfy { "0123456789abcdef".contains($0) }
    }

    @Test func idsAre32SpanIds16AndTraceIds32LowercaseHex() {
        let id = ids.generateId()
        let spanId = ids.generateSpanId()
        let traceId = ids.generateTraceId()
        #expect(id.count == 32 && isLowercaseHex(id))
        #expect(spanId.count == 16 && isLowercaseHex(spanId))
        #expect(traceId.count == 32 && isLowercaseHex(traceId))
    }

    @Test func everyHexDigitTurnsUpInEveryPosition() {
        var seen = Array(repeating: Set<Character>(), count: 32)
        for _ in 0..<2_000 {
            for (position, digit) in ids.generateId().enumerated() {
                seen[position].insert(digit)
            }
        }
        #expect(seen.allSatisfy { $0.count == 16 })
    }

    @Test func traceIdsKeepTheUpper64BitsZero() {
        for _ in 0..<20 {
            #expect(ids.generateTraceId().prefix(16) == String(repeating: "0", count: 16))
        }
    }

    @Test func idsDoNotRepeat() {
        #expect(Set((0..<1_000).map { _ in ids.generateId() }).count == 1_000)
        #expect(Set((0..<1_000).map { _ in ids.generateSpanId() }).count == 1_000)
    }
}

/// A storage backend in memory, which can be told to fail as a real one does.
final class MapStorage: PlatformStorage {
    var values: [String: String] = [:]
    var throwing = false

    private struct Unavailable: Error {}

    func getItem(_ key: String) throws -> String? {
        if throwing { throw Unavailable() }
        return values[key]
    }

    func setItem(_ key: String, _ value: String) throws {
        if throwing { throw Unavailable() }
        values[key] = value
    }

    func removeItem(_ key: String) throws {
        if throwing { throw Unavailable() }
        values[key] = nil
    }
}

@Suite struct SafeStorageTests {
    @Test func roundTripsThroughTheBackend() {
        let storage = SafeStorage(MapStorage())
        storage.setItem("k", "v")
        #expect(storage.getItem("k") == "v")
        storage.removeItem("k")
        #expect(storage.getItem("k") == nil)
    }

    @Test func neverThrowsWhenTheBackendDoes() {
        let backend = MapStorage()
        backend.throwing = true
        let storage = SafeStorage(backend)
        #expect(storage.getItem("k") == nil)
        storage.setItem("k", "v")
        storage.removeItem("k")
        #expect(storage.getIntegerItem("k", fallback: 7) == 7)
    }

    @Test func integerItemsReadExactlyAndFallBackWhenNotANumber() {
        let backend = MapStorage()
        backend.values = [
            "int": "42", "padded": " 42 ", "dec": "1.5", "nan": "abc", "inf": "Infinity",
            "ns": "1800000000000000001",
        ]
        let storage = SafeStorage(backend)
        #expect(storage.getIntegerItem("int") == 42)
        #expect(storage.getIntegerItem("padded") == 42)
        #expect(storage.getIntegerItem("dec") == 1)
        #expect(storage.getIntegerItem("nan", fallback: 3) == 3)
        #expect(storage.getIntegerItem("inf", fallback: 3) == 3)
        #expect(storage.getIntegerItem("missing") == 0)
        // A double would read this as ...000000: nanoseconds must come back exact.
        #expect(storage.getIntegerItem("ns") == 1_800_000_000_000_000_001)
    }

    @Test func aNilBackendIsASilentNoOp() {
        let storage = SafeStorage(nil)
        storage.setItem("k", "v")
        #expect(storage.getItem("k") == nil)
        #expect(storage.getIntegerItem("k", fallback: 5) == 5)
    }
}

@Suite struct TimeTests {
    @Test func millisecondsAndNanosecondsConvertExactlyAs64BitIntegers() {
        #expect(msToNs(1_800_000_000_000) == 1_800_000_000_000_000_000)
        #expect(nsToMs(1_800_000_000_000_000_000) == 1_800_000_000_000)
        #expect(nsToMs(msToNs(1_234_567_890_123)) == 1_234_567_890_123)
    }

    @Test func aFractionalMillisecondConvertsWithinANanosecond() {
        #expect(fractionalMsToNs(1_800_000_000_000.5) == 1_800_000_000_000_500_000)
        #expect(fractionalMsToNs(1_800_000_000_000) == 1_800_000_000_000_000_000)
    }
}

@Suite struct DiagnosticsTests {
    private final class Lines: @unchecked Sendable {
        var all: [String] = []
    }

    @Test func logIsSilentUnlessDebugIsOnAndCarriesThePrefix() {
        let lines = Lines()
        let diagnostics = RumDiagnostics(sink: { lines.all.append($0) })
        diagnostics.log("before")
        diagnostics.configure(debug: true)
        diagnostics.log("after", detail: 42)
        #expect(lines.all.count == 1)
        #expect(lines.all.first?.contains("[groundcover] after 42") == true)
    }

    @Test func warnIsWrittenWhateverTheDebugSetting() {
        let lines = Lines()
        let diagnostics = RumDiagnostics(sink: { lines.all.append($0) })
        diagnostics.warn("[groundcover] sessionMaxDuration out of range")
        #expect(lines.all == ["[groundcover] sessionMaxDuration out of range"])
    }

    @Test func aLineWrittenFromInsideTheSinkIsDropped() {
        // An app that routes what the SDK prints back into the SDK's logger would otherwise make
        // each line write another, without end.
        let lines = Lines()
        var diagnostics: RumDiagnostics!
        diagnostics = RumDiagnostics(sink: { line in
            lines.all.append(line)
            diagnostics.warn("echo of \(line)")
        })
        diagnostics.warn("first")
        #expect(lines.all == ["first"])
    }
}

@Suite struct UserHookTests {
    private final class Flag: @unchecked Sendable {
        var value = true
    }

    @Test func aHookIsRunningOnlyOnItsOwnThreadAndOnlyWhileItRuns() {
        #expect(!UserHook.isRunning)
        let seenElsewhere = UserHook.run { () -> Bool in
            #expect(UserHook.isRunning)
            let flag = Flag()
            let done = DispatchSemaphore(value: 0)
            Thread {
                flag.value = UserHook.isRunning
                done.signal()
            }.start()
            done.wait()
            return flag.value
        }
        #expect(!seenElsewhere)
        #expect(!UserHook.isRunning)
    }

    @Test func aHookThatThrowsLeavesTheScope() {
        struct Boom: Error {}
        #expect(throws: Boom.self) {
            try UserHook.run { throw Boom() }
        }
        #expect(!UserHook.isRunning)
    }
}
