package com.groundcover.rum.core.pipeline

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.PrivacyLevel
import com.groundcover.rum.PrivacyOptions
import com.groundcover.rum.RumEventName
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.core.events.CustomEventCapture
import com.groundcover.rum.core.events.GestureDirection
import com.groundcover.rum.core.events.GestureMeasure
import com.groundcover.rum.core.events.InteractionCapture
import com.groundcover.rum.core.events.InteractionKind
import com.groundcover.rum.core.events.InteractionTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// Interaction events, mirroring the Dart pipeline's interaction group. Robolectric for org.json,
// which encodes each batch.

private val noBatching = GroundcoverOptions(
    transport = TransportOptions(batchSize = 0, compression = false)
)

private fun startedWith(
    options: GroundcoverOptions = noBatching
): Pair<CorePipeline, FakePlatform> {
    val platform = FakePlatform()
    val pipeline = CorePipeline()
    pipeline.start(
        GroundcoverConfig(
            apiKey = "k",
            dsn = "ingest.example",
            cluster = "c",
            environment = "e",
            appId = "a",
            options = options
        ),
        platform.services
    )
    return pipeline to platform
}

@RunWith(RobolectricTestRunner::class)
class InteractionEventTest {
    private val target = InteractionTarget(
        component = "Button",
        label = "Pay now",
        role = "button",
        hint = "Charges the card",
        state = mapOf("selected" to true),
        valueText = "forty two percent",
        componentPath = "DecorView > LinearLayout > Button"
    )

    private fun shipped(
        capture: InteractionCapture,
        options: GroundcoverOptions = noBatching
    ): Map<*, *> {
        val (pipeline, platform) = startedWith(options)
        pipeline.presence()
        pipeline.submit(capture)
        // An interaction never triggers a size flush; it rides with the next event.
        pipeline.submit(CustomEventCapture("flush", emptyMap()))
        return platform.requests.first().events.first()["attributes"] as Map<*, *>
    }

    @Test
    fun aTapCarriesItsCoordinatesTheTargetAndThePathFlattened() {
        val attributes =
            shipped(InteractionCapture(InteractionKind.TAP, target, x = 12.0, y = 34.0))
        assertEquals(
            mapOf(
                "interaction_type" to "tap",
                // The wire has one number type: 12.0 is written, and read back, as 12.
                "interaction_coordinates.x" to 12,
                "interaction_coordinates.y" to 34,
                "interaction_target.component" to "Button",
                "interaction_target.label" to "Pay now",
                "interaction_target.role" to "button",
                "interaction_target.hint" to "Charges the card",
                "interaction_target.state.selected" to true,
                "interaction_target.value.text" to "forty two percent",
                "interaction_component_path" to "DecorView > LinearLayout > Button",
                "screen" to mapOf("name" to "", "key" to "")
            ),
            attributes
        )
    }

    @Test
    fun aGestureAddsItsMeasureFromNativeAndAnInputHasNoCoordinates() {
        val swipe = shipped(
            InteractionCapture(
                InteractionKind.SWIPE,
                target,
                x = 1.0,
                y = 2.0,
                gesture = GestureMeasure(
                    direction = GestureDirection.UP,
                    distanceDp = 120,
                    velocityDpS = 900,
                    durationMs = 130,
                    pointerCount = 1
                )
            )
        )
        assertEquals("swipe", swipe["interaction_type"])
        assertEquals("up", swipe["interaction_gesture.direction"])
        assertEquals(120, swipe["interaction_gesture.distance_dp"])
        assertEquals(900, swipe["interaction_gesture.velocity_dp_s"])
        assertEquals(130, swipe["interaction_gesture.duration_ms"])
        assertEquals(1, swipe["interaction_gesture.pointer_count"])
        assertEquals("native", swipe["interaction_gesture.capture_source"])
        assertFalse(swipe.containsKey("interaction_gesture.partial"))

        val pinch = shipped(
            InteractionCapture(
                InteractionKind.PINCH,
                target,
                x = 1.0,
                y = 2.0,
                gesture = GestureMeasure(
                    distanceDp = 40,
                    velocityDpS = 100,
                    durationMs = 400,
                    pointerCount = 2,
                    partial = true
                )
            )
        )
        assertFalse(pinch.containsKey("interaction_gesture.direction"))
        assertEquals(true, pinch["interaction_gesture.partial"])

        val input = shipped(InteractionCapture(InteractionKind.INPUT, target))
        assertEquals("input", input["interaction_type"])
        assertFalse(input.keys.any { (it as String).startsWith("interaction_coordinates") })
        assertFalse(input.keys.any { (it as String).startsWith("interaction_gesture") })
    }

    @Test
    fun aPrivateTargetMasksLabelHintAndValueTextAndKeepsTheStructure() {
        val attributes = shipped(
            InteractionCapture(
                InteractionKind.TAP,
                InteractionTarget(
                    component = "Button",
                    label = "Private action",
                    role = "button",
                    hint = "secret hint",
                    state = mapOf("selected" to true),
                    valueText = "secret",
                    componentPath = "DecorView > Button",
                    masked = true
                ),
                x = 0.0,
                y = 0.0
            )
        )
        assertEquals("***", attributes["interaction_target.label"])
        assertEquals("***", attributes["interaction_target.hint"])
        assertEquals("***", attributes["interaction_target.value.text"])
        assertEquals(true, attributes["interaction_target.state.selected"])
        assertEquals("button", attributes["interaction_target.role"])
        assertEquals("Button", attributes["interaction_target.component"])
        assertEquals("DecorView > Button", attributes["interaction_component_path"])
    }

    @Test
    fun anEmptyHintStaysEmptyWhenMasked() {
        val attributes = shipped(
            InteractionCapture(
                InteractionKind.TAP,
                InteractionTarget(label = "Private action", role = "button", masked = true),
                x = 0.0,
                y = 0.0
            )
        )
        assertEquals("", attributes["interaction_target.hint"])
        assertNull(attributes["interaction_target.value.text"])
        assertFalse(attributes.keys.any { (it as String).startsWith("interaction_target.state") })
    }

    @Test
    fun maskAllMasksEveryLabelAndTheDefaultLevelMasksNone() {
        val masked = shipped(
            InteractionCapture(InteractionKind.TAP, target, x = 0.0, y = 0.0),
            GroundcoverOptions(
                privacy = PrivacyOptions(level = PrivacyLevel.MASK_ALL),
                transport = TransportOptions(batchSize = 0, compression = false)
            )
        )
        assertEquals("***", masked["interaction_target.label"])
        assertEquals("***", masked["interaction_target.value.text"])
        val plain = shipped(InteractionCapture(InteractionKind.TAP, target, x = 0.0, y = 0.0))
        assertEquals("Pay now", plain["interaction_target.label"])
    }

    @Test
    fun anInteractionConfirmsTheSessionLikeAPresenceSignal() {
        val (pipeline, platform) = startedWith()
        pipeline.submit(InteractionCapture(InteractionKind.TAP, target, x = 0.0, y = 0.0))
        pipeline.submit(CustomEventCapture("after", emptyMap()))
        assertEquals(listOf("interaction", "custom"), platform.types)
    }

    @Test
    fun enabledEventsWithoutInteractionDropsThem() {
        val (pipeline, platform) = startedWith(
            GroundcoverOptions(
                enabledEvents = listOf(RumEventName.LOGS),
                transport = TransportOptions(batchSize = 0, compression = false)
            )
        )
        pipeline.presence()
        pipeline.submit(InteractionCapture(InteractionKind.TAP, target))
        pipeline.submit(CustomEventCapture("c", emptyMap()))
        assertEquals(listOf("custom"), platform.types)
    }
}
