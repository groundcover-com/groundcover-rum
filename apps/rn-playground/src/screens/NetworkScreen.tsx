import * as React from "react";
import { Text } from "react-native";
import axios from "axios";
import { Button, Card, Hint, Screen, Title } from "../ui";
import { DEVICE_TRACE_TARGETS } from "../config-env";

// In e2e the app's DSN points at the local mock ingest (localhost:9393 on iOS,
// 10.0.2.2:9393 on Android). The echo target sits on the SIBLING port (9394):
// the SDK's network instrument ignores requests to its own ingest endpoint, so
// hitting :9393 would never be captured. This gives a fast, always-reachable
// target that never leaves the host. Falls back to httpbin for manual runs.
const DSN = process.env.EXPO_PUBLIC_GC_DSN ?? "";
// Only the local mock ingest (port 9393) has a sibling /__echo on :9394. A real
// DSN (manual runs) has no such endpoint, so fall back to httpbin there.
const ECHO_IS_LOCAL_MOCK = /:9393(?=$|\/)/.test(DSN);
const ECHO = ECHO_IS_LOCAL_MOCK
  ? `${DSN.replace(/\/+$/, "").replace(/:9393(?=$|\/)/, ":9394")}/__echo`
  : DEVICE_TRACE_TARGETS.echo;

// A second, PUBLIC target for the "classic trace" button below. Deliberately not
// ECHO: in e2e that resolves to the local mock ingest, which returns a stub, and
// on manual runs httpbin is not reliably available (a 503 records every span as
// an error with no response body). jsonplaceholder answers a POST with 201 plus a
// JSON body echoing what was sent, which is what makes a complete
// request+response span possible.
// It is also what the browser playground already lists in `propagationUrls`. Shared with the
// device preset via DEVICE_TRACE_TARGETS so the URL and its propagation glob cannot drift apart.
const CLASSIC = DEVICE_TRACE_TARGETS.classic;

// A button that declines to act reports a SKIP, not a success. Returned rather than thrown
// because declining is not a failure, and rendered distinctly because `ok` on an action that
// sent nothing is the one reading a device tester must not be given — it is indistinguishable
// from a fixture that ran. Keyed by a Symbol so no JSON response body can forge one: every
// echo target here replies with attacker-shaped JSON (httpbin reflects whatever it is sent),
// and a plain `{ skipped }` field would be duck-typed out of a response body.
const SKIPPED = Symbol("skipped");
const skip = (reason: string) => ({ [SKIPPED]: reason });
const skipReason = (value: unknown): string | null =>
  typeof value === "object" && value !== null && SKIPPED in value
    ? String((value as Record<symbol, unknown>)[SKIPPED])
    : null;

export function NetworkScreen() {
  const [last, setLast] = React.useState<string>("—");

  const withResult = (label: string, fn: () => Promise<unknown>) => async () => {
    setLast(`${label}: …`);
    try {
      const result = await fn();
      const reason = skipReason(result);
      setLast(reason ? `${label}: skipped — ${reason}` : `${label}: ok`);
    } catch (e) {
      setLast(`${label}: ${(e as Error).message}`);
    }
  };

  return (
    <Screen>
      <Title>Network</Title>
      <Hint>
        fetch / XHR / axios are all captured (RN routes fetch over XHR). Inspect the echoed
        request on httpbin to see the injected `traceparent`. A direct `expo/fetch` import is
        not captured (see the SDK README).
        Use “classic POST” for a span with request AND response bodies populated.
      </Hint>
      <Card>
        <Button
          label="fetch GET"
          testID="net-fetch-get"
          onPress={withResult("fetch", () => fetch(ECHO).then((r) => r.json()))}
        />
        <Button
          label="fetch POST"
          testID="net-fetch-post"
          onPress={withResult("fetch-post", () =>
            fetch(ECHO, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ hello: "mobile" }),
            }).then((r) => r.json())
          )}
        />
        <Button
          label="XHR GET"
          testID="net-xhr-get"
          onPress={withResult("xhr", () =>
            new Promise<void>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open("GET", ECHO);
              xhr.onload = () => resolve();
              xhr.onerror = () => reject(new Error("xhr failed"));
              xhr.send();
            })
          )}
        />
        <Button
          label="axios GET"
          testID="net-axios-get"
          // Its OWN path. axios and fetch both run over the same XHR instrument,
          // so with one shared URL the axios spec could not tell which client it
          // had actually captured, and would pass on the fetch event.
          onPress={withResult("axios", () => axios.get(`${ECHO}/axios`))}
        />
        <Button
          label="classic POST (body + response)"
          testID="net-classic-post"
          // The one button that produces a COMPLETE trace span: a request body, a
          // 2xx, and a response body. Everything else here either has no request
          // body (the GETs), no response body (the failing request), or is
          // deliberately redacted (`sensitive request`) — so this is the one
          // example of `request_body` and `response_body` populated together on
          // one span.
          //
          // The payload is deliberately mundane. Privacy redaction is key-based,
          // not wholesale, so `title`/`body`/`userId` survive it and the stored
          // span shows real content rather than a wall of `***`.
          onPress={withResult("classic", () =>
            fetch(CLASSIC, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                title: "groundcover RUM classic trace",
                body: "request and response bodies both captured on one span",
                userId: 1,
              }),
            }).then((r) => r.json())
          )}
        />
        <Button
          label="fetch Request-input POST"
          testID="net-fetch-request-input"
          // The shape generated API clients emit: the request is built as a
          // `Request` object and handed to fetch as its SOLE argument, so the
          // method/headers/body live on `input`, not in an `init`. The SDK has to
          // read the body off `_bodyInit` on RN's whatwg-fetch Request — a path
          // the node/undici unit test cannot exercise, since undici's Request has a
          // real `.body`. The marker is distinctive so the spec can assert it
          // reached `gc.request.body` intact.
          onPress={withResult("fetch-request-input", () =>
            fetch(
              new Request(ECHO, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reqinput: "e2e-request-input-marker" }),
              })
            ).then((r) => r.json())
          )}
        />
        <Button
          label="abort in-flight"
          testID="net-abort"
          // Start a request against the slow echo, then abort it before it can
          // resolve. An aborted request must NOT be reported — the suppression is
          // keyed on `signal.aborted` at the moment the XHR error fires, which only
          // a real abort on the device runtime exercises. The spec pairs this with
          // a request that DOES land, so "no event" cannot pass by capture being
          // broken outright.
          onPress={withResult("abort", () => {
            const controller = new AbortController();
            const inflight = fetch(`${ECHO}/slow?ms=5000`, { signal: controller.signal });
            setTimeout(() => controller.abort(), 200);
            return inflight;
          })}
        />
        <Button
          label="large response"
          testID="net-large-response"
          // The echo's /large returns >5 KB of application/json, past the SDK's
          // response body cap. On device RN's fetch response has no getReader(), so
          // the blob-sizing path runs and must yield the too-large placeholder —
          // the branch the node unit test (which has a real ReadableStream) never
          // takes.
          onPress={withResult("large", () => fetch(`${ECHO}/large`).then((r) => r.json()))}
        />
        <Button
          label="array-tuple headers"
          testID="net-array-headers"
          // Headers given as an ARRAY of [name, value] tuples — a shape RN's
          // Headers produce at runtime and a shape a naive capture mangles into
          // `{"0":"x-arr-header,arr-marker"}`, dropping the header. The spec asserts
          // the header is captured under its own lowercased key with its value
          // intact.
          onPress={withResult("array-headers", () =>
            fetch(ECHO, {
              method: "GET",
              headers: [["x-arr-header", "arr-marker"]],
            }).then((r) => r.json())
          )}
        />
        <Button
          label="failing request"
          testID="net-fail"
          // Loopback port 1 refuses the connection immediately on both iOS and
          // Android — a deterministic, fast network failure (a blackhole IP can
          // hang for the OS TCP timeout, ~60s on iOS). Not the DSN endpoint, so
          // the instrument still captures it (as status 0 + error.type).
          onPress={withResult("fail", () => fetch("http://127.0.0.1:1/unreachable"))}
        />
        <Button
          label="sensitive request"
          testID="net-sensitive"
          // One request carrying a secret in all three places the SDK redacts independently,
          // plus two controls that must SURVIVE — without them every assertion is equally
          // satisfied by redaction gone total. The distinctive `e2e-*-` values let a spec assert
          // the secret appears NOWHERE, not merely that the field it checked was redacted.
          //
          // LOCAL MOCK ONLY. `/__echo/sensitive` deliberately does not echo, but that is a
          // property of the mock, not of ECHO: on a device run ECHO falls back to the PUBLIC
          // httpbin, which echoes everything straight back. The values are synthetic, so no real
          // credential is at stake — but they would leave the machine, and redaction does not
          // recurse into a string-encoded response body, so httpbin's echo
          // would then be persisted to your cluster verbatim, planting strings that read like
          // secrets in real telemetry. e2e always resolves ECHO to the mock, so this gate never
          // fires there; it only stops a manual tap during a device run.
          onPress={withResult("sensitive", () =>
            !ECHO_IS_LOCAL_MOCK
              ? Promise.resolve(skip("local-mock only; ECHO is the public fallback here"))
              : fetch(`${ECHO}/sensitive?token=e2e-query-token&user=demo`, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    authorization: "Bearer e2e-bearer-secret",
                  },
                  body: JSON.stringify({
                    password: "e2e-body-password",
                    email: "demo@example.com",
                    order_id: "A-1",
                  }),
                }).then((r) => r.json())
          )}
        />
        <Text>Last: {last}</Text>
      </Card>
    </Screen>
  );
}
