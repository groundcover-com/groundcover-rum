import * as React from "react";
import { Pressable, Text, TextInput, View, ScrollView, StyleSheet } from "react-native";

export function Button({
  label,
  onPress,
  testID,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  accessibilityValue,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  // accessibilityState / accessibilityValue are captured on the interaction as
  // `interaction_target.state` / `.value`. They are NOT interchangeable under
  // masking: the state flags and the numeric value fields are structural and
  // always survive, while `value.text` is human-readable and is masked like a
  // label — which is the pair the a11y-metadata spec pins.
  //
  // Note `disabled` is deliberately not offered: RN's Pressable turns it into
  // accessibilityState.disabled AND blocks onPress, so a disabled control can
  // never produce the interaction whose state we would be asserting on.
  accessibilityState?: { selected?: boolean; checked?: boolean | "mixed"; busy?: boolean; expanded?: boolean };
  accessibilityValue?: { min?: number; max?: number; now?: number; text?: string };
  // Marks the interaction's label/hint/value as private. Accepted here (not
  // forwarded to the host Pressable) so it lives on this component's fiber props,
  // where the SDK's fiber walk detects it — the recommended wrapper-style usage.
  dataPrivate?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={accessibilityState}
      accessibilityValue={accessibilityValue}
      accessibilityRole="button"
      style={styles.button}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

// A labeled text field. Controlled locally so it behaves like a real form input
// (re-renders on every keystroke) — which is exactly what the SDK's TextInput
// patch has to survive. The SDK captures ONE `input` interaction when editing
// ends, never the typed text.
export function Field({
  testID,
  accessibilityLabel,
  placeholder,
}: {
  testID?: string;
  accessibilityLabel?: string;
  placeholder?: string;
}) {
  const [value, setValue] = React.useState("");
  return (
    <TextInput
      value={value}
      onChangeText={setValue}
      placeholder={placeholder}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      style={styles.input}
    />
  );
}

/**
 * @param scroll pass `false` when the screen contains its own scrollable. A
 *   VirtualizedList (FlatList) nested inside a same-orientation ScrollView is an
 *   error RN reports at runtime — `VirtualizedLists should never be nested inside
 *   plain ScrollViews with the same orientation` — and it leaves the gesture
 *   specs with two vertical scrollers competing for the same drag: which one
 *   claims it decides what the SDK ends up measuring.
 */
export function Screen({
  children,
  scroll = true,
}: {
  children: React.ReactNode;
  scroll?: boolean;
}) {
  if (!scroll) return <View style={styles.screen}>{children}</View>;
  return <ScrollView contentContainerStyle={styles.screen}>{children}</ScrollView>;
}

export function Title({ children }: { children: React.ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <Text style={styles.hint}>{children}</Text>;
}

export function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  title: { fontSize: 22, fontWeight: "500", marginBottom: 4 },
  hint: { fontSize: 14, color: "#666", marginBottom: 8 },
  card: { padding: 14, borderRadius: 12, backgroundColor: "#f2f2f7", gap: 10 },
  button: { padding: 14, borderRadius: 8, backgroundColor: "#0a84ff", alignItems: "center" },
  buttonText: { color: "white", fontSize: 16, fontWeight: "500" },
  input: {
    padding: 12,
    borderRadius: 8,
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#d1d1d6",
    fontSize: 16,
  },
});
