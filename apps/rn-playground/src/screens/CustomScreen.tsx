import * as React from "react";
import { Text } from "react-native";
import groundcover from "@groundcover/react-native";
import { Button, Card, Hint, Screen, Title } from "../ui";

export function CustomScreen() {
  const [sessionId, setSessionId] = React.useState<string>("—");

  return (
    <Screen>
      <Title>Custom & identity</Title>
      <Hint>
        Custom events and user identification. Then background the app (home button / app
        switcher): the SDK flushes buffered events and persists the activity clock.
      </Hint>
      <Card>
        <Button
          label="sendCustomEvent"
          testID="custom-send"
          onPress={() =>
            groundcover.sendCustomEvent({
              event: "checkout_completed",
              attributes: { total: 42, currency: "USD" },
            })
          }
        />
        <Button
          label="identifyUser"
          testID="custom-identify"
          onPress={() =>
            groundcover.identifyUser({
              id: "user-123",
              email: "demo@example.com",
              name: "Demo User",
            })
          }
        />
        <Button
          label="show session id"
          testID="custom-session"
          onPress={() => setSessionId(groundcover.getSessionId() || "(not ready)")}
        />
        <Text>Session: {sessionId}</Text>
      </Card>
    </Screen>
  );
}
