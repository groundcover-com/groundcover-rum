package com.groundcover.rum.engine.crash

/**
 * The staging half of the snapshot store, narrowed to just "write a record".
 *
 * It lives in its own file, away from the Context-bound store, so the producers
 * of crash records — pure logic, and the part most worth testing — compile and
 * run on a bare JVM with no Android SDK.
 */
internal interface GcRumPendingRecordWriter {
    /**
     * @return whether the record reached a file the drain will find. A `false` is not
     *   theoretical: the write can be refused by a full volume, a revoked permission, or a
     *   rename the filesystem will not perform. Returning `Unit` would make every caller assume
     *   success, and bookkeeping would record work that never happened.
     */
    fun writePendingRecord(id: String, json: String): Boolean
}
