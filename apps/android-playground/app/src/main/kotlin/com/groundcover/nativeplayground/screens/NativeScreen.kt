package com.groundcover.nativeplayground.screens

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.groundcover.nativeplayground.Button
import com.groundcover.nativeplayground.Card
import com.groundcover.nativeplayground.PageBody
import com.groundcover.nativeplayground.PageHint
import com.groundcover.nativeplayground.PageTitle
import com.groundcover.rum.GroundcoverRumTesting
import com.groundcover.rum.compose.GroundcoverNavigationEffect
import kotlinx.coroutines.launch

/** How long "Block main thread" blocks for. The hang specs assert against it. */
const val HANG_STALL_MS = 3_000L

/**
 * A named composable rather than a bare Text, so a tap's component path names something a
 * product engineer recognises.
 */
@Composable
fun ScrollRow(label: String) {
    Text(label, fontSize = 16.sp, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp))
}

/**
 * Drives the native signals from the UI, and holds the lists the gesture specs drag.
 *
 * Crash and hang come from the SDK's development-only hooks (GroundcoverRumTesting), as
 * rn-playground's come from its native module.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun NativeScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var note by remember { mutableStateOf("") }
    var modalOpen by remember { mutableStateOf(false) }
    var checkoutOpen by remember { mutableStateOf(false) }

    // The note is drawn before the action runs: the hang blocks the main thread, and a stall that
    // started before its frame would keep "hang: triggered" off the screen until it ended.
    fun run(
        label: String,
        action: () -> Unit,
    ): () -> Unit =
        {
            note = "$label: triggered"
            scope.launch {
                withFrameNanos {}
                withFrameNanos {}
                action()
            }
        }

    // This screen owns a list, so the page itself does not scroll.
    PageBody(scroll = false) {
        PageTitle("Native signals")
        PageHint(
            "Crashes, hangs, app start and frame vitals come from the native engine. A crash is " +
                "reported on the NEXT launch, under the session it happened in.",
        )
        Card {
            Button(
                label = "Crash natively",
                testId = "native-crash",
                a11yLabel = "Crash natively",
                onClick = run("crash") { GroundcoverRumTesting.triggerTestCrash(context) },
            )
            Button(
                label = "Block main thread",
                testId = "native-hang",
                a11yLabel = "Block main thread",
                onClick =
                    run("hang") { GroundcoverRumTesting.blockMainThread(context, HANG_STALL_MS) },
            )
            Text(note)
        }
        PageHint(
            "Scroll this list to exercise gesture capture: the SDK classifies the swipe from the " +
                "touch stream.",
        )
        Button(label = "Open modal", a11yLabel = "Open modal", onClick = { modalOpen = true })
        Button(
            label = "Open checkout",
            a11yLabel = "Open checkout",
            onClick = { checkoutOpen = true },
        )
        RowList(label = "Scrollable list", testId = "native-scroll-list", rowPrefix = "Row")
    }

    if (checkoutOpen) CheckoutFlow(onClose = { checkoutOpen = false })

    if (modalOpen) {
        // A Dialog: a window of its own, not an Activity, the case the SDK's per-Activity window
        // hooks don't reach on their own (RN's Modal is one too).
        Dialog(
            onDismissRequest = { modalOpen = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Column(
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .background(Color.White)
                        .padding(16.dp)
                        // A dialog is a composition of its own, so the root's setting doesn't
                        // reach it: its test tags need this to become resource ids too.
                        .semantics { testTagsAsResourceId = true },
            ) {
                PageTitle("Modal list")
                Button(
                    label = "Close modal",
                    a11yLabel = "Close modal",
                    onClick = { modalOpen = false },
                    modifier = Modifier.padding(vertical = 12.dp),
                )
                RowList(
                    label = "Modal scrollable list",
                    testId = "modal-scroll-list",
                    rowPrefix = "Modal row",
                )
            }
        }
    }
}

/**
 * A checkout flow over the Native screen: a full-screen layer with a NavHost and a
 * GroundcoverNavigationEffect of its own, as an app shows a modal flow. Closing it navigates
 * nothing in the app's NavHost, which stays on Native throughout, so only the SDK can make Native
 * the screen again.
 */
@Composable
private fun CheckoutFlow(onClose: () -> Unit) {
    val navController = rememberNavController()
    GroundcoverNavigationEffect(navController)
    Box(
        modifier =
            Modifier
                .fillMaxSize()
                .background(Color.White)
                // A layer over the screen: no touch reaches the Native screen's buttons below.
                .pointerInput(Unit) {},
    ) {
        NavHost(
            navController = navController,
            startDestination = "Cart",
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None },
        ) {
            composable("Cart") {
                Column(modifier = Modifier.padding(16.dp)) {
                    PageTitle("Cart")
                    Button(
                        label = "Close checkout",
                        a11yLabel = "Close checkout",
                        onClick = onClose,
                    )
                }
            }
        }
    }
}

/** 60 rows, each its own text node, in a list 220 dp tall that carries [label]. */
@Composable
private fun RowList(
    label: String,
    testId: String,
    rowPrefix: String,
) {
    LazyColumn(
        modifier =
            Modifier
                .fillMaxWidth()
                .height(220.dp)
                .testTag(testId)
                .semantics { contentDescription = label },
    ) {
        items(60) { i -> ScrollRow("$rowPrefix ${i + 1}") }
    }
}
