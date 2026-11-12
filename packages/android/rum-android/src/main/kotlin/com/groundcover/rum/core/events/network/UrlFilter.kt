package com.groundcover.rum.core.events.network

import com.groundcover.rum.UrlPattern
import com.groundcover.rum.core.common.handleError

// Every metacharacter but the glob's own `*` and `?`.
private val GLOB_META = Regex("[.+^\${}()|\\[\\]\\\\]")

// Leading and trailing `*` add nothing to an unanchored match, and a pattern opening on `.*`
// backtracks across the whole URL from every position.
private val OUTER_STARS = Regex("^\\*+|\\*+$")

/**
 * Whether a request is left uncaptured: the SDK's own traffic to [endpoint], or a match in
 * [excludedUrls]: a regular expression, a `*`/`?` glob that matches anywhere in the URL, or an
 * exact URL. A glob's `?` is any one character, as the API documents.
 */
internal fun shouldIgnoreUrl(
    url: String,
    endpoint: String? = null,
    excludedUrls: List<UrlPattern> = emptyList()
): Boolean = try {
    if (!endpoint.isNullOrEmpty() && url.contains(endpoint)) {
        true
    } else {
        excludedUrls.any { pattern ->
            when (pattern) {
                is UrlPattern.Expression -> pattern.regex.containsMatchIn(url)

                is UrlPattern.Text -> {
                    val text = pattern.value
                    if (text.contains('*') || text.contains('?')) {
                        val glob = text.replace(OUTER_STARS, "")
                            .replace(GLOB_META) { "\\" + it.value }
                            .replace("*", ".*")
                            .replace("?", ".")
                        Regex(glob).containsMatchIn(url)
                    } else {
                        url == text
                    }
                }
            }
        }
    }
} catch (error: Exception) {
    handleError(error)
    false
}
