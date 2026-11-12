import * as React from "react";
import groundcover from "@groundcover/react-native";
import { Button, Card, Hint, Screen, Title } from "../ui";

export function LogsScreen() {
  return (
    <Screen>
      <Title>Logs</Title>
      <Hint>
        Both captured `console.*` and the explicit `groundcover.logger.*` API emit `log`
        events through the same redaction contract.
      </Hint>
      <Card>
        <Button
          label="console.log"
          testID="logs-console-log"
          onPress={() => console.log("playground console.log", { screen: "Logs" })}
        />
        <Button
          label="console.error"
          testID="logs-console-error"
          onPress={() => console.error("playground console.error", new Error("boom"))}
        />
        <Button
          label="logger.info"
          testID="logs-logger-info"
          onPress={() => groundcover.logger.info("explicit logger.info", { via: "api" })}
        />
        <Button
          label="logger.warn"
          testID="logs-logger-warn"
          onPress={() => groundcover.logger.warn("explicit logger.warn")}
        />
      </Card>

      <Title>Errors</Title>
      <Hint>
        A manually reported error via `groundcover.captureException` (handled), and an
        uncaught async throw that the SDK catches via the global `ErrorUtils` handler
        (unhandled) — both emit an `exception` event; the SDK re-raises so the app's own
        crash handling is untouched.
      </Hint>
      <Card>
        <Button
          label="captureException"
          testID="errors-capture"
          onPress={() =>
            groundcover.captureException(new Error("handled e2e error"), { screen: "Logs" })
          }
        />
        <Button
          label="throw uncaught"
          testID="errors-uncaught"
          // Throw asynchronously so the runtime routes it to ErrorUtils' global
          // handler (a non-fatal uncaught error) rather than a synchronous
          // onPress throw React might intercept.
          onPress={() => {
            setTimeout(() => {
              throw new Error("uncaught e2e error");
            }, 0);
          }}
        />
        <Button
          label="unhandled rejection"
          testID="errors-rejection"
          // A promise that rejects with no catch → the engine's rejection tracker
          // (Hermes on the sim) reports it and the SDK captures it as an unhandled
          // exception. A distinct code path from both the ErrorUtils handler and
          // captureException.
          onPress={() => {
            Promise.reject(new Error("unhandled rejection e2e error"));
          }}
        />
      </Card>

      <Title>Privacy fixtures</Title>
      <Hint>
        Sensitive payloads for the privacy matrix. Deliberately LAST on the screen:
        inserting controls above the cards ahead of this one shifts them down, and the
        specs that tap those controls do not scroll. Append here; never insert above.
      </Hint>
      <Card>
        <Button
          label="log sensitive"
          testID="logs-sensitive"
          // Secrets in BOTH halves of a log event — the free-text message and the
          // structured attributes — because they go through different redaction
          // paths (redactText's key=value scrub vs redactObject's key walk), plus
          // `order_id`/`email`, which the built-in rules leave alone and the
          // custom-redact preset then claims.
          onPress={() =>
            groundcover.logger.info("user login password=e2e-log-password", {
              api_key: "e2e-log-apikey",
              order_id: "A-1",
              email: "demo@example.com",
            })
          }
        />
        <Button
          label="capture sensitive error"
          testID="errors-sensitive"
          // The error surface has its own mask flag (shouldMaskErrors) and its own
          // two halves: the message is free-text scrubbed, the metadata is walked
          // by key. `order_id` is the survivor that makes the redaction assertions
          // mean something.
          onPress={() =>
            groundcover.captureException(new Error("auth failed for token=e2e-error-token"), {
              password: "e2e-error-password",
              order_id: "A-1",
            })
          }
        />
      </Card>
    </Screen>
  );
}
