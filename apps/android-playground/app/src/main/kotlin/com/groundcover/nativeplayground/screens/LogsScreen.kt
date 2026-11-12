package com.groundcover.nativeplayground.screens

import androidx.compose.runtime.Composable
import com.groundcover.nativeplayground.Button
import com.groundcover.nativeplayground.Card
import com.groundcover.nativeplayground.PageBody
import com.groundcover.nativeplayground.PageHint
import com.groundcover.nativeplayground.PageTitle
import com.groundcover.nativeplayground.PlaygroundError
import com.groundcover.rum.Groundcover
import timber.log.Timber

@Composable
fun LogsScreen() {
    PageBody {
        PageTitle("Logs")
        PageHint(
            "What the app logs through Timber (the SDK's tree is planted) and the explicit " +
                "Groundcover.logger API both emit `log` events through the same redaction contract.",
        )
        Card {
            Button(
                label = "platform log",
                testId = "logs-platform-log",
                onClick = { Timber.i("playground platform log") },
            )
            Button(
                label = "logger.info",
                testId = "logs-logger-info",
                onClick = { Groundcover.logger.info("explicit logger.info", mapOf("via" to "api")) },
            )
            Button(
                label = "logger.warn",
                testId = "logs-logger-warn",
                onClick = { Groundcover.logger.warn("explicit logger.warn") },
            )
        }
        PageTitle("Errors")
        PageHint(
            "A handled error reported with captureException, and an uncaught one, which on " +
                "Android ends the process: it is reported as a crash on the next launch.",
        )
        Card {
            Button(
                label = "captureException",
                testId = "errors-capture",
                onClick = {
                    Groundcover.captureException(
                        PlaygroundError("handled e2e error"),
                        mapOf("screen" to "Logs"),
                    )
                },
            )
            Button(
                label = "throw uncaught",
                testId = "errors-uncaught",
                // Thrown on a thread of its own, outside any handler, so it reaches the default
                // uncaught-exception handler, as RN's setTimeout throw reaches ErrorUtils.
                onClick = { Thread { throw PlaygroundError("uncaught e2e error") }.start() },
            )
        }
        PageTitle("Privacy fixtures")
        PageHint(
            "Sensitive payloads for the privacy matrix. Deliberately last on the screen: a " +
                "control inserted above shifts the ones the specs tap without scrolling. Append " +
                "here; never insert above.",
        )
        Card {
            Button(
                label = "log sensitive",
                testId = "logs-sensitive",
                // Secrets in both halves of a log event, the free-text message and the
                // attributes, which take different redaction paths.
                onClick = {
                    Groundcover.logger.info(
                        "user login password=e2e-log-password",
                        mapOf(
                            "api_key" to "e2e-log-apikey",
                            "order_id" to "A-1",
                            "email" to "demo@example.com",
                        ),
                    )
                },
            )
            Button(
                label = "capture sensitive error",
                testId = "errors-sensitive",
                onClick = {
                    Groundcover.captureException(
                        PlaygroundError("auth failed for token=e2e-error-token"),
                        mapOf("password" to "e2e-error-password", "order_id" to "A-1"),
                    )
                },
            )
        }
    }
}
