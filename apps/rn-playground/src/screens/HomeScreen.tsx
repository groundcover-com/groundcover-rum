import * as React from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Button, Card, Field, Hint, Screen, Title } from "../ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function HomeScreen({ navigation }: NativeStackScreenProps<any>) {
  const [count, setCount] = React.useState(0);
  return (
    <Screen>
      <Title>Taps</Title>
      <Hint>
        Each tap emits an `interaction` event. Compare the labels: a well-tagged button
        vs. a bare one shows how much comes from testID / accessibilityLabel hygiene.
      </Hint>
      <Card>
        <Button
          label={`Well-tagged button (tapped ${count})`}
          testID="home-counter-button"
          accessibilityLabel="Increment counter"
          accessibilityHint="Adds one to the counter"
          onPress={() => setCount((c) => c + 1)}
        />
        <Button label="Bare button (no testID/label)" onPress={() => setCount((c) => c + 1)} />
        <Button
          label="Private action (masked)"
          testID="home-private-button"
          accessibilityLabel="Private action"
          dataPrivate
          onPress={() => setCount((c) => c + 1)}
        />
        <Button
          label="Go to Detail screen"
          testID="home-to-detail"
          onPress={() => navigation.navigate("Detail")}
        />
        {/*
          Carries accessibilityState + accessibilityValue, which the SDK captures
          as interaction_target.state / .value. Deliberately has NO
          accessibilityLabel: on iOS an a11y label replaces the visible text for
          queries, and this control has to stay findable by its text while its
          captured label comes from that same text.
        */}
        <Button
          label="A11y annotated button"
          testID="home-a11y-button"
          accessibilityState={{ selected: true, expanded: true }}
          accessibilityValue={{ min: 0, max: 100, now: 42, text: "forty two percent" }}
          onPress={() => setCount((c) => c + 1)}
        />
      </Card>

      <Title>Typing</Title>
      <Hint>
        Editing a field emits ONE `input` interaction when you finish (blur / submit) —
        labeled from its accessibilityLabel, never the text you typed.
      </Hint>
      <Card>
        <Field
          testID="home-text-input"
          accessibilityLabel="Search field"
          placeholder="Type here, then tap away…"
        />
      </Card>
    </Screen>
  );
}
