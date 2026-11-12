package com.groundcover.nativeplayground

// The playground's building blocks, the counterpart of apps/flutter-playground/lib/ui.dart and
// apps/rn-playground/src/ui.tsx.
//
// Named like RN's components and Flutter's widgets (Button, Card, HomeScreen), so the three apps
// read alike. The specs assert those names in a tap's `interaction_target.component` and
// component path on RN and Flutter only: Compose keeps no function names at runtime.
//
// Locator rules for the tree the harness reads (keep them when adding controls). Mobilewright's
// getByText matches a node's text, or its content description when it has no text; getByLabel
// matches the content description; getByTestId matches the resource id, which a testTag becomes
// (testTagsAsResourceId is on at the root, in MainActivity).
//   - A label that replaces the visible text (RN's accessibilityLabel, Flutter's semanticsLabel)
//     is clearAndSetSemantics: the node then carries the label and no text, so getByText finds it
//     by the label as on iOS. A Button with both would match getByText only by its text.
//   - Tabs: one node each, "<Name> tab", their visible text cleared from the tree.
//   - Text fields: locate by test ID.

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Button as MaterialButton

/**
 * A filled button. [a11yLabel] replaces [label] for queries and for TalkBack, like RN's
 * accessibilityLabel; [hint] is the click action's label, Android's nearest thing to RN's
 * accessibilityHint.
 */
@Composable
fun Button(
    label: String,
    onClick: () -> Unit,
    testId: String? = null,
    a11yLabel: String? = null,
    hint: String? = null,
    modifier: Modifier = Modifier,
) {
    var m = modifier.fillMaxWidth()
    if (testId != null) m = m.testTag(testId)
    m =
        if (a11yLabel != null) {
            m.clearAndSetSemantics {
                contentDescription = a11yLabel
                role = Role.Button
                onClick(label = hint) {
                    onClick()
                    true
                }
            }
        } else if (hint != null) {
            m.semantics {
                onClick(label = hint) {
                    onClick()
                    true
                }
            }
        } else {
            m
        }
    MaterialButton(onClick = onClick, modifier = m, contentPadding = PaddingValues(14.dp)) {
        Text(label)
    }
}

/**
 * A labelled text field. The SDK reports one `input` interaction when an edit ends, labelled
 * from [label], and never the typed text.
 */
@Composable
fun Field(
    label: String,
    testId: String,
    placeholder: String,
) {
    var value by remember { mutableStateOf("") }
    OutlinedTextField(
        value = value,
        onValueChange = { value = it },
        label = { Text(label) },
        placeholder = { Text(placeholder) },
        singleLine = true,
        // The label as the field's own accessibility label too, as RN's accessibilityLabel: the
        // floating label alone is a child node, which getByLabel doesn't read.
        modifier =
            Modifier
                .fillMaxWidth()
                .testTag(testId)
                .semantics { contentDescription = label },
    )
}

/** A scrolling page. Pass `scroll = false` when the screen has its own scrollable. */
@Composable
fun PageBody(
    scroll: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val base = Modifier.fillMaxWidth()
    Column(
        modifier =
            (if (scroll) base.verticalScroll(rememberScrollState()) else base).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

@Composable
fun PageTitle(text: String) {
    Text(text, fontSize = 22.sp, fontWeight = FontWeight.Medium)
}

@Composable
fun PageHint(text: String) {
    Text(text, fontSize = 14.sp, color = Color(0xFF666666))
}

@Composable
fun Card(content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier =
            Modifier
                .fillMaxWidth()
                .background(Color(0xFFF2F2F7), RoundedCornerShape(12.dp))
                .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        content = content,
    )
}
