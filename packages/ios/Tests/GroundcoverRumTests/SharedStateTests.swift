import Testing

/// The suites that touch process-wide state: the SDK's shared runtime, which a public `start`
/// starts, and the UserDefaults suite it and the testing hooks keep the session in. Run one at a
/// time, so one suite's start can't write the keys another is checking.
@Suite(.serialized) struct SharedStateTests {}
