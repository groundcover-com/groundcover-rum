package com.groundcover.nativeplayground.screens

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import com.groundcover.nativeplayground.Button
import com.groundcover.nativeplayground.Card
import com.groundcover.nativeplayground.ConfigEnv
import com.groundcover.nativeplayground.PageBody
import com.groundcover.nativeplayground.PageHint
import com.groundcover.nativeplayground.PageTitle
import com.groundcover.nativeplayground.PlaygroundApp
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private val json = "application/json".toMediaType()

private const val SENSITIVE_BODY =
    """{"password":"e2e-body-password","email":"demo@example.com","order_id":"A-1"}"""

/**
 * Every request the network specs make. In e2e the DSN is the mock ingest on :9393, and the echo
 * sits on its sibling port :9394, because the SDK skips requests to its own ingest.
 *
 * The "fetch" buttons keep RN's labels, since the shared specs tap them by text; here they go
 * through the app's one OkHttp client, Android's everyday one, enqueued as most apps call it. The
 * three OkHttp buttons below them each hit their own echo path, so the native-clients spec can
 * tell which way of calling OkHttp produced an event.
 */
@Composable
fun NetworkScreen() {
    var last by remember { mutableStateOf("—") }
    val scope = rememberCoroutineScope()
    val echo = ConfigEnv.echoUrl

    fun run(
        label: String,
        request: suspend () -> Outcome,
    ): () -> Unit =
        {
            last = "$label: …"
            scope.launch {
                last =
                    try {
                        when (val outcome = request()) {
                            is Outcome.Skipped -> "$label: skipped — ${outcome.reason}"
                            Outcome.Ok -> "$label: ok"
                        }
                    } catch (e: Exception) {
                        "$label: $e"
                    }
            }
        }

    PageBody {
        PageTitle("Network")
        PageHint(
            "Requests through an OkHttp client built with GroundcoverOkHttpInterceptor. Inspect " +
                "the echoed request to see the injected `traceparent`.",
        )
        Card {
            Button(
                label = "fetch GET",
                testId = "net-fetch-get",
                onClick = run("fetch") { PlaygroundApp.http.enqueued(get(echo)) },
            )
            Button(
                label = "fetch POST",
                testId = "net-fetch-post",
                onClick =
                    run("fetch-post") {
                        PlaygroundApp.http.enqueued(
                            Request
                                .Builder()
                                .url(echo)
                                .post("""{"hello":"mobile"}""".toRequestBody(json))
                                .build(),
                        )
                    },
            )
            Button(
                label = "abort in-flight",
                testId = "net-abort",
                // Starts a request against the slow echo and cancels it before it can answer. A
                // cancelled request must not be reported; the spec pairs it with one that lands, so
                // silence can't pass on its own.
                onClick =
                    run("abort") {
                        val call = PlaygroundApp.http.newCall(get("$echo/slow?ms=5000"))
                        scope.launch {
                            delay(200)
                            call.cancel()
                        }
                        call.awaited()
                    },
            )
            Button(
                label = "large response",
                testId = "net-large-response",
                // Over 5 KB of JSON, past the SDK's response-body cap.
                onClick = run("large") { PlaygroundApp.http.enqueued(get("$echo/large")) },
            )
            Button(
                label = "failing request",
                testId = "net-fail",
                // Loopback port 1 refuses at once: a fast, deterministic failure, captured as
                // status 0.
                onClick =
                    run("fail") {
                        PlaygroundApp.http.enqueued(get("http://127.0.0.1:1/unreachable"))
                    },
            )
            Button(
                label = "sensitive request",
                testId = "net-sensitive",
                // A secret in each place the SDK redacts on its own (query, header, body) plus two
                // values that must survive. Local mock only: a real DSN's fallback echo is public
                // and echoes back.
                onClick =
                    run("sensitive") {
                        if (!ConfigEnv.echoIsLocalMock) {
                            Outcome.Skipped("local-mock only; the echo is public here")
                        } else {
                            PlaygroundApp.http.enqueued(
                                Request
                                    .Builder()
                                    .url("$echo/sensitive?token=e2e-query-token&user=demo")
                                    .header("authorization", "Bearer e2e-bearer-secret")
                                    .post(SENSITIVE_BODY.toRequestBody(json))
                                    .build(),
                            )
                        }
                    },
            )
            Button(
                label = "OkHttp enqueue GET",
                testId = "net-okhttp-enqueue",
                onClick = run("enqueue") { PlaygroundApp.http.enqueued(get("$echo/enqueue")) },
            )
            Button(
                label = "OkHttp execute GET",
                testId = "net-okhttp-execute",
                // A blocking call on a background thread, the other way apps call OkHttp.
                onClick =
                    run("execute") {
                        withContext(Dispatchers.IO) {
                            PlaygroundApp.http.newCall(get("$echo/execute")).execute().use {
                                it.body?.string()
                            }
                        }
                        Outcome.Ok
                    },
            )
            Button(
                label = "OkHttp derived client GET",
                testId = "net-okhttp-derived",
                // A client derived with newBuilder(), as apps do for a per-feature timeout: it
                // inherits the interceptor and the listener factory.
                onClick =
                    run("derived") {
                        PlaygroundApp.http.newBuilder().build().enqueued(get("$echo/derived"))
                    },
            )
            Text("Last: $last")
        }
    }
}

/** A request that ran, or one that declined to and says why: never reported as `ok`. */
private sealed interface Outcome {
    data object Ok : Outcome

    data class Skipped(val reason: String) : Outcome
}

private fun get(url: String): Request = Request.Builder().url(url).build()

private suspend fun OkHttpClient.enqueued(request: Request): Outcome = newCall(request).awaited()

/** Enqueues the call and suspends until its callback, reading and closing the body. */
private suspend fun Call.awaited(): Outcome =
    suspendCancellableCoroutine { continuation ->
        enqueue(
            object : Callback {
                override fun onResponse(call: Call, response: Response) {
                    response.use { it.body?.string() }
                    continuation.resume(Outcome.Ok)
                }

                override fun onFailure(call: Call, e: IOException) {
                    continuation.resumeWithException(e)
                }
            },
        )
    }
