import {
  BaseListener,
  handleError,
  type EnrichedEvent,
  type CoreEventType,
} from "@groundcover/rum-core";
import type { InteractionEventAttributes, RNExtraEventType } from "../rn-event-types";
import { resolveRNPrivacy } from "../../privacy/rn-privacy";
import type { RawGesture, RawInput } from "../../internal/touch-bridge";
import { walkFiber, type FiberWalkResult } from "../../react/fiber-walk";

type InteractionTarget = InteractionEventAttributes["interaction_target"];

// Placeholder for a masked tap label. Distinct from core's "[REDACTED]" (used
// for structured field redaction) — this is the short UI-text mask, matching
// the browser DOM listener's masked-text convention.
const MASKED_LABEL = "***";

// Turns a classified interaction into an `interaction` event and masks its target per privacy.
// Presence is stamped upstream (RNInstrumentationManager), independently of event capture.
//
// ONE handler and ONE builder for every source — the JS touch boundary and the native gesture
// tracker alike, so the build-failure guard is the same for every source and the gesture block's
// `capture_source` is decided by the payload rather than by which method the caller reached.
export class InteractionListener extends BaseListener<RNExtraEventType> {
  /**
   * A classified interaction from any source — the one interaction path.
   *
   * Named for the base class's abstract entry rather than `handleInteraction`, matching every
   * sibling listener: the unqualified pair is the listener's primary signal, and the secondary
   * one carries the qualifier ([handleInputEvent]).
   */
  handleEvent(interaction: RawGesture): void {
    try {
      this.queueEvent(this.buildEvent(interaction));
    } catch (error) {
      handleError(error);
    }
  }

  // A finished text-field edit (from the internal TextInput patch). Same shape as
  // a tap but interaction_type: "input" and no coordinates/touch type. The typed
  // value is never captured — only that the field was edited and its identity.
  handleInputEvent(input: RawInput): void {
    try {
      this.queueEvent(this.buildInputEvent(input));
    } catch (error) {
      handleError(error);
    }
  }

  // Walk-then-mask, for the one path that still arrives holding a fiber: a text edit, whose
  // field is walked here at blur. Interactions carry their walk already done (at touch-down),
  // so they go straight to [maskTarget] — this listener never walks a touch's fiber.
  private buildTarget(fiber: unknown): {
    target: InteractionTarget;
    componentPath: string;
  } {
    return this.maskTarget(walkFiber(fiber));
  }

  /**
   * The masking half of [buildTarget], over a walk somebody else performed — the single place
   * that decides what a masked target looks like, so the shape can never drift between an
   * interaction and an input.
   *
   * Interactions cannot walk here: the fiber was walked at touch-down and, for a native
   * gesture arriving seconds later, is long gone. They carry the whole walk instead, which is
   * also what keeps `masked` (the per-element dataPrivate opt-out) reachable.
   */
  private maskTarget(walk: FiberWalkResult): {
    target: InteractionTarget;
    componentPath: string;
  } {
    // Global masking (privacy level / maskInteractionLabels) OR a per-element
    // dataPrivate opt-out detected on the tapped node or an ancestor.
    const mask = this.shouldMaskLabels() || walk.masked;
    const label = mask ? MASKED_LABEL : walk.label;
    const hint = mask && walk.hint ? MASKED_LABEL : walk.hint;
    const value =
      walk.value && mask && typeof walk.value.text === "string"
        ? { ...walk.value, text: MASKED_LABEL }
        : walk.value;

    const target: InteractionTarget = {
      component: walk.component,
      label,
      role: walk.role,
      hint,
      ...(walk.state ? { state: walk.state } : {}),
      ...(value ? { value } : {}),
    };
    return { target, componentPath: walk.componentPath };
  }

  // No span_name on any of these: the browser sets one only for network events
  // (its dom.event and exception listeners build attributes alone), and an
  // interaction's identity is already in interaction_type + target.label.

  buildInputEvent(input: RawInput): EnrichedEvent<CoreEventType | RNExtraEventType> {
    const { target, componentPath } = this.buildTarget(input.fiber);
    return this.enricher.enrich<"interaction">({
      type: "interaction",
      attributes: {
        interaction_type: "input",
        interaction_target: target,
        interaction_component_path: componentPath,
      },
    });
  }

  buildEvent(interaction: RawGesture): EnrichedEvent<CoreEventType | RNExtraEventType> {
    // Masked through the SAME path an input takes. Rolling the target by hand for one source
    // can leave `component` holding label text while `label` beside it is masked, or a
    // `dataPrivate` element's opt-out unhonoured on the native gesture path.
    const { target, componentPath } = this.maskTarget(interaction.target);

    return this.enricher.enrich<"interaction">({
      type: "interaction",
      attributes: {
        interaction_type: interaction.kind,
        // A tap's lift point, a gesture's start point — chosen by the producer, which is the
        // only side that knows both ends of the touch.
        interaction_coordinates: { x: interaction.x, y: interaction.y },
        interaction_target: target,
        interaction_component_path: componentPath,
        // A tap has no kinematics: the classifier's defaults are not measurements, and shipping
        // them would invent a 0dp gesture for every tap in the product.
        ...(interaction.kind === "tap"
          ? {}
          : {
              interaction_gesture: {
                ...(interaction.direction ? { direction: interaction.direction } : {}),
                distance_dp: interaction.distanceDp,
                velocity_dp_s: interaction.velocityDpS,
                duration_ms: interaction.durationMs,
                pointer_count: interaction.pointerCount,
                ...(interaction.partial ? { partial: true } : {}),
                capture_source: interaction.captureSource,
              },
            }),
      },
    });
  }

  queueEvent(event: EnrichedEvent<CoreEventType | RNExtraEventType>): void {
    this.eventsPool.addEvent(event);
  }

  initialize(): void {}
  destroy(): void {}

  // Human-readable fields (label, hint, value.text) are masked when the privacy
  // level is 'mask-all', or when the RN-specific maskInteractionLabels flag is
  // set. role / component / state / numeric value are structural, never masked.
  private shouldMaskLabels(): boolean {
    return resolveRNPrivacy(this.config).maskInteractionLabels;
  }
}
