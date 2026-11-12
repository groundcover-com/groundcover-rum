import * as React from "react";
import { FlatList, Modal, NativeModules, Text, View, StyleSheet } from "react-native";
import { Button, Card, Hint, Screen, Title } from "../ui";

// The native module, reached directly rather than through the SDK: these are
// DEBUG-only triggers for driving the e2e suite, not part of the public API.
const nativeModule = (NativeModules as Record<string, unknown>)?.GroundcoverRum as
  | {
      triggerTestCrash?: (kind: string) => void;
      blockMainThread?: (ms: number) => void;
    }
  | undefined;

/**
 * How long "Block main thread" blocks for. The hang specs assert against this number — both that a
 * stall this long is reported at all, and that the reported duration is not SHORT of it — so it is
 * named rather than inlined. Chosen against the `hang-sampling` preset's 2s threshold: see the
 * detection-probability note there before changing either.
 */
export const HANG_STALL_MS = 3_000;

/**
 * A NAMED component rather than a bare <Text>, because the fiber walk names the nearest
 * ancestor that is not host noise — above a bare row that is a FlatList internal, which tells a
 * product engineer nothing. The prop is deliberately not `accessibilityLabel`, so the
 * JS-classified path still resolves the row's visible text.
 */
function ScrollRow({ label }: { label: string }) {
  return <Text style={styles.row}>{label}</Text>;
}

/**
 * A scrollable list inside a React Native `Modal`.
 *
 * The modal is the point, not the list. RN renders a `Modal` into a SEPARATE native surface — its
 * own `UIWindow` on iOS, a `Dialog` (and so a second `Window`) on Android — which is exactly the
 * case a tracker that hooks one surface per app cannot see. The list gives the spec something to
 * drag inside it.
 *
 * Rows are labelled distinctly from the main screen's so a spec can tell which list a reported
 * gesture came from.
 */
function ModalList({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible} animationType="none" onRequestClose={onClose} transparent={false}>
      <View style={styles.modal}>
        <Title>Modal list</Title>
        <Button accessibilityLabel="Close modal" label="Close modal" onPress={onClose} />
        <View style={styles.list}>
          <FlatList
            testID="modal-scroll-list"
            accessibilityLabel="Modal scrollable list"
            data={Array.from({ length: 60 }, (_, i) => `Modal row ${i + 1}`)}
            keyExtractor={(item) => item}
            renderItem={({ item }) => <ScrollRow label={item} />}
          />
        </View>
      </View>
    </Modal>
  );
}

/**
 * Drives the native signals from the UI.
 *
 * In Expo Go there is no native module at all, so every button here reports
 * that rather than silently doing nothing — that IS the degradation the SDK
 * promises, and it should be visible.
 */
export function NativeScreen() {
  const [note, setNote] = React.useState("");
  const [modalOpen, setModalOpen] = React.useState(false);

  const run = (label: string, action?: () => void) => () => {
    if (!action) {
      setNote(`${label}: no native module (Expo Go — use a dev build)`);
      return;
    }
    setNote(`${label}: triggered`);
    action();
  };

  // `scroll={false}`: this screen owns a FlatList, and nesting one inside the
  // default ScrollView is an RN runtime error that leaves the gesture specs two
  // scrollers competing for a drag. The content fits a phone screen without
  // scrolling, so the outer scroller has nothing to add here — and its absence
  // leaves exactly one scrollable to claim a drag.
  return (
    <Screen scroll={false}>
      <Title>Native signals</Title>
      <Hint>
        Crashes, hangs, app start and frame vitals come from the native module, so these need a dev
        build (`expo run:ios` / `expo run:android`), not Expo Go. A crash is reported on the NEXT
        launch, under the session it happened in.
      </Hint>

      <Card>
        <Button
          label="Crash natively"
          testID="native-crash"
          accessibilityLabel="Crash natively"
          onPress={run("crash", nativeModule?.triggerTestCrash?.bind(null, "native"))}
        />
        <Button
          label="Block main thread"
          testID="native-hang"
          accessibilityLabel="Block main thread"
          onPress={run("hang", nativeModule?.blockMainThread?.bind(null, HANG_STALL_MS))}
        />
        <Text>{note}</Text>
      </Card>

      <Hint>
        Scroll this list to exercise gesture capture: JavaScript classifies the swipe, and on a dev
        build the native tracker measures how far and how fast it actually went.
      </Hint>
      <Button
        accessibilityLabel="Open modal"
        label="Open modal"
        onPress={() => setModalOpen(true)}
      />
      <ModalList visible={modalOpen} onClose={() => setModalOpen(false)} />
      <View style={styles.list}>
        <FlatList
          testID="native-scroll-list"
          accessibilityLabel="Scrollable list"
          data={Array.from({ length: 60 }, (_, i) => `Row ${i + 1}`)}
          keyExtractor={(item) => item}
          renderItem={({ item }) => <ScrollRow label={item} />}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { height: 220 },
  row: { paddingVertical: 12, fontSize: 16 },
  modal: { flex: 1, padding: 16, gap: 12 },
});
