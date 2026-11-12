import Foundation
import Testing
@testable import GroundcoverRumEngine

/// The record shape is the contract with the JS drainer, and a drift in it shows
/// up only as a missing attribute on a crash nobody is watching. Driven from
/// fixture dictionaries shaped like real KSCrash reports, so no crash, no
/// device, and no linked crash reporter are needed.
///
/// swift-testing rather than XCTest: it ships with the Swift toolchain, so these
/// run on a machine with only the command-line tools installed.
@Suite("KSCrash report → pending record")
struct GCRumCrashReportMapperTests {

    private let snapshot = #"{"session_id":"s-1","screen":{"name":"Checkout","key":"Checkout-1"}}"#

    private func report(
        error: [String: Any],
        threads: [[String: Any]] = [],
        system: [String: Any] = [:],
        images: [[String: Any]] = [],
        id: String = "kscrash-1"
    ) -> [String: Any] {
        [
            // MICROSECONDS, as KSCrash actually writes it — a fixture carrying
            // seconds would let a mapper that reads seconds still pass.
            "report": ["id": id, "timestamp": 1_700_000_123_456_789],
            "crash": ["error": error, "threads": threads],
            "system": system,
            "binary_images": images,
        ]
    }

    private func mapped(
        _ report: [String: Any],
        snapshotJson: String? = nil
    ) throws -> [String: Any] {
        let json = try #require(
            GCRumCrashReportMapper.buildRecord(report: report, sessionSnapshotJson: snapshotJson)
        )
        let data = try #require(json.data(using: .utf8))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - error_type

    @Test("prefers an NSException's name over the mach exception and signal")
    func prefersNSExceptionName() throws {
        // The most specific name wins: it is what the backend groups on, and
        // "SIGABRT" would collapse every Objective-C exception into one issue.
        let record = try mapped(report(error: [
            "nsexception": ["name": "NSInvalidArgumentException", "reason": "bad selector"],
            "mach": ["exception_name": "EXC_CRASH"],
            "signal": ["name": "SIGABRT"],
        ]))

        #expect(record["errorType"] as? String == "NSInvalidArgumentException")
        #expect(record["errorMessage"] as? String == "bad selector")
    }

    @Test("falls back to the mach exception, then the signal")
    func fallsBackThroughTheNameChain() throws {
        let mach = try mapped(report(error: [
            "mach": ["exception_name": "EXC_BAD_ACCESS"],
            "signal": ["name": "SIGSEGV"],
        ]))
        #expect(mach["errorType"] as? String == "EXC_BAD_ACCESS")

        let signal = try mapped(report(error: ["signal": ["name": "SIGSEGV"]]))
        #expect(signal["errorType"] as? String == "SIGSEGV")
        #expect(signal["errorMessage"] as? String == "Fatal signal SIGSEGV")
    }

    @Test("falls back to a generic type when the report says nothing useful")
    func fallsBackToGenericType() throws {
        let record = try mapped(report(error: [:]))

        #expect(record["errorType"] as? String == "NativeCrash")
        #expect(record["errorMessage"] as? String == "Native crash")
    }

    // MARK: - stacktrace

    @Test("takes frames from the CRASHED thread, not the first one")
    func takesFramesFromTheCrashedThread() throws {
        let record = try mapped(report(
            error: ["signal": ["name": "SIGSEGV"]],
            threads: [
                ["crashed": false, "backtrace": ["contents": [
                    ["object_name": "Innocent", "symbol_name": "-[NSRunLoop run]"],
                ]]],
                ["crashed": true, "backtrace": ["contents": [
                    ["object_name": "AcmeShop", "symbol_name": "-[Checkout computeTotals]"],
                ]]],
            ]
        ))

        let frames = try #require(record["stacktrace"] as? [[String: Any]])
        #expect(frames.count == 1)
        #expect(frames[0]["filename"] as? String == "AcmeShop")
        #expect(frames[0]["function"] as? String == "-[Checkout computeTotals]")
    }

    @Test("falls back to the bare address when a frame names no image base")
    func usesHexAddressWithoutImageBase() throws {
        // KSCrash writes object_addr on every frame it can place in an image (see
        // the real report below); without it the address is all there is, and
        // losing it would make the frame useless forever.
        let record = try mapped(report(
            error: ["signal": ["name": "SIGSEGV"]],
            threads: [["crashed": true, "backtrace": ["contents": [
                ["object_name": "AcmeShop", "instruction_addr": UInt64(0x1_04a3_f1c8)],
            ]]]]
        ))

        let frames = try #require(record["stacktrace"] as? [[String: Any]])
        #expect(frames[0]["function"] as? String == "0x0000000104a3f1c8")
    }

    @Test("frames carry zero line and column")
    func framesCarryZeroPosition() throws {
        // Line info needs server-side symbolication; a fabricated number would
        // read as a real source position on the backend.
        let record = try mapped(report(
            error: ["signal": ["name": "SIGSEGV"]],
            threads: [["crashed": true, "backtrace": ["contents": [
                ["object_name": "AcmeShop", "symbol_name": "main"],
            ]]]]
        ))

        let frames = try #require(record["stacktrace"] as? [[String: Any]])
        #expect(frames[0]["lineno"] as? Int == 0)
        #expect(frames[0]["colno"] as? Int == 0)
    }

    @Test("caps the frame count")
    func capsFrameCount() throws {
        let contents = (0..<(GCRumCrashReportMapper.maxFrames + 50)).map {
            ["object_name": "AcmeShop", "symbol_name": "frame\($0)"]
        }
        let record = try mapped(report(
            error: ["signal": ["name": "SIGSEGV"]],
            threads: [["crashed": true, "backtrace": ["contents": contents]]]
        ))

        let frames = try #require(record["stacktrace"] as? [[String: Any]])
        #expect(frames.count == GCRumCrashReportMapper.maxFrames)
    }

    @Test("yields an empty stacktrace rather than nil when there are no threads")
    func emptyStacktraceWithoutThreads() throws {
        let record = try mapped(report(error: ["signal": ["name": "SIGSEGV"]]))

        #expect((record["stacktrace"] as? [[String: Any]])?.count == 0)
    }

    // MARK: - a real report

    /// A KSCrash 2.6.1 report as `reportStore.report(for:)` hands it back, from a stripped
    /// arm64 binary that crashed on a bad pointer. Cut down to the crashed thread, one other and
    /// the images they name; every value is as KSCrash wrote it, except the app's path. A
    /// hand-made fixture cannot catch a mapper that reads the load address from a key KSCrash
    /// never writes, or one that drops the image base every frame carries.
    private static let realReport = #"""
    {
     "binary_images": [
      {
       "cpu_subtype": 0,
       "cpu_type": 16777228,
       "image_addr": 4344217600,
       "image_size": 262144,
       "image_vmaddr": 4294967296,
       "major_version": 0,
       "minor_version": 0,
       "name": "/private/var/containers/Bundle/Application/F00D/crasher",
       "revision_version": 0,
       "uuid": "DFDE3409-DA27-3BA8-8DA4-13D14B43DBF5"
      },
      {
       "cpu_subtype": -2147483646,
       "cpu_type": 16777228,
       "image_addr": 6566871040,
       "image_size": 734464,
       "image_vmaddr": 6443581440,
       "major_version": 0,
       "minor_version": 0,
       "name": "/usr/lib/dyld",
       "revision_version": 0,
       "uuid": "74E52480-C2BD-3C8D-812D-95FE2B74A096"
      }
     ],
     "crash": {
      "error": {
       "address": 16,
       "is_clean_exit": false,
       "is_fatal": true,
       "mach": {
        "code": 1,
        "code_name": "KERN_INVALID_ADDRESS",
        "exception": 1,
        "exception_name": "EXC_BAD_ACCESS",
        "subcode": 16
       },
       "signal": {
        "code": 0,
        "code_name": "SEGV_NOOP",
        "name": "SIGSEGV",
        "signal": 11
       },
       "type": "mach"
      },
      "threads": [
       {
        "backtrace": {
         "contents": [
          {
           "instruction_addr": 6570717960,
           "object_addr": 6570700800,
           "object_name": "libsystem_kernel.dylib",
           "object_uuid": "C6A4A4CB-92E6-3BAF-AAE0-E8306259209A",
           "symbol_addr": 6570717952,
           "symbol_name": "__semwait_signal"
          },
          {
           "instruction_addr": 6569520320,
           "object_addr": 6569463808,
           "object_name": "libsystem_c.dylib",
           "object_uuid": "D77CEB62-AFF6-3CEC-BA9B-4F057FBE2EB5",
           "symbol_addr": 6569520100,
           "symbol_name": "nanosleep"
          },
          {
           "instruction_addr": 6569557540,
           "object_addr": 6569463808,
           "object_name": "libsystem_c.dylib",
           "object_uuid": "D77CEB62-AFF6-3CEC-BA9B-4F057FBE2EB5",
           "symbol_addr": 6569557488,
           "symbol_name": "sleep"
          },
          {
           "instruction_addr": 4344291668,
           "object_addr": 4344217600,
           "object_name": "crasher",
           "object_uuid": "DFDE3409-DA27-3BA8-8DA4-13D14B43DBF5",
           "symbol_addr": 4344217600
          }
         ],
         "skipped": 0
        },
        "crashed": false,
        "current_thread": false,
        "index": 1
       },
       {
        "backtrace": {
         "contents": [
          {
           "instruction_addr": 4344226612,
           "object_addr": 4344217600,
           "object_name": "crasher",
           "object_uuid": "DFDE3409-DA27-3BA8-8DA4-13D14B43DBF5",
           "symbol_addr": 4344217600
          },
          {
           "instruction_addr": 4344225756,
           "object_addr": 4344217600,
           "object_name": "crasher",
           "object_uuid": "DFDE3409-DA27-3BA8-8DA4-13D14B43DBF5",
           "symbol_addr": 4344217600
          },
          {
           "instruction_addr": 6567003364,
           "object_addr": 6566871040,
           "object_name": "dyld",
           "object_uuid": "74E52480-C2BD-3C8D-812D-95FE2B74A096",
           "symbol_addr": 6566996372,
           "symbol_name": "start"
          }
         ],
         "skipped": 0
        },
        "crashed": true,
        "current_thread": false,
        "index": 0
       }
      ]
     },
     "report": {
      "id": "23027694-3005-4EAD-8A7C-C806589E76EF",
      "monitor_id": "MachException",
      "process_name": "crasher",
      "run_id": "4cd1ee30-3358-4556-8e5b-6a26ad25e529",
      "timestamp": "2026-11-02T14:17:40.091099Z",
      "type": "standard",
      "version": "3.9.0"
     },
     "system": {
      "app_uuid": "DFDE3409-DA27-3BA8-8DA4-13D14B43DBF5",
      "application_stats": {
       "active_time_since_last_crash": 0.000730125,
       "active_time_since_launch": 0.000730125,
       "app_transition_state": "active",
       "application_active": true,
       "application_in_foreground": true,
       "background_time_since_last_crash": 0,
       "background_time_since_launch": 0,
       "launches_since_last_crash": 1,
       "sessions_since_last_crash": 1,
       "sessions_since_launch": 1,
       "task_role": "UNSPECIFIED",
       "user_perceptible": true
      },
      "binary_arch": "arm64",
      "cpu_arch": "arm64e",
      "os_version": "25G83",
      "process_name": "crasher",
      "system_name": "macOS",
      "system_version": "26.6.2"
     }
    }
    """#

    /// An NSRangeException from the same stripped binary, thrown inside a GCD block. KSCrash 2.6
    /// keeps where it was thrown in `crash.last_exception_backtrace`; the crashed thread opens with
    /// the runtime's and KSCrash's own terminate handling, and on iOS libdispatch may already have
    /// unwound the throw site off it. Cut down the same way.
    private static let realNSExceptionReport = #"""
    {
     "binary_images": [
      {
       "cpu_subtype": 0,
       "cpu_type": 16777228,
       "image_addr": 4363288576,
       "image_size": 262144,
       "image_vmaddr": 4294967296,
       "major_version": 0,
       "minor_version": 0,
       "name": "/private/var/containers/Bundle/Application/F00D/crasher",
       "revision_version": 0,
       "uuid": "E3D94DC3-214E-3CBF-8E32-694C8AD235ED"
      },
      {
       "cpu_subtype": -2147483646,
       "cpu_type": 16777228,
       "image_addr": 6570590208,
       "image_size": 108384,
       "image_vmaddr": 6447300608,
       "major_version": 2100,
       "minor_version": 43,
       "name": "/usr/lib/libc++abi.dylib",
       "revision_version": 0,
       "uuid": "F38A9C58-22AB-3798-BBAE-8DCD9CC0CE27"
      },
      {
       "cpu_subtype": -2147483646,
       "cpu_type": 16777228,
       "image_addr": 6569156608,
       "image_size": 291392,
       "image_vmaddr": 6445867008,
       "major_version": 1542,
       "minor_version": 160,
       "name": "/usr/lib/system/libdispatch.dylib",
       "revision_version": 2,
       "uuid": "B2000CD5-F580-314A-A141-E036719D854E"
      },
      {
       "cpu_subtype": -2147483646,
       "cpu_type": 16777228,
       "image_addr": 6566313984,
       "image_size": 338764,
       "image_vmaddr": 6443024384,
       "major_version": 228,
       "minor_version": 0,
       "name": "/usr/lib/libobjc.A.dylib",
       "revision_version": 0,
       "uuid": "03BD9E32-CF0A-37B0-898A-3CE8DE06D842"
      },
      {
       "cpu_subtype": -2147483646,
       "cpu_type": 16777228,
       "image_addr": 6571241472,
       "image_size": 5629376,
       "image_vmaddr": 6447951872,
       "major_version": 5026,
       "minor_version": 6,
       "name": "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation",
       "revision_version": 7,
       "uuid": "9B672762-7B1F-30BC-96DE-F176B372D66D"
      }
     ],
     "crash": {
      "error": {
       "address": 0,
       "is_clean_exit": false,
       "is_fatal": true,
       "mach": {
        "code": 0,
        "exception": 10,
        "exception_name": "EXC_CRASH",
        "subcode": 0
       },
       "nsexception": {
        "name": "NSRangeException"
       },
       "reason": "*** __boundsFail: index 5 beyond bounds [0 .. 1]",
       "signal": {
        "code": 0,
        "name": "SIGABRT",
        "signal": 6
       },
       "type": "nsexception"
      },
      "last_exception_backtrace": {
       "contents": [
        {
         "instruction_addr": 6572208612,
         "object_addr": 6571241472,
         "object_name": "CoreFoundation",
         "object_uuid": "9B672762-7B1F-30BC-96DE-F176B372D66D",
         "symbol_addr": 6572208448,
         "symbol_name": "__exceptionPreprocess"
        },
        {
         "instruction_addr": 6566422812,
         "object_addr": 6566313984,
         "object_name": "libobjc.A.dylib",
         "object_uuid": "03BD9E32-CF0A-37B0-898A-3CE8DE06D842",
         "symbol_addr": 6566422724,
         "symbol_name": "objc_exception_throw"
        },
        {
         "instruction_addr": 6573284772,
         "object_addr": 6571241472,
         "object_name": "CoreFoundation",
         "object_uuid": "9B672762-7B1F-30BC-96DE-F176B372D66D",
         "symbol_addr": 6573284292,
         "symbol_name": "__boundsFail"
        },
        {
         "instruction_addr": 6571499672,
         "object_addr": 6571241472,
         "object_name": "CoreFoundation",
         "object_uuid": "9B672762-7B1F-30BC-96DE-F176B372D66D",
         "symbol_addr": 6571499628,
         "symbol_name": "-[__NSArrayI objectAtIndex:]"
        },
        {
         "instruction_addr": 4363298564,
         "object_addr": 4363288576,
         "object_name": "crasher",
         "object_uuid": "E3D94DC3-214E-3CBF-8E32-694C8AD235ED",
         "symbol_addr": 4363288576
        },
        {
         "instruction_addr": 4363298448,
         "object_addr": 4363288576,
         "object_name": "crasher",
         "object_uuid": "E3D94DC3-214E-3CBF-8E32-694C8AD235ED",
         "symbol_addr": 4363288576
        },
        {
         "instruction_addr": 4363298512,
         "object_addr": 4363288576,
         "object_name": "crasher",
         "object_uuid": "E3D94DC3-214E-3CBF-8E32-694C8AD235ED",
         "symbol_addr": 4363288576
        },
        {
         "instruction_addr": 6569163304,
         "object_addr": 6569156608,
         "object_name": "libdispatch.dylib",
         "object_uuid": "B2000CD5-F580-314A-A141-E036719D854E",
         "symbol_addr": 6569163272,
         "symbol_name": "_dispatch_call_block_and_release"
        }
       ],
       "skipped": 0
      },
      "threads": [
       {
        "backtrace": {
         "contents": [
          {
           "instruction_addr": 6572943496,
           "object_addr": 6571241472,
           "object_name": "CoreFoundation",
           "object_uuid": "9B672762-7B1F-30BC-96DE-F176B372D66D",
           "symbol_addr": 6572942676,
           "symbol_name": "__handleUncaughtException"
          },
          {
           "instruction_addr": 6566463624,
           "object_addr": 6566313984,
           "object_name": "libobjc.A.dylib",
           "object_uuid": "03BD9E32-CF0A-37B0-898A-3CE8DE06D842",
           "symbol_addr": 6566463480,
           "symbol_name": "_ZL15_objc_terminatev"
          },
          {
           "instruction_addr": 4363365920,
           "object_addr": 4363288576,
           "object_name": "crasher",
           "object_uuid": "E3D94DC3-214E-3CBF-8E32-694C8AD235ED",
           "symbol_addr": 4363288576
          },
          {
           "instruction_addr": 6570669916,
           "object_addr": 6570590208,
           "object_name": "libc++abi.dylib",
           "object_uuid": "F38A9C58-22AB-3798-BBAE-8DCD9CC0CE27",
           "symbol_addr": 6570669900,
           "symbol_name": "_ZSt11__terminatePFvvE"
          },
          {
           "instruction_addr": 6570679268,
           "object_addr": 6570590208,
           "object_name": "libc++abi.dylib",
           "object_uuid": "F38A9C58-22AB-3798-BBAE-8DCD9CC0CE27",
           "symbol_addr": 6570679180,
           "symbol_name": "_ZN10__cxxabiv1L12failed_throwEPNS_15__cxa_exceptionE"
          },
          {
           "instruction_addr": 6570598556,
           "object_addr": 6570590208,
           "object_name": "libc++abi.dylib",
           "object_uuid": "F38A9C58-22AB-3798-BBAE-8DCD9CC0CE27",
           "symbol_addr": 6570598464,
           "symbol_name": "__cxa_throw"
          },
          {
           "instruction_addr": 6566423172,
           "object_addr": 6566313984,
           "object_name": "libobjc.A.dylib",
           "object_uuid": "03BD9E32-CF0A-37B0-898A-3CE8DE06D842",
           "symbol_addr": 6566422724,
           "symbol_name": "objc_exception_throw"
          },
          {
           "instruction_addr": 6573284772,
           "object_addr": 6571241472,
           "object_name": "CoreFoundation",
           "object_uuid": "9B672762-7B1F-30BC-96DE-F176B372D66D",
           "symbol_addr": 6573284292,
           "symbol_name": "__boundsFail"
          },
          {
           "instruction_addr": 6571499672,
           "object_addr": 6571241472,
           "object_name": "CoreFoundation",
           "object_uuid": "9B672762-7B1F-30BC-96DE-F176B372D66D",
           "symbol_addr": 6571499628,
           "symbol_name": "-[__NSArrayI objectAtIndex:]"
          },
          {
           "instruction_addr": 4363298564,
           "object_addr": 4363288576,
           "object_name": "crasher",
           "object_uuid": "E3D94DC3-214E-3CBF-8E32-694C8AD235ED",
           "symbol_addr": 4363288576
          }
         ],
         "skipped": 0
        },
        "crashed": true,
        "current_thread": true,
        "index": 4
       }
      ]
     },
     "report": {
      "id": "A97FF9AB-A3A2-4B18-AE09-312343F7C477",
      "monitor_id": "NSException",
      "process_name": "crasher",
      "run_id": "e0eec13e-d208-4558-97a5-4390ea611412",
      "timestamp": "2026-11-02T15:45:30.635935Z",
      "type": "standard",
      "version": "3.9.0"
     },
     "system": {
      "app_uuid": "E3D94DC3-214E-3CBF-8E32-694C8AD235ED",
      "application_stats": {
       "active_time_since_last_crash": 0.000696584,
       "active_time_since_launch": 0.000696584,
       "app_transition_state": "active",
       "application_active": true,
       "application_in_foreground": true,
       "background_time_since_last_crash": 0,
       "background_time_since_launch": 0,
       "launches_since_last_crash": 1,
       "sessions_since_last_crash": 1,
       "sessions_since_launch": 1,
       "task_role": "UNSPECIFIED",
       "user_perceptible": true
      },
      "binary_arch": "arm64",
      "cpu_arch": "arm64e",
      "os_version": "25G83",
      "system_name": "macOS",
      "system_version": "26.6.2"
     }
    }
    """#

    private func realRecord(_ report: String = Self.realReport) throws -> [String: Any] {
        let parsed = try #require(
            try JSONSerialization.jsonObject(with: Data(report.utf8)) as? [String: Any]
        )
        return try mapped(parsed)
    }

    @Test("an NSException's frames start where it was thrown, from last_exception_backtrace")
    func nsExceptionFramesStartAtTheThrow() throws {
        let record = try realRecord(Self.realNSExceptionReport)
        let frames = try #require(record["stacktrace"] as? [[String: Any]])

        #expect(record["errorType"] as? String == "NSRangeException")
        #expect(
            frames.map { $0["function"] as? String } == [
                "__exceptionPreprocess + 0xa4", "objc_exception_throw + 0x58",
                "__boundsFail + 0x1e0", "-[__NSArrayI objectAtIndex:] + 0x2c",
                "crasher + 0x2704", "crasher + 0x2690", "crasher + 0x26d0",
                "_dispatch_call_block_and_release + 0x20",
            ]
        )
    }

    @Test("a stripped app's frames name the image and the offset into it, which its dSYM resolves")
    func strippedFramesCarryImageOffsets() throws {
        let frames = try #require(try realRecord()["stacktrace"] as? [[String: Any]])

        #expect(frames.map { $0["filename"] as? String } == ["crasher", "crasher", "dyld"])
        #expect(
            frames.map { $0["function"] as? String }
                == ["crasher + 0x2334", "crasher + 0x1fdc", "start + 0x1b50"]
        )
    }

    @Test("the app's load address comes from binary_images, the only place KSCrash writes it")
    func loadAddressFromBinaryImages() throws {
        let metadata = try #require(try realRecord()["metadata"] as? [String: Any])

        #expect(metadata["app_image_uuid"] as? String == "DFDE3409-DA27-3BA8-8DA4-13D14B43DBF5")
        #expect(metadata["app_image_load_address"] as? String == "0x0000000102ef8000")
    }

    @Test("reads the crash time the report store hands back: an ISO string with microseconds")
    func readsTheStoreTimestamp() throws {
        let record = try realRecord()

        #expect(record["crashEpochMs"] as? Int64 == 1_793_629_060_091)
        #expect(record["errorType"] as? String == "EXC_BAD_ACCESS")
    }

    // MARK: - metadata

    @Test("stamps the native markers and crash details")
    func stampsMetadata() throws {
        let record = try mapped(report(
            error: [
                "signal": ["name": "SIGSEGV", "code_name": "SEGV_MAPERR"],
                "mach": ["exception_name": "EXC_BAD_ACCESS"],
                "address": UInt64(0x10),
            ],
            threads: [["crashed": false], ["crashed": true]]
        ))

        let metadata = try #require(record["metadata"] as? [String: Any])
        #expect(metadata["native"] as? Bool == true)
        #expect(metadata["fatal"] as? Bool == true)
        #expect(metadata["crash_source"] as? String == "kscrash")
        #expect(metadata["signal"] as? String == "SIGSEGV")
        #expect(metadata["signal_code"] as? String == "SEGV_MAPERR")
        #expect(metadata["mach_exception"] as? String == "EXC_BAD_ACCESS")
        #expect(metadata["fault_address"] as? String == "0x0000000000000010")
        #expect(metadata["thread_count"] as? Int == 2)
        #expect(metadata["crashed_thread"] as? Int == 1)
    }

    @Test("preserves the app image identity for later symbolication")
    func preservesImageIdentity() throws {
        // A dSYM needs these to resolve the frames, and they cannot be recovered
        // after the fact, so dropping them would leave every crash permanently
        // unsymbolicatable.
        let record = try mapped(report(
            error: ["signal": ["name": "SIGSEGV"]],
            system: ["app_uuid": "8C5F1234-DEAD-BEEF"],
            images: [
                ["name": "/usr/lib/dyld", "uuid": "74E52480-C2BD", "image_addr": UInt64(0x1_8769_0000)],
                ["name": "/var/containers/AcmeShop", "uuid": "8C5F1234-DEAD-BEEF", "image_addr": UInt64(0x1_04a3_8000)],
            ]
        ))

        let metadata = try #require(record["metadata"] as? [String: Any])
        #expect(metadata["app_image_uuid"] as? String == "8C5F1234-DEAD-BEEF")
        #expect(metadata["app_image_load_address"] as? String == "0x0000000104a38000")
    }

    // MARK: - timestamp, snapshot, screen

    /// KSCrash writes `report.timestamp` in MICROSECONDS
    /// (`addUIntegerElement(…, ksdate_microseconds())`, KSCrashReportC.c). Read
    /// as seconds it lands a million times further into the future — a crash
    /// that still delivers and is unusable, which no on-device test would flag.
    @Test("reads the crash time as microseconds, not seconds")
    func usesCrashTime() throws {
        let record = try mapped(report(error: ["signal": ["name": "SIGSEGV"]]))

        #expect(record["crashEpochMs"] as? Int64 == 1_700_000_123_456)
    }

    /// Sanity on the units rather than the arithmetic: a crash time must land
    /// in a plausible present, not in the year 56 million.
    @Test("the crash time is a believable epoch-millisecond value")
    func crashTimeIsPlausible() throws {
        let record = try mapped(report(error: [:]))
        let ms = try #require(record["crashEpochMs"] as? Int64)

        // 2020-01-01 .. 2100-01-01 in epoch ms.
        #expect(ms > 1_577_836_800_000)
        #expect(ms < 4_102_444_800_000)
    }

    /// The real report arrives from `JSONSerialization`, which boxes every
    /// number as `NSNumber` — not as the native `Int` a hand-built fixture
    /// holds. Round-tripping through JSON here keeps the two paths honest: a
    /// mapper that reads only one boxing would pass every other test in this
    /// file and return nothing on a device.
    @Test("reads a report that came through JSONSerialization, as a real one does")
    func readsJsonSerializedReport() throws {
        let raw = try JSONSerialization.data(
            withJSONObject: report(error: ["signal": ["name": "SIGSEGV"]])
        )
        let parsed = try #require(
            try JSONSerialization.jsonObject(with: raw) as? [String: Any]
        )

        let json = try #require(
            GCRumCrashReportMapper.buildRecord(report: parsed, sessionSnapshotJson: nil)
        )
        let record = try #require(
            try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        )

        #expect(record["crashEpochMs"] as? Int64 == 1_700_000_123_456)
        #expect(record["errorType"] as? String == "SIGSEGV")
    }

    @Test("carries the snapshot through untouched")
    func carriesSnapshotThrough() throws {
        // Kept as an opaque string: JS parses it, and re-encoding an envelope we
        // never inspect would only risk mangling it.
        let record = try mapped(report(error: [:]), snapshotJson: snapshot)

        #expect(record["sessionSnapshotJson"] as? String == snapshot)
    }

    @Test("lifts the screen out of the snapshot")
    func liftsScreen() throws {
        let record = try mapped(report(error: [:]), snapshotJson: snapshot)

        let screen = try #require(record["screen"] as? [String: Any])
        #expect(screen["name"] as? String == "Checkout")
        #expect(screen["key"] as? String == "Checkout-1")
    }

    @Test("falls back to an empty screen on a missing or corrupt snapshot",
          arguments: [nil, "{not json", #"{"session_id":"s-1"}"#] as [String?])
    func emptyScreenOnBadSnapshot(snapshotJson: String?) throws {
        let record = try mapped(report(error: [:]), snapshotJson: snapshotJson)

        let screen = try #require(record["screen"] as? [String: Any])
        #expect(screen["name"] as? String == "")
        #expect(screen["key"] as? String == "")
    }

    @Test("returns nil for a report with no id")
    func nilWithoutAnId() {
        // Without an id there is no ack key, so the record could never be
        // cleared and would be redelivered on every launch forever.
        let malformed: [String: Any] = ["crash": ["error": ["signal": ["name": "SIGSEGV"]]]]

        #expect(GCRumCrashReportMapper.buildRecord(report: malformed, sessionSnapshotJson: nil) == nil)
    }

    @Test("truncates an enormous message")
    func truncatesMessage() throws {
        let record = try mapped(report(error: [
            "nsexception": [
                "name": "NSGenericException",
                "reason": String(repeating: "x", count: 10_000),
            ],
        ]))

        #expect((record["errorMessage"] as? String)?.count == 2_000)
    }
}
