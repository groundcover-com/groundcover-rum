package com.groundcover.nativeplayground.screens

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.groundcover.nativeplayground.Button
import com.groundcover.nativeplayground.Card
import com.groundcover.nativeplayground.DROP_MARKER
import com.groundcover.nativeplayground.PageBody
import com.groundcover.nativeplayground.PageHint
import com.groundcover.nativeplayground.PageTitle
import com.groundcover.rum.Groundcover
import com.groundcover.rum.GroundcoverConfigUpdate
import com.groundcover.rum.GroundcoverRumTesting
import com.groundcover.rum.UserUpdate

/**
 * Everything the e2e suite needs that is neither a captured signal nor a gesture: which preset
 * the app booted with, the public API methods no other screen calls, and the hooks the session
 * specs drive.
 */
@Composable
fun ConfigScreen(preset: String) {
    val context = LocalContext.current
    var sessionId by remember { mutableStateOf("—") }
    var done by remember { mutableStateOf("—") }
    val mark = { what: String -> done = "$what: done" }

    PageBody {
        PageTitle("Config & lifecycle")
        // The preset spec gate: every preset spec waits for this line to read back the preset
        // it asked for. One string, so an exact getByText matches.
        Text("preset: $preset")
        // Status lines sit above every card, so a spec that scrolled to a control lower down can
        // still see them.
        Text("Session: $sessionId")
        Text("Last action: $done")
        PageHint(
            "The preset comes from e2e-preset.json in the app's files directory, written by the " +
                "harness. Relaunch to boot with another.",
        )
        Card {
            // Carries the marker the `callbacks` preset's beforeSend drops on. The unmarked
            // survivor beside it is what makes the drop mean something: "no event arrived" is
            // also what a dead SDK sends.
            Button(
                label = "tap $DROP_MARKER (beforeSend drops this)",
                testId = "config-dropme",
                onClick = { mark("dropme") },
            )
            Button(
                label = "tap survivor (beforeSend keeps this)",
                testId = "config-survivor",
                onClick = { mark("survivor") },
            )
        }
        PageTitle("Public API")
        PageHint(
            "Methods no other screen calls: clearing the identity, reading and setting the " +
                "session id, manual navigation, the manual TTI mark, and turning navigation " +
                "tracking off.",
        )
        Card {
            Button(
                label = "show session id",
                testId = "config-show-session",
                onClick = { sessionId = Groundcover.sessionId.ifEmpty { "(not ready)" } },
            )
            Button(
                label = "setSessionId fixed",
                testId = "config-set-session",
                // A recognisable id, so a spec can tell the SDK adopted this one rather than
                // rotating to any new value.
                onClick = {
                    Groundcover.setSessionId("e2e-fixed-session-id") { mark("setSessionId") }
                },
            )
            Button(
                label = "clear identity",
                testId = "config-clear-user",
                onClick = {
                    Groundcover.updateConfig(GroundcoverConfigUpdate(user = UserUpdate.Clear))
                    mark("clearIdentity")
                },
            )
            Button(
                label = "manual navigation",
                testId = "config-manual-nav",
                // The screen name is required: a record without one is dropped.
                onClick = {
                    Groundcover.startNavigation("ManualScreen", key = "manual-1")
                    Groundcover.endNavigation(mapOf("e2e_manual" to "end"))
                    mark("manualNav")
                },
            )
            Button(
                label = "manual navigation unnamed",
                testId = "config-manual-nav-unnamed",
                onClick = {
                    Groundcover.startNavigation("", metadata = mapOf("e2e_manual" to "nameless"))
                    Groundcover.endNavigation(mapOf("e2e_manual" to "nameless"))
                    mark("manualNavUnnamed")
                },
            )
            Button(
                label = "markAppInteractive",
                testId = "config-mark-interactive",
                onClick = {
                    Groundcover.markAppInteractive()
                    mark("markInteractive")
                },
            )
            Button(
                label = "stopNavigationTracking",
                testId = "config-stop-nav-tracking",
                onClick = {
                    Groundcover.stopNavigationTracking()
                    mark("stopNavTracking")
                },
            )
        }
        PageTitle("Session anchors (DEBUG)")
        PageHint(
            "The SDK reads the persisted session at launch, so changing it and relaunching is the " +
                "on-device stand-in for a mocked clock. Relaunch after tapping.",
        )
        Card {
            Button(
                label = "backdate activity 31m",
                testId = "config-backdate-activity",
                onClick = {
                    GroundcoverRumTesting.backdateLastActivity(context, 31 * 60_000L)
                    mark("backdateActivity")
                },
            )
            Button(
                label = "backdate session start 5h",
                testId = "config-backdate-start",
                onClick = {
                    GroundcoverRumTesting.backdateSessionStart(context, 5 * 3_600_000L)
                    mark("backdateStart")
                },
            )
            Button(
                label = "forget session",
                testId = "config-forget-session",
                // The next launch starts a session no user has touched yet, the only way to reach
                // the ghost-session gate on a device.
                onClick = {
                    GroundcoverRumTesting.forgetSession(context)
                    mark("forgetSession")
                },
            )
        }
    }
}
