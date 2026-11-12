package com.groundcover.rum.engine.crash

import org.json.JSONObject

/**
 * Lifts the `screen` envelope out of a persisted session snapshot into the `{name, key}`
 * shape a crash record carries.
 *
 * ONE definition on purpose. Two paths stamp a crash with its screen — [GcRumCrashRecordMapper]
 * for a death our in-process handler saw, and [GcRumExitInfoHarvester] for one replayed from
 * ApplicationExitInfo on the next launch — and they MUST agree, or the same session's crash is
 * attributed to a different screen depending only on whether the process ran our handler before
 * it died. Two copies could drift apart; one shared definition can't.
 */
internal object GcRumScreenSnapshot {
    fun screenFrom(snapshotJson: String?): JSONObject {
        val empty = JSONObject().put("name", "").put("key", "")
        if (snapshotJson == null) return empty
        return runCatching {
            val screen = JSONObject(snapshotJson).optJSONObject("screen") ?: return empty
            JSONObject()
                .put("name", stringMember(screen, "name"))
                .put("key", stringMember(screen, "key"))
        }.getOrDefault(empty)
    }

    /**
     * A member's value ONLY when it is a real JSON string, else "". `optString` would
     * coerce a number or nested object to its textual form — a screen name that was `5`
     * on a corrupt or cross-version snapshot would read as `"5"` on the wire. Absent is
     * the honest answer, not a fabricated string.
     */
    private fun stringMember(obj: JSONObject, key: String): String =
        (obj.opt(key) as? String) ?: ""
}
