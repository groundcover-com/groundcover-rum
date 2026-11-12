import { describe, it, expect, vi, afterEach } from "vitest";
import * as core from "@groundcover/rum-core";
import { __internals } from "./GroundcoverProvider";
import {
  clearTouchHistory,
  getTouchHistory,
  setTouchHandlers,
  type RawGesture,
} from "../internal/touch-bridge";

// A malformed synthetic event whose `nativeEvent` access throws. RN's touch
// dispatch calls our handlers directly, so a throw here would break the host
// app's touch handling on the SDK's hottest path — it must degrade silently.
function hostileEvent(): { nativeEvent?: { pageX?: number; pageY?: number } } {
  const e = {};
  Object.defineProperty(e, "nativeEvent", {
    get() {
      throw new Error("hostile nativeEvent");
    },
  });
  return e;
}

/** The holder the handlers thread state through, opaque to the test. */
type Holder = Parameters<typeof __internals.onTouchEnd>[1];
const holder = (): Holder => ({ current: null }) as Holder;

const at = (pageX: number, pageY: number, touches = 1) => ({
  nativeEvent: { pageX, pageY, touches: new Array(touches).fill({}) },
});

describe("GroundcoverProvider touch handlers", () => {
  afterEach(() => {
    setTouchHandlers({ onPresence: null, onInteraction: null });
    clearTouchHistory();
    vi.restoreAllMocks();
  });

  it("never throws into the host, even on a malformed event", () => {
    const h = holder();
    expect(() => __internals.onTouchStart(hostileEvent(), h)).not.toThrow();
    expect(() => __internals.onTouchMove(hostileEvent(), h)).not.toThrow();
    expect(() => __internals.onTouchEnd(hostileEvent(), h)).not.toThrow();
    expect(() => __internals.onTouchCancel(hostileEvent(), h)).not.toThrow();
  });

  it("clears stale start state when touch start fails — no false tap from a prior gesture", () => {
    const taps: unknown[] = [];
    setTouchHandlers({ onPresence: vi.fn(), onInteraction: (i) => taps.push(i) });

    const h = holder();
    __internals.onTouchStart(at(5, 5), h);
    // The next touch's START throws before it can record a new origin.
    __internals.onTouchStart(hostileEvent(), h);

    // A well-formed END at that same spot must therefore NOT be a tap: there is
    // no valid start to measure it against.
    __internals.onTouchEnd(at(5, 5), h);
    expect(taps).toHaveLength(0);
  });

  it("reports presence on touch start and a classified tap on touch end", () => {
    const presence = vi.fn();
    const taps: unknown[] = [];
    setTouchHandlers({ onPresence: presence, onInteraction: (i) => taps.push(i) });

    const h = holder();
    __internals.onTouchStart(at(10, 10), h);
    __internals.onTouchEnd(at(10, 10), h);

    expect(presence).toHaveBeenCalledTimes(1);
    expect(taps).toHaveLength(1);
  });

  it("reports a drag as a swipe rather than discarding it", () => {
    const gestures: RawGesture[] = [];
    const taps: unknown[] = [];
    setTouchHandlers({
      onPresence: vi.fn(),
      // One stream: a tap is a RawGesture with kind "tap", so the test splits by kind
      // rather than by which callback fired.
      onInteraction: (i) => (i.kind === "tap" ? taps : gestures).push(i),
    });

    // swipe-vs-scroll is decided by RELEASE velocity, so the handlers have to be
    // driven against a clock: called back to back they all land in the same
    // millisecond, a zero-length release window, which is a scroll by definition
    // and says nothing about the drag under test.
    //
    // Several move samples too, as a real stream delivers every frame — the
    // release window spans the last two, so a single-move drag would be measured
    // over its whole length instead (the documented degenerate case).
    const clock = vi.spyOn(Date, "now");
    const h = holder();
    clock.mockReturnValue(1_000);
    __internals.onTouchStart(at(300, 400), h);
    clock.mockReturnValue(1_030);
    __internals.onTouchMove(at(240, 402), h);
    clock.mockReturnValue(1_060);
    __internals.onTouchMove(at(170, 405), h);
    clock.mockReturnValue(1_090);
    __internals.onTouchEnd(at(100, 410), h);

    expect(taps).toHaveLength(0);
    expect(gestures).toHaveLength(1);
    expect(gestures[0]).toMatchObject({ kind: "swipe", direction: "left" });
    // The START point identifies the element the user grabbed.
    expect(gestures[0]).toMatchObject({ x: 300, y: 400 });
  });

  it("reports a drag brought to rest as a scroll, not a swipe", () => {
    // The same travel as above, but the finger had all but stopped before
    // lifting: 2dp over the final 50ms. Both native trackers call that a scroll,
    // and this side must not call it a swipe merely because the stream completed.
    const gestures: RawGesture[] = [];
    setTouchHandlers({ onPresence: vi.fn(), onInteraction: (i) => gestures.push(i) });

    const clock = vi.spyOn(Date, "now");
    const h = holder();
    clock.mockReturnValue(1_000);
    __internals.onTouchStart(at(300, 400), h);
    clock.mockReturnValue(1_200);
    __internals.onTouchMove(at(150, 400), h);   // fast at first
    clock.mockReturnValue(1_400);
    __internals.onTouchMove(at(110, 400), h);   // slowing
    clock.mockReturnValue(1_500);
    __internals.onTouchMove(at(102, 400), h);   // nearly stopped
    clock.mockReturnValue(1_600);
    __internals.onTouchEnd(at(100, 400), h);

    expect(gestures).toHaveLength(1);
    expect(gestures[0]).toMatchObject({ kind: "scroll", direction: "left" });
    // Still 200dp of real travel — the distance is not what demoted it.
    expect(gestures[0]).toMatchObject({ distanceDp: 200 });
  });

  it("reports a cancelled drag as a scroll — Android's stream just stops", () => {
    // Without handling cancel, a ScrollView taking the gesture over would make
    // the scroll invisible: no end event ever arrives.
    const gestures: RawGesture[] = [];
    setTouchHandlers({ onPresence: vi.fn(), onInteraction: (i) => gestures.push(i) });

    const h = holder();
    __internals.onTouchStart(at(200, 600), h);
    __internals.onTouchMove(at(200, 540), h);
    __internals.onTouchCancel(at(200, 520), h);

    expect(gestures[0]).toMatchObject({ kind: "scroll", direction: "up", partial: true });
  });

  it("tracks the highest pointer count so a two-finger gesture is a pinch", () => {
    const gestures: RawGesture[] = [];
    setTouchHandlers({ onPresence: vi.fn(), onInteraction: (i) => gestures.push(i) });

    const h = holder();
    __internals.onTouchStart(at(200, 300, 1), h);
    __internals.onTouchMove(at(220, 320, 2), h); // second finger lands mid-gesture
    __internals.onTouchEnd(at(260, 360, 1), h);

    expect(gestures[0]).toMatchObject({ kind: "pinch", pointerCount: 2 });
  });

  it("measures a real-device pinch from the first finger, not the second finger's touch-down", () => {
    // On a device each finger fires its OWN onTouchStart — RN dispatches a start
    // per touch — unlike the move-driven test above. The gesture's origin, target
    // and metrics belong to the first finger; a second finger landing must add a
    // pointer, not restart the gesture against its own coordinates.
    const gestures: RawGesture[] = [];
    setTouchHandlers({ onPresence: vi.fn(), onInteraction: (i) => gestures.push(i) });

    const clock = vi.spyOn(Date, "now");
    const h = holder();
    clock.mockReturnValue(1_000);
    __internals.onTouchStart(at(300, 400, 1), h); // finger one
    clock.mockReturnValue(1_020);
    __internals.onTouchStart(at(120, 120, 2), h); // finger two lands, its own touch-start
    clock.mockReturnValue(1_050);
    __internals.onTouchMove(at(305, 405, 2), h);
    clock.mockReturnValue(1_080);
    __internals.onTouchEnd(at(310, 410, 1), h);

    expect(gestures).toHaveLength(1);
    expect(gestures[0]).toMatchObject({ kind: "pinch", pointerCount: 2 });
    // The origin is finger one's (300,400), NOT finger two's (120,120).
    expect(gestures[0]).toMatchObject({ x: 300, y: 400 });
    // And the gesture recorded ONE touch start, not one per finger.
    expect(getTouchHistory()).toHaveLength(1);
  });

  it("records each touch start with its target already resolved off the fiber", () => {
    // Resolution has to be eager: a native gesture referring back to this touch
    // can arrive seconds later, when the fiber may be unmounted — and holding
    // fibers would pin whole subtrees against GC. A FiberWalkResult is plain
    // strings and small objects, so keeping the whole walk retains nothing.
    setTouchHandlers({ onPresence: vi.fn(), onInteraction: null });

    __internals.onTouchStart(at(11, 22), holder());

    const [record] = getTouchHistory();
    expect(record).toMatchObject({ x: 11, y: 22 });
    expect(record).not.toHaveProperty("fiber");
    // The walk's own fields, not a pre-collapsed display string.
    expect(record!.target).toMatchObject({
      component: expect.any(String),
      label: expect.any(String),
      componentPath: expect.any(String),
      masked: expect.any(Boolean),
    });
  });

  it("keeps component and label separate, and carries the dataPrivate bit", () => {
    // Collapsing to `walk.component || walk.label` would cost two things the
    // gesture path cannot recover: `masked` would be dropped entirely, so a
    // dataPrivate element's opt-out would never reach the event builder; and on
    // a bare host node the LABEL would land in the slot the builder treats as a
    // never-masked component name. Both fields travel separately.
    setTouchHandlers({ onPresence: vi.fn(), onInteraction: null });

    const hostNode = {
      return: null,
      type: "Text", // HOST_NOISE — yields no component name
      elementType: { name: "Text" },
      memoizedProps: { dataPrivate: true, accessibilityLabel: "Add to cart" },
    };

    // `_targetInst` is the Paper/React-19 fiber carrier resolveFiber() reads off
    // the synthetic event; TouchLike only declares the fields the handler itself
    // touches, so hand it in as the untyped synthetic event it stands for.
    __internals.onTouchStart(
      { ...at(11, 22), _targetInst: hostNode } as unknown as Parameters<
        typeof __internals.onTouchStart
      >[0],
      holder()
    );

    const [record] = getTouchHistory();
    expect(record!.target.label).toBe("Add to cart");
    expect(record!.target.component).toBe("");
    expect(record!.target.masked).toBe(true);
  });

  // Complements the malformed-event case above, which makes only the TRY block throw while
  // `handleError` still returns normally: here the error reporter itself throws too, because the
  // host's configured logger is broken.
  //
  // Every one of these handlers is called straight from React Native's responder dispatch, so an
  // escape does not lose a log line — it breaks touch handling for the host app, on the SDK's
  // hottest path, and only for customers whose logger is already misbehaving.
  it("never throws into the host even when the error reporter ITSELF throws", () => {
    vi.spyOn(core, "handleError").mockImplementation(() => {
      throw new Error("broken host logger");
    });

    // start: reaches the catch via the hostile getter, with no in-flight touch needed.
    expect(() => __internals.onTouchStart(hostileEvent(), holder())).not.toThrow();

    // move / end / cancel only reach their catch with a touch already in flight, so each gets a
    // real start first and a hostile event second.
    for (const handler of [
      __internals.onTouchMove,
      __internals.onTouchEnd,
      __internals.onTouchCancel,
    ]) {
      const h = holder();
      __internals.onTouchStart(at(10, 20), h);
      expect(() => handler(hostileEvent(), h)).not.toThrow();
    }
  });

  it("keeps the touch history bounded", () => {
    setTouchHandlers({ onPresence: vi.fn(), onInteraction: null });

    for (let i = 0; i < 12; i++) {
      __internals.onTouchStart(at(i, i), holder());
    }

    expect(getTouchHistory().length).toBeLessThanOrEqual(5);
    // The most recent touch is the one a just-finished gesture would match.
    expect(getTouchHistory().at(-1)).toMatchObject({ x: 11, y: 11 });
  });
});
