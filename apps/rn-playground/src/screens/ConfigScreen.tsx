import * as React from "react";
import { Text } from "react-native";
import groundcover from "@groundcover/react-native";
import { Button, Card, Hint, Screen, Title } from "../ui";
import {
  ACTIVE_PRESET,
  DROP_MARKER,
  backdateLastActivity,
  backdateSessionStart,
  clearSdkStorage,
} from "../config-presets";

// Everything the e2e suite needs that is neither a captured signal nor a
// gesture: which init-time config the app booted with, the public API methods no
// other screen exercises, and the two persisted-anchor hooks the session-rotation
// specs drive.
export function ConfigScreen() {
  const [sessionId, setSessionId] = React.useState<string>("—");
  const [done, setDone] = React.useState<string>("—");

  const mark = (what: string) => setDone(`${what}: done`);

  return (
    <Screen>
      <Title>Config & lifecycle</Title>
      {/*
        The spec GATE. A preset only takes effect once Metro has re-bundled the
        rewritten e2e-preset.ts and the app has relaunched onto it, and neither is
        instant — so every preset spec waits for this line to read back the preset
        it asked for instead of assuming the relaunch picked it up. Rendered as one
        string so an exact getByText matches.
      */}
      {/*
        NO accessibilityLabel here, deliberately. On iOS an a11y label REPLACES the
        visible text for queries, so labelling this node would make
        `getByText("preset: …")` unmatchable — and since that lookup is the gate
        activatePreset waits on, every preset-based spec would fail on iOS while
        passing on Android. (Same trap the interactions spec documents for the
        "Private action" button.)
      */}
      <Text>{`preset: ${ACTIVE_PRESET}`}</Text>
      {/*
        Status readouts live at the TOP, above every card, on purpose: `getByText`
        resolves only visible nodes, so at the foot of the screen, once a tap has
        scrolled to a control lower down, asserting on the status line fails on
        scroll position while the app is perfectly healthy. Keeping them above
        the fold makes every "did the action run?" assertion positional-independent.
      */}
      <Text>{`Session: ${sessionId}`}</Text>
      <Text>{`Last action: ${done}`}</Text>
      <Hint>
        The preset above is compiled in from src/e2e-preset.ts. Rewrite that file and
        relaunch to boot the SDK with a different init-time config.
      </Hint>

      <Card>
        {/*
          Its label carries the marker the `callbacks` preset's beforeSend drops
          on. A second, unmarked button is needed alongside it: "no event with
          this label arrived" is also satisfied by an SDK that stopped reporting
          altogether, so the drop is only meaningful next to a survivor.
        */}
        <Button
          label={`tap ${DROP_MARKER} (beforeSend drops this)`}
          testID="config-dropme"
          onPress={() => mark("dropme")}
        />
        <Button
          label="tap survivor (beforeSend keeps this)"
          testID="config-survivor"
          onPress={() => mark("survivor")}
        />
      </Card>

      <Title>Public API</Title>
      <Hint>
        Methods no other screen calls: the identity clear, session id read/write, the
        manual navigation API, TTI's manual mark, and turning navigation tracking off.
      </Hint>
      <Card>
        <Button
          label="show session id"
          testID="config-show-session"
          onPress={() => setSessionId(groundcover.getSessionId() || "(not ready)")}
        />
        <Button
          label="setSessionId fixed"
          testID="config-set-session"
          // A fixed, recognisable id so a spec can assert the SDK adopted THIS
          // one rather than merely rotating to some new value.
          onPress={() => {
            void groundcover.setSessionId("e2e-fixed-session-id").then(() => mark("setSessionId"));
          }}
        />
        <Button
          label="clear identity"
          testID="config-clear-user"
          // `user: null` is the documented way to clear — distinct from omitting
          // the key, which leaves the current identity in place.
          onPress={() => {
            groundcover.updateConfig({ user: null });
            mark("clearIdentity");
          }}
        />
        <Button
          label="manual navigation"
          testID="config-manual-nav"
          // `screen` is REQUIRED for this to emit anything: the tracker reads the
          // record's screen name from metadata.screen (or .name) and `emit` drops
          // any record with an empty name rather than shipping a screenless
          // navigation — see navigation-tracker's "never ship an empty-screen
          // record". Custom metadata alone produces nothing at all.
          onPress={() => {
            groundcover.startNavigation({ screen: "ManualScreen", key: "manual-1" });
            groundcover.endNavigation({ e2e_manual: "end" });
            mark("manualNav");
          }}
        />
        <Button
          label="manual navigation unnamed"
          testID="config-manual-nav-unnamed"
          // The documented anti-garbage rule: no screen name, no event.
          onPress={() => {
            groundcover.startNavigation({ e2e_manual: "nameless" });
            groundcover.endNavigation({ e2e_manual: "nameless" });
            mark("manualNavUnnamed");
          }}
        />
        <Button
          label="markAppInteractive"
          testID="config-mark-interactive"
          onPress={() => {
            groundcover.markAppInteractive();
            mark("markInteractive");
          }}
        />
        <Button
          label="stopNavigationTracking"
          testID="config-stop-nav-tracking"
          onPress={() => {
            groundcover.stopNavigationTracking();
            mark("stopNavTracking");
          }}
        />
      </Card>

      <Title>Session anchors (DEBUG)</Title>
      <Hint>
        Rotation reads the PERSISTED anchors at bootstrap, so backdating one and
        relaunching is the on-device stand-in for the browser suite's mocked clock —
        and it drives the same values a real launch would read. Relaunch after tapping.
      </Hint>
      <Card>
        <Button
          label="backdate activity 31m"
          testID="config-backdate-activity"
          onPress={() => {
            void backdateLastActivity().then(() => mark("backdateActivity"));
          }}
        />
        <Button
          label="backdate session start 5h"
          testID="config-backdate-start"
          onPress={() => {
            void backdateSessionStart().then(() => mark("backdateStart"));
          }}
        />
        <Button
          label="forget session"
          testID="config-forget-session"
          // Drops every persisted SDK key, so the next launch starts a session
          // that has never been confirmed — the only way to reach the
          // ghost-session gate on a device, where the session outlives the
          // process. Relaunch after tapping.
          onPress={() => {
            void clearSdkStorage().then(() => mark("forgetSession"));
          }}
        />
      </Card>

    </Screen>
  );
}
