import * as React from "react";
import { Button, Card, Hint, Screen, Title } from "../ui";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function DetailScreen({ navigation }: NativeStackScreenProps<any>) {
  return (
    <Screen>
      <Title>Detail</Title>
      <Hint>
        Navigating here should emit a `navigation` event and stamp the `screen` block — name
        "Detail" plus a per-instance key — on it and on every subsequent event.
      </Hint>
      <Card>
        <Button label="Back" testID="detail-back" onPress={() => navigation.goBack()} />
      </Card>
    </Screen>
  );
}
