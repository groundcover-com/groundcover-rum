package com.groundcover.rum.engine.crash

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import java.io.Reader

/**
 * The thin Android-API layer under [GcRumExitInfoHarvester]. Everything here is
 * platform calls only; the selection and bookkeeping policy lives in the
 * harvester, where it can be tested without an emulator.
 */

@RequiresApi(Build.VERSION_CODES.R)
internal class AndroidExitInfoReader(
    private val context: Context,
) : GcRumExitInfoHarvester.GcRumExitInfoReader {

    override fun recentExits(): List<GcRumExitInfoHarvester.ExitInfo> {
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            ?: return emptyList()

        val exits = activityManager.getHistoricalProcessExitReasons(
            context.packageName,
            /* pid = */ 0,
            MAX_EXITS,
        )

        return exits.map { exit ->
            GcRumExitInfoHarvester.ExitInfo(
                timestampMs = exit.timestamp,
                reason = exit.reason,
                importance = exit.importance,
                description = exit.description,
                processName = exit.processName,
                readTrace = { readTrace(exit) },
            )
        }
    }

    /** Only ANRs carry a trace, and only sometimes. Reading it is best-effort:
     *  an ANR with no stack still ships, since the timing and the fact of the
     *  ANR are most of the value. */
    private fun readTrace(exit: ApplicationExitInfo): String? {
        if (exit.reason != GcRumExitInfoHarvester.REASON_ANR) return null
        return runCatching {
            exit.traceInputStream?.use { stream ->
                stream.bufferedReader().use { reader -> readAtMost(reader, MAX_TRACE_CHARS) }
            }
        }.getOrNull()
    }

    private companion object {
        const val MAX_EXITS = 16
        const val MAX_TRACE_CHARS = 256 * 1024
    }
}

/** SharedPreferences-backed watermark. Survives process death by definition —
 *  which is the only reason it is useful. */
internal class SharedPrefsExitBookkeeping(
    context: Context,
) : GcRumExitInfoHarvester.Bookkeeping {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun lastProcessedExitMs(): Long = prefs.getLong(KEY_LAST_EXIT_MS, 0L)

    /**
     * `apply()` rather than `commit()`, deliberately. It returns before the value reaches disk, so a
     * process death can lose the write — and that is affordable here, while a blocking disk write
     * is not: this runs inside `nativeInit` on nearly every launch (any app that has ever been
     * killed has a non-empty exit history), i.e. on the app-start path this SDK exists to measure.
     *
     * A lost cursor cannot resurrect an exit on its own. See the invariant on
     * `GcRumExitInfoHarvester.harvest` — its `>= previousRunStartedAtMs` filter excludes an exit on
     * every launch after the first one, so a replay would also require the previous launch to have
     * written no snapshot at all, which is a window two adjacent statements of `nativeInit` wide.
     */
    override fun setLastProcessedExitMs(value: Long) {
        prefs.edit().putLong(KEY_LAST_EXIT_MS, value).apply()
    }

    private companion object {
        const val PREFS_NAME = "groundcover-rum"
        const val KEY_LAST_EXIT_MS = "last_processed_exit_ms"
    }
}

/**
 * Up to [maxChars] of [reader], and no more read than that: a trace past the cap is decompressed
 * only as far as the cap, rather than whole and then cut.
 */
internal fun readAtMost(reader: Reader, maxChars: Int): String {
    val out = StringBuilder()
    val buffer = CharArray(minOf(maxChars, 8 * 1024).coerceAtLeast(1))
    while (out.length < maxChars) {
        val read = reader.read(buffer, 0, minOf(buffer.size, maxChars - out.length))
        if (read < 0) break
        out.append(buffer, 0, read)
    }
    return out.toString()
}
