package com.groundcover.rum.core.common

import java.util.Collections
import java.util.IdentityHashMap
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

// JSON for what the app hands the SDK unflattened: user properties, and whatever an enrichEvent,
// beforeSend or redact hook puts back.

private const val MAX_JSON_DATA_DEPTH = 32

/**
 * [value] as plain JSON data: maps with string keys, lists and JSON scalars, anything else as
 * [jsonLeaf] writes it, a cycle marked `[Circular]`, and nesting past 32 levels cut. For what the
 * app hands the SDK to keep, made once, so a batch never fails on one odd value.
 */
internal fun toJsonData(value: Any?): Any? =
    toJsonData(value, Collections.newSetFromMap(IdentityHashMap()), 0)

/** [map] as [toJsonData] makes it. */
@Suppress("UNCHECKED_CAST")
internal fun toJsonMap(map: Map<*, *>): Map<String, Any?> = toJsonData(map) as Map<String, Any?>

/**
 * Anything that isn't a map, a collection or an array, as JSON can carry it: a non-finite number
 * is null, and anything but a JSON scalar its string form.
 */
internal fun jsonLeaf(value: Any?): Any? = when (value) {
    null, is String, is Boolean, is Int, is Long, is Short, is Byte -> value
    is Double -> if (value.isFinite()) value else null
    is Float -> if (value.isFinite()) value.toDouble() else null
    else -> value.toString()
}

/** [value] as JSON text, written as [toJsonData] makes it. */
internal fun encodeJson(value: Any?): String = when (val json = toOrgJson(toJsonData(value))) {
    is JSONObject, is JSONArray -> json.toString()
    is String -> JSONObject.quote(json)
    is Number -> JSONObject.numberToString(json)
    else -> json.toString()
}

/** [json] decoded, when it is a JSON object; null for anything else, unreadable JSON included. */
@Suppress("UNCHECKED_CAST")
internal fun decodeJsonObject(json: String): Map<String, Any?>? = try {
    (JSONTokener(json).nextValue() as? JSONObject)?.let { fromOrgJson(it) as Map<String, Any?> }
} catch (error: Exception) {
    null
}

private fun toJsonData(value: Any?, seen: MutableSet<Any>, depth: Int): Any? {
    val isContainer =
        value is Map<*, *> || value is Iterable<*> || value?.javaClass?.isArray == true
    if (!isContainer) return jsonLeaf(value)
    if (depth >= MAX_JSON_DATA_DEPTH) return "[Depth Limit]"
    if (!seen.add(value!!)) return "[Circular]"
    try {
        return when (value) {
            is Map<*, *> -> LinkedHashMap<String, Any?>().apply {
                for ((key, child) in value) put(key.toString(), toJsonData(child, seen, depth + 1))
            }

            is Iterable<*> -> value.map { toJsonData(it, seen, depth + 1) }

            else -> List(java.lang.reflect.Array.getLength(value)) {
                toJsonData(java.lang.reflect.Array.get(value, it), seen, depth + 1)
            }
        }
    } finally {
        seen.remove(value)
    }
}

// JSONObject drops a key put with null, where JSON.stringify writes it; JSONObject.NULL keeps it.
private fun toOrgJson(value: Any?): Any = when (value) {
    null -> JSONObject.NULL

    is Map<*, *> -> JSONObject().apply {
        for ((key, child) in value) put(key as String, toOrgJson(child))
    }

    is List<*> -> JSONArray().apply { value.forEach { put(toOrgJson(it)) } }

    else -> value
}

private fun fromOrgJson(value: Any?): Any? = when (value) {
    JSONObject.NULL -> null

    is JSONObject -> LinkedHashMap<String, Any?>().apply {
        for (key in value.keys()) put(key, fromOrgJson(value.get(key)))
    }

    is JSONArray -> List(value.length()) { fromOrgJson(value.get(it)) }

    else -> value
}

// A collection or an array as a list; null for anything else. A List is itself, so a cycle back
// to it is recognised.
internal fun asList(value: Any?): List<Any?>? = when (value) {
    is List<*> -> value

    is Iterable<*> -> value.toList()

    is Array<*> -> value.toList()

    else -> if (value != null && value.javaClass.isArray) {
        List(java.lang.reflect.Array.getLength(value)) { java.lang.reflect.Array.get(value, it) }
    } else {
        null
    }
}
