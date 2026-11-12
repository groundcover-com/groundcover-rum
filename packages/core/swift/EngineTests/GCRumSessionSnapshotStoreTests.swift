import Foundation
import Testing
@testable import GroundcoverRumEngine

/// The disk side of crash attribution.
///
/// A crash kills the JS runtime, so nothing can be composed at crash time — the
/// snapshot has to already be on disk, and the records have to survive until
/// JavaScript confirms delivery. Every guarantee here is about what a NEXT
/// process finds, which is why these tests use a real temporary directory
/// rather than a stub: an in-memory fake would pass whether or not anything was
/// ever written.
@Suite("Session snapshot store")
struct GCRumSessionSnapshotStoreTests {
    /// A throwaway directory per test, so nothing leaks between them or onto
    /// the developer's real Application Support.
    private func makeTempDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("gc-rum-store-tests")
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func pendingFiles(in directory: URL) -> [String] {
        let pending = directory.appendingPathComponent("pending", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(atPath: pending.path)) ?? []
        return files.sorted()
    }

    // MARK: - Snapshot

    @Test("serves the snapshot from memory as soon as it is set")
    func snapshotReadableImmediately() {
        let store = GCRumSessionSnapshotStore(directory: makeTempDirectory())

        store.update(#"{"session_id":"abc"}"#)

        #expect(store.snapshotJson() == #"{"session_id":"abc"}"#)
    }

    /// The point of the whole store: a NEW process must find what the previous
    /// one left behind. Anything that only works in memory is useless here.
    @Test("a fresh store reads the snapshot the previous run wrote")
    func snapshotSurvivesAcrossStores() {
        let directory = makeTempDirectory()

        let first = GCRumSessionSnapshotStore(directory: directory)
        first.update(#"{"session_id":"crashed-session"}"#)
        first.flushPendingWrite()

        let second = GCRumSessionSnapshotStore(directory: directory)
        #expect(second.snapshotJson() == #"{"session_id":"crashed-session"}"#)
    }

    /// Screen changes re-push the snapshot; a navigating user would otherwise
    /// fsync on every transition. Attribution tolerates sub-second staleness,
    /// so rapid updates coalesce — but the in-memory value is always current.
    @Test("rapid updates are debounced on disk while memory stays current")
    func rapidUpdatesAreDebounced() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)

        store.update(#"{"screen":"one"}"#)   // first write goes straight out
        store.update(#"{"screen":"two"}"#)
        store.update(#"{"screen":"three"}"#)

        #expect(store.snapshotJson() == #"{"screen":"three"}"#)

        // The later ones are still pending; forcing them out is what a
        // background transition does.
        store.flushPendingWrite()
        let reread = GCRumSessionSnapshotStore(directory: directory)
        #expect(reread.snapshotJson() == #"{"screen":"three"}"#)
    }

    /// The debounce has to be TRAILING, not merely rate-limiting: a jetsam kill or a native crash
    /// gives no `stop()` and no background transition, and whatever is on disk then is what the
    /// crash is attributed to. JS re-pushes on every screen change, so an update inside the
    /// previous 500ms shadow is the ordinary case — and if nothing drains it, every crash from
    /// then on carries a stale screen and user.
    @Test("a debounced write reaches disk on its own, without stop() or a background hook")
    func debouncedWriteDrainsItself() async throws {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)

        store.update(#"{"screen":"Home"}"#)      // due immediately — goes straight out
        store.update(#"{"screen":"Checkout"}"#)  // inside the window — parked

        // Wait out the debounce. Deliberately no flushPendingWrite() call: the
        // termination this protects against does not afford one.
        try await Task.sleep(nanoseconds: 1_200_000_000)

        #expect(GCRumSessionSnapshotStore(directory: directory).snapshotJson()
            == #"{"screen":"Checkout"}"#)
    }

    @Test("flushing with nothing pending is a no-op, not a truncation")
    func flushWithoutPendingKeepsContents() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)

        store.update(#"{"session_id":"kept"}"#)
        store.flushPendingWrite()
        store.flushPendingWrite()

        #expect(GCRumSessionSnapshotStore(directory: directory).snapshotJson()
            == #"{"session_id":"kept"}"#)
    }

    /// `destroy()` clears the snapshot so a crash AFTER the SDK was torn down
    /// is not attributed to the session that just ended.
    @Test("clearing removes the snapshot from memory and disk")
    func clearingRemovesTheSnapshot() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)

        store.update(#"{"session_id":"gone"}"#)
        store.flushPendingWrite()
        store.update(nil)

        #expect(store.snapshotJson() == nil)
        #expect(GCRumSessionSnapshotStore(directory: directory).snapshotJson() == nil)
    }

    /// Clearing has to be indivisible with respect to a flush that is ALREADY RUNNING, not
    /// merely one that is still queued: `cancel()` cannot stop a started flush, and a delete
    /// that took no write lock could land inside `flushPendingWrite`'s take-and-write. The
    /// flush would then complete with the envelope it had already captured and put the cleared
    /// snapshot back on disk, where the NEXT launch reads it — a crash attributed to the
    /// session and user JavaScript had just said were gone. `update(nil)` is a real call:
    /// NativeSnapshotPusher makes it whenever there is no live session.
    ///
    /// The injected writer is what makes this deterministic: it holds the flush open exactly
    /// mid-write, which is the window the race lives in and which no amount of sleeping
    /// reproduces reliably from the outside.
    @Test("clearing while a flush is already running does not resurrect the snapshot")
    func clearDuringInFlightFlushDoesNotResurrect() {
        let directory = makeTempDirectory()
        let insideWrite = DispatchSemaphore(value: 0)
        let mayFinishWrite = DispatchSemaphore(value: 0)
        let flushReturned = DispatchSemaphore(value: 0)
        let clearReturned = DispatchSemaphore(value: 0)

        let store = GCRumSessionSnapshotStore(directory: directory) { contents, url in
            insideWrite.signal()
            mayFinishWrite.wait()
            try? Data(contents.utf8).write(to: url, options: .atomic)
        }

        // Off the test thread, because the first update is due immediately and flushes
        // inline — parked here, mid-write, holding the write lock.
        DispatchQueue.global().async {
            store.update(#"{"session_id":"doomed"}"#)
            flushReturned.signal()
        }
        #expect(insideWrite.wait(timeout: .now() + 5) == .success)

        // JavaScript drops the session while that write is in flight. Also off the test
        // thread: once serialized correctly this BLOCKS until the write completes, so
        // calling it here would deadlock against the signal below.
        DispatchQueue.global().async {
            store.update(nil)
            clearReturned.signal()
        }
        // Long enough for an UNSYNCHRONIZED delete to get through and lose the race — which
        // is all this needs to do. A correctly serialized clear is blocked on the lock
        // regardless of how long this waits, so the pass does not depend on the duration.
        Thread.sleep(forTimeInterval: 0.1)

        mayFinishWrite.signal()
        #expect(flushReturned.wait(timeout: .now() + 5) == .success)
        #expect(clearReturned.wait(timeout: .now() + 5) == .success)

        #expect(
            store.snapshotJson() == nil,
            "the clear was overtaken by the in-flight flush in memory"
        )
        #expect(
            GCRumSessionSnapshotStore(directory: directory).snapshotJson() == nil,
            "a cleared snapshot was rewritten to disk, so the next launch would attribute a crash to it"
        )
    }

    /// The nastier half of clearing: a queued write must not resurrect the
    /// snapshot after it was deliberately dropped.
    @Test("clearing cancels a pending write rather than letting it land later")
    func clearingCancelsPendingWrite() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)

        store.update(#"{"session_id":"first"}"#)  // written immediately
        store.update(#"{"session_id":"second"}"#) // debounced, still pending
        store.update(nil)
        store.flushPendingWrite()

        #expect(GCRumSessionSnapshotStore(directory: directory).snapshotJson() == nil)
    }

    @Test("a store pointed at an empty directory reports no snapshot")
    func emptyDirectoryHasNoSnapshot() {
        #expect(GCRumSessionSnapshotStore(directory: makeTempDirectory()).snapshotJson() == nil)
    }

    // MARK: - Pending records

    @Test("a written record is readable by the next process")
    func recordSurvivesAcrossStores() {
        let directory = makeTempDirectory()

        GCRumSessionSnapshotStore(directory: directory)
            .writePendingRecord(id: "crash-1", json: #"{"id":"crash-1"}"#)

        let records = GCRumSessionSnapshotStore(directory: directory).readPendingRecords()
        #expect(records == [#"{"id":"crash-1"}"#])
    }

    /// Delivery is at-least-once: a record stays until JavaScript acks it, and
    /// acking one must not disturb the others.
    @Test("deleting acks exactly the named records")
    func deleteRemovesOnlyTheNamedRecords() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)

        store.writePendingRecord(id: "a", json: #"{"id":"a"}"#)
        store.writePendingRecord(id: "b", json: #"{"id":"b"}"#)
        store.writePendingRecord(id: "c", json: #"{"id":"c"}"#)

        store.deletePendingRecords(ids: ["b"])

        let remaining = store.readPendingRecords().sorted()
        #expect(remaining == [#"{"id":"a"}"#, #"{"id":"c"}"#])
    }

    @Test("deleting an id that is not there is harmless")
    func deleteUnknownIdIsHarmless() {
        let store = GCRumSessionSnapshotStore(directory: makeTempDirectory())
        store.writePendingRecord(id: "a", json: #"{"id":"a"}"#)

        store.deletePendingRecords(ids: ["never-existed"])

        #expect(store.readPendingRecords().count == 1)
    }

    /// An app that crashes repeatedly without ever reaching a working network
    /// must not grow its crash directory forever.
    @Test("the record count is capped, dropping the oldest")
    func recordsAreCapped() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)

        let overflow = 5
        let written = GCRumSessionSnapshotStore.maxPendingRecords + overflow
        for i in 0..<written {
            store.writePendingRecord(id: "crash-\(i)", json: #"{"id":"crash-\#(i)"}"#)
            // Modification-date ordering is what "oldest" means here, and a
            // filesystem timestamp has limited resolution.
            Thread.sleep(forTimeInterval: 0.01)
        }

        let files = pendingFiles(in: directory)
        #expect(files.count <= GCRumSessionSnapshotStore.maxPendingRecords)
        // The most recent crash is the one most worth keeping, and the oldest
        // is the one that should have gone.
        #expect(files.contains("crash-\(written - 1).json"))
        #expect(!files.contains("crash-0.json"))
    }

    @Test("records come back oldest first, so the earliest crash is reported first")
    func recordsAreOldestFirst() {
        let store = GCRumSessionSnapshotStore(directory: makeTempDirectory())

        store.writePendingRecord(id: "older", json: #"{"id":"older"}"#)
        Thread.sleep(forTimeInterval: 0.02)
        store.writePendingRecord(id: "newer", json: #"{"id":"newer"}"#)

        #expect(store.readPendingRecords() == [#"{"id":"older"}"#, #"{"id":"newer"}"#])
    }

    @Test("a store with no records reads an empty list rather than failing")
    func noRecordsReadsEmpty() {
        #expect(GCRumSessionSnapshotStore(directory: makeTempDirectory())
            .readPendingRecords().isEmpty)
    }

    /// The pending directory is shared with nothing, but a stray file (a
    /// half-written temp, something a user copied in) must not become a record.
    @Test("non-JSON files in the pending directory are ignored")
    func ignoresNonJsonFiles() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)
        store.writePendingRecord(id: "real", json: #"{"id":"real"}"#)

        let stray = directory.appendingPathComponent("pending").appendingPathComponent("notes.txt")
        try? "not a record".write(to: stray, atomically: true, encoding: .utf8)

        #expect(store.readPendingRecords() == [#"{"id":"real"}"#])
    }

    /// ONE bad file must not cost the WHOLE harvest, only itself.
    ///
    /// `GCRumEngine.pendingCrashReportsJson()` splices these strings — `"[" + joined(",") + "]"` —
    /// so an empty record would produce `[,{…}]`, which is not JSON. JavaScript's `JSON.parse`
    /// would throw, the drain would catch it, and every pending crash would be lost. An empty file
    /// is reachable: a `.json` created but not yet written when the process died, or a write
    /// interrupted by the very crash being recorded.
    ///
    /// Filtered in the STORE rather than in the engine because the store is the unit
    /// `Package.swift` compiles — `GCRumEngine.swift` is excluded — and because what counts as a
    /// record is the store's business.
    @Test("an empty pending file cannot destroy the rest of the harvest")
    func emptyRecordDoesNotPoisonTheHarvest() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)
        store.writePendingRecord(id: "real", json: #"{"id":"real"}"#)

        let pending = directory.appendingPathComponent("pending")
        try? "".write(to: pending.appendingPathComponent("blank.json"), atomically: true, encoding: .utf8)
        try? "  \n".write(to: pending.appendingPathComponent("ws.json"), atomically: true, encoding: .utf8)
        // A TRUNCATED write, and the likelier shape of the three: a record interrupted by the very
        // crash being recorded leaves a partial file, not an empty one. Non-blank, so a
        // whitespace-only filter lets it through and it poisons the splice just the same.
        try? #"{"id":"torn","errorTyp"#
            .write(to: pending.appendingPathComponent("torn.json"), atomically: true, encoding: .utf8)
        // Valid JSON, but not an object — `JSON.parse` succeeds and the drain then reads fields
        // off a string.
        try? #""just a string""#
            .write(to: pending.appendingPathComponent("scalar.json"), atomically: true, encoding: .utf8)

        let records = store.readPendingRecords()
        #expect(records == [#"{"id":"real"}"#])
        // The claim that actually matters: what the engine splices is parseable.
        #expect(!("[" + records.joined(separator: ",") + "]").contains("[,"))
    }

    /// Ack ids are interpolated straight into a path, so `../` must not escape the pending
    /// directory.
    ///
    /// Reachability is low — the ids are generated natively and read back from a directory inside
    /// the app sandbox, so exploiting it means already being able to write there — but a basename
    /// guard costs one comparison. The file planted outside `pending/` must survive.
    @Test("an ack id cannot escape the pending directory")
    func ackIdCannotTraverse() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)
        store.writePendingRecord(id: "keep", json: #"{"id":"keep"}"#)

        // A file the ack must not be able to reach: a sibling of `pending/`.
        let outside = directory.appendingPathComponent("outside.json")
        try? #"{"not":"ours"}"#.write(to: outside, atomically: true, encoding: .utf8)

        store.deletePendingRecords(ids: ["../outside", "keep/../../outside"])

        #expect(FileManager.default.fileExists(atPath: outside.path))
        // …and the legitimate record is untouched by a rejected ack.
        #expect(store.readPendingRecords() == [#"{"id":"keep"}"#])
    }

    /// The guard's happy path. KSCrash report ids reach the store as UUID strings, so a guard that
    /// rejected them would silently stop crashes being written — capture would look armed and
    /// report nothing, the worst failure this file can have. A real UUID, because the hyphens are
    /// what a naive path-component check could plausibly mishandle.
    @Test("a native UUID record id is accepted")
    func nativeUuidIdIsAccepted() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)
        let id = UUID().uuidString

        store.writePendingRecord(id: id, json: #"{"id":"real"}"#)
        #expect(store.readPendingRecords() == [#"{"id":"real"}"#])

        store.deletePendingRecords(ids: [id])
        #expect(store.readPendingRecords().isEmpty)
    }

    @Test("rewriting the same id replaces the record rather than duplicating it")
    func rewritingSameIdReplaces() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)

        store.writePendingRecord(id: "dup", json: #"{"v":1}"#)
        store.writePendingRecord(id: "dup", json: #"{"v":2}"#)

        #expect(pendingFiles(in: directory).count == 1)
        #expect(store.readPendingRecords() == [#"{"v":2}"#])
    }

    @Test("snapshots and crash records do not interfere with each other")
    func snapshotAndRecordsAreIndependent() {
        let directory = makeTempDirectory()
        let store = GCRumSessionSnapshotStore(directory: directory)

        store.update(#"{"session_id":"live"}"#)
        store.writePendingRecord(id: "crash-1", json: #"{"id":"crash-1"}"#)
        store.update(nil)

        #expect(store.snapshotJson() == nil)
        #expect(store.readPendingRecords() == [#"{"id":"crash-1"}"#])
    }

    // MARK: - Privacy

    /// The snapshot is the exact envelope a live batch carries, so it holds whatever
    /// `identifyUser` was given — and Application Support is INCLUDED in iCloud and iTunes
    /// backups. Excluding the directory rather than moving to Caches is deliberate: the OS may
    /// evict Caches under disk pressure, silently dropping crash reports that have not reached
    /// the network.
    @Test("the store directory is excluded from device backups")
    func directoryIsExcludedFromBackup() throws {
        let directory = makeTempDirectory()
        _ = GCRumSessionSnapshotStore(directory: directory)

        let values = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)
    }

    /// The exclusion has to survive a process that finds the directory already
    /// there, which is every launch after the first — `createDirectory` is a
    /// no-op then, so an exclusion applied only on creation would be set once on
    /// the developer's machine and never on a device that upgraded into it.
    @Test("re-opening an existing directory keeps it excluded")
    func exclusionIsReappliedOnReopen() throws {
        let directory = makeTempDirectory()
        _ = GCRumSessionSnapshotStore(directory: directory)

        // Someone (a restore, a migration, an older build) cleared the flag.
        var reset = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = false
        try reset.setResourceValues(values)

        _ = GCRumSessionSnapshotStore(directory: directory)

        let after = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(after.isExcludedFromBackup == true)
    }

    // NOTE: the file-protection class (`.completeFileProtectionUntilFirstUser-
    // Authentication` on every write) is deliberately NOT asserted here. Data
    // Protection is an iOS facility; on the macOS host that runs `swift test`
    // the attribute is accepted and ignored, so an assertion would pass without
    // proving anything and would then fail confusingly if it ever DID run on a
    // device. No automated test asserts it.
    /// The Kotlin twin of this store demands that a pending record parse as a JSON OBJECT before
    /// the drain sees it. The snapshot feeds the same drain, so it gets the same check: without
    /// it, an empty or malformed file would become a non-nil envelope.
    ///
    /// Nothing would be misattributed either way: `parseSnapshot` in the JS drain rejects anything
    /// without a string `session_id`. Both platforms apply one predicate feeding one consumer.
    @Test("a snapshot that is not a JSON object reads as absent")
    func nonObjectSnapshotReadsAsAbsent() throws {
        let directory = makeTempDirectory()
        try "42".write(to: directory.appendingPathComponent("snapshot.json"), atomically: true, encoding: .utf8)

        #expect(GCRumSessionSnapshotStore(directory: directory).snapshotJson() == nil)
    }
}
