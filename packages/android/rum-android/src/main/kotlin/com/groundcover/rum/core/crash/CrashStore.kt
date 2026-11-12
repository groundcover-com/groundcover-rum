package com.groundcover.rum.core.crash

/**
 * The native engine's crash records, and the session it files with a crash. The pipeline keeps
 * that session current and delivers the records.
 */
internal interface CrashStore {
    /**
     * The session envelope plus the current screen, as JSON, for the engine to file with a crash;
     * null clears it.
     */
    fun updateSessionSnapshot(json: String?)

    /** The previous runs' crash records, as a JSON array. */
    fun pendingCrashReportsJson(): String

    /** Deletes the records with these ids, once their batch was delivered. */
    fun clearPendingCrashReports(ids: List<String>)
}
