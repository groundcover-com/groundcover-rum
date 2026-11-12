package com.groundcover.nativeplayground.screens

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import com.groundcover.nativeplayground.Button
import com.groundcover.nativeplayground.Card
import com.groundcover.nativeplayground.Field
import com.groundcover.nativeplayground.PageBody
import com.groundcover.nativeplayground.PageHint
import com.groundcover.nativeplayground.PageTitle
import com.groundcover.rum.compose.groundcoverPrivate

/** The Taps tab: a Compose screen. */
@Composable
fun HomeScreen(onDetail: () -> Unit) {
    var count by remember { mutableIntStateOf(0) }
    val increment: () -> Unit = { count++ }
    PageBody {
        PageTitle("Taps")
        PageHint(
            "Each tap emits an `interaction` event. Compare the labels: a well-tagged button vs. " +
                "a bare one shows how much comes from accessibility hygiene.",
        )
        Card {
            Button(
                label = "Well-tagged button (tapped $count)",
                testId = "home-counter-button",
                a11yLabel = "Increment counter",
                hint = "Adds one to the counter",
                onClick = increment,
            )
            Button(label = "Bare button (no testID/label)", onClick = increment)
            Button(
                label = "Private action (masked)",
                testId = "home-private-button",
                a11yLabel = "Private action",
                onClick = increment,
                modifier = Modifier.groundcoverPrivate(),
            )
            Button(label = "Go to Detail screen", testId = "home-to-detail", onClick = onDetail)
            // Selected, expanded (a collapse action) and a state description, the Compose
            // counterparts of RN's accessibilityState / accessibilityValue. No label that
            // replaces the text: it has to stay findable by its text.
            Button(
                label = "A11y annotated button",
                testId = "home-a11y-button",
                onClick = increment,
                modifier =
                    Modifier.semantics {
                        selected = true
                        stateDescription = "forty two percent"
                        collapse { true }
                    },
            )
        }
        PageTitle("Typing")
        PageHint(
            "Editing a field emits ONE `input` interaction when you finish (focus moves away or " +
                "you submit), labelled from its label, never the text you typed.",
        )
        Card {
            Field(
                label = "Search field",
                testId = "home-text-input",
                placeholder = "Type here, then tap away…",
            )
        }
    }
}
