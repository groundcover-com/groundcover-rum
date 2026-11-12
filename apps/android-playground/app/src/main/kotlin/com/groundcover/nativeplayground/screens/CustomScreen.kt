package com.groundcover.nativeplayground.screens

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.groundcover.nativeplayground.Button
import com.groundcover.nativeplayground.Card
import com.groundcover.nativeplayground.PageBody
import com.groundcover.nativeplayground.PageHint
import com.groundcover.nativeplayground.PageTitle
import com.groundcover.rum.Groundcover
import com.groundcover.rum.RumUser

@Composable
fun CustomScreen() {
    var sessionId by remember { mutableStateOf("—") }
    PageBody {
        PageTitle("Custom & identity")
        PageHint(
            "Custom events and user identification. Then background the app: the SDK flushes " +
                "buffered events and persists the activity clock.",
        )
        Card {
            Button(
                label = "sendCustomEvent",
                testId = "custom-send",
                onClick = {
                    Groundcover.sendCustomEvent(
                        "checkout_completed",
                        mapOf("total" to 42, "currency" to "USD"),
                    )
                },
            )
            Button(
                label = "identifyUser",
                testId = "custom-identify",
                onClick = {
                    Groundcover.identifyUser(
                        RumUser(
                            id = "user-123",
                            email = "demo@example.com",
                            name = "Demo User",
                        ),
                    )
                },
            )
            Button(
                label = "show session id",
                testId = "custom-session",
                onClick = { sessionId = Groundcover.sessionId.ifEmpty { "(not ready)" } },
            )
            Text("Session: $sessionId")
        }
    }
}
