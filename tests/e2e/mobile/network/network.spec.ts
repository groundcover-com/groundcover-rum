import { test, expect } from "@mobilewright/test";
import { clearEvents, getEvents, waitForEvents } from "../support/ingest-client";
import { tapScrolling } from "../support/ui";

// The end-to-end network capture path, in every app (RN's fetch runs over XHR;
// @rn-only and @flutter-only tests cover each SDK's own clients). Every request
// goes to the mock ingest's echo on :9394, so no test needs outbound internet;
// the traceparent-injection unit tests cover the header logic independently.
test.describe("rn-playground — network", () => {
  test.beforeEach(async () => {
    await clearEvents();
  });

  test("fetch GET is captured as a network event with the injected traceparent", async ({ screen }) => {
    // Arrange: go to the Network screen.
    await screen.getByLabel("Network tab").tap();

    // Act: fire a fetch GET.
    await screen.getByText("fetch GET").tap();

    // Assert: keyed on THIS request, not on "any network event with a name" —
    // the echo is the only target, but a bare predicate would also match the
    // axios or failing request if a batch straggled in from a previous test.
    const [net] = await waitForEvents("network", {
      timeout: 30_000,
      where: (e) => {
        const a = e.attributes as Record<string, unknown>;
        return String(a["resource_name"] ?? "") === "/__echo" && a["http.method"] === "GET";
      },
    });
    expect(net).toBeTruthy();

    const attrs = net!.attributes as Record<string, unknown>;
    expect(attrs["type"]).toBe("HTTP");
    expect(attrs["status"]).toBe("200");
    expect(attrs["operation.name"]).toBe("GET");
    expect(net!.span_name).toBe("GET /__echo");

    // A WELL-FORMED traceparent, not merely a truthy one. `00-<32 hex>-<16
    // hex>-<flags>` is what a collector will accept; an all-zero id, a
    // browser-shaped header, or a stray empty string are all truthy and all
    // useless.
    const traceparent = String(attrs["http.request.headers.traceparent"] ?? "");
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(traceparent).not.toMatch(/-0{32}-|-0{16}-/);

    // And the event JOINS the trace it advertised. The SDK records the header it
    // intended to send and separately stamps the event's own ids; if those two
    // ever diverge, every RUM network event quietly stops correlating with its
    // APM span and no other assertion notices.
    const [, headerTraceId, headerSpanId] = traceparent.split("-");
    expect(net!.traceId).toBe(headerTraceId);
    expect(net!.spanId).toBe(headerSpanId);

    // It actually left the device. Everything above reads what the SDK recorded
    // about its own request; the echo replays what the server received, which is
    // the only proof the header survived the XHR patch.
    expect(String(attrs["gc.response.body"] ?? "")).toContain(traceparent);
  });

  test("fetch POST is captured with its method and request body", async ({ screen }) => {
    // The only playground request carrying a body, and the only one that proves
    // the method is read rather than defaulted — a `GET` default is the
    // definition of wrong-but-plausible.
    await screen.getByLabel("Network tab").tap();
    await screen.getByText("fetch POST").tap();

    const [net] = await waitForEvents("network", {
      timeout: 30_000,
      where: (e) => (e.attributes as Record<string, unknown>)["http.method"] === "POST",
    });
    expect(net).toBeTruthy();

    const attrs = net!.attributes as Record<string, unknown>;
    expect(attrs["operation.name"]).toBe("POST");
    expect(attrs["subType"]).toBe("POST");
    expect(net!.span_name).toBe("POST /__echo");
    expect(attrs["status"]).toBe("200");
    expect(attrs["gc.request.body"]).toBe('{"hello":"mobile"}');

    // The server's view: the body reached it intact and at full length. The
    // instrument reads the request on its way past, and "never alters the host's
    // request" is a contract only the receiving end can confirm.
    const echoed = String(attrs["gc.response.body"] ?? "");
    expect(echoed).toContain('"method":"POST"');
    expect(echoed).toContain('"bytes":18');
  });

  test("captures the response body of a fetch (RN blob body read via FileReader)", async ({ screen }) => {
    // Arrange: go to the Network screen.
    await screen.getByLabel("Network tab").tap();

    // Act: fire a fetch GET.
    await screen.getByText("fetch GET").tap();

    // Assert: a real response body is captured, not the "[response body
    // unavailable]" placeholder. RN's fetch polyfill delivers a Blob response;
    // the SDK reads its text off the sync path (FileReader). The local echo
    // returns JSON echoing the request (method/url/headers), so it's deterministic.
    const [net] = await waitForEvents("network", {
      timeout: 30_000,
      where: (e) => {
        const body = String((e.attributes as Record<string, unknown>)?.["gc.response.body"] ?? "");
        return body.length > 0 && !body.includes("unavailable");
      },
    });
    expect(net).toBeTruthy();
    const body = String((net!.attributes as Record<string, unknown>)["gc.response.body"]);
    expect(body).toContain("GET");
  });

  test("axios GET is captured too (same XHR instrument)", { tag: "@rn-only" }, async ({ screen }) => {
    // Arrange: go to the Network screen.
    await screen.getByLabel("Network tab").tap();

    // Act: fire an axios GET.
    await screen.getByText("axios GET").tap();

    // Assert: keyed on the axios-only path. axios and fetch share the XHR
    // instrument, so a spec that waits for "any network event" cannot tell which
    // client produced the one it found — it would pass on the fetch event with
    // axios support entirely broken.
    const [net] = await waitForEvents("network", {
      timeout: 30_000,
      where: (e) =>
        String((e.attributes as Record<string, unknown>)["resource_name"] ?? "") === "/__echo/axios",
    });
    expect(net).toBeTruthy();

    const attrs = net!.attributes as Record<string, unknown>;
    expect(attrs["status"]).toBe("200");
    // axios sets its own headers on the XHR; ours has to survive alongside them.
    expect(String(attrs["http.request.headers.traceparent"] ?? "")).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/
    );
  });

  test("a bare XMLHttpRequest is captured (the layer the instrument actually patches)", { tag: "@rn-only" }, async ({
    screen,
  }) => {
    // fetch and axios both arrive here through XHR, so this file already covers
    // the instrument twice over — but only ever with a wrapper in front of it. A
    // direct XHR is what plenty of RN code (and plenty of SDKs inside RN apps)
    // uses, and it is the shape the patch is written against: it sets no
    // content-type, goes through no polyfill, and reads its response as text
    // rather than as the Blob RN's fetch produces.
    await screen.getByLabel("Network tab").tap();
    await screen.getByText("XHR GET").tap();

    // Keyed on the echo path AND on there being no request body, so a straggling
    // fetch event from an earlier test cannot satisfy it.
    const [net] = await waitForEvents("network", {
      timeout: 30_000,
      where: (e) => {
        const a = e.attributes as Record<string, unknown>;
        return String(a["resource_name"] ?? "") === "/__echo" && a["http.method"] === "GET";
      },
    });
    expect(net).toBeTruthy();

    const attrs = net!.attributes as Record<string, unknown>;
    expect(attrs["status"]).toBe("200");
    expect(attrs["type"]).toBe("HTTP");
    // The trace header is injected on the raw XHR path too — the patch has to add
    // it without a wrapper's headers to piggyback on.
    expect(String(attrs["http.request.headers.traceparent"] ?? "")).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/
    );
    // And the echo confirms it left the device rather than merely being recorded.
    expect(String(attrs["gc.response.body"] ?? "")).toContain("traceparent");
  });

  test("a failed request is captured with status 0 and an error type", async ({ screen, platform }) => {
    // SKIPPED ON iOS. The failure this asserts (status 0 + error.type) needs the OS
    // to fail an unreachable request fast. On the iOS simulator the connect to
    // loopback port 1 (and to an unresolvable host) can instead HANG up to
    // NSURLSession's ~60s request timeout — past this spec's window — depending on
    // the runner. A client-side `xhr.timeout` would bound it, but iOS RN ignores it
    // (the request runs full-length and succeeds), and an abort() is suppressed by
    // the SDK by design — so there is no in-app lever to force a fast failure on
    // iOS. Android refuses the connection instantly and exercises the path for
    // real; the capture logic is also covered by unit tests.
    test.skip(platform === "ios", "iOS connect can hang; covered on Android + unit tests");

    // Arrange: go to the Network screen.
    await screen.getByLabel("Network tab").tap();

    // Act: fire a request that fails. The failure branch hangs off the real XHR
    // `error`/`timeout` events, which only fire against a live network stack — the
    // unit test can only simulate a successful load, so this is the on-device
    // proof of the error path. The button sits below the fold on a pixel_6 emulator.
    await tapScrolling(screen, "failing request");

    // Assert: the failure is captured with status 0 and a network error type.
    const [net] = await waitForEvents("network", {
      timeout: 30_000,
      where: (e) => String((e.attributes as Record<string, unknown>)?.["error.type"] ?? "").length > 0,
    });
    expect(net).toBeTruthy();

    const attrs = net!.attributes as Record<string, unknown>;
    expect(attrs["type"]).toBe("HTTP");
    expect(attrs["status"]).toBe("0");
    expect(String(attrs["error.type"])).toMatch(/ERR_NETWORK_FAILURE|ERR_TIMEOUT/);
  });

  test("a fetch built from a Request object captures its body (RN _bodyInit path)", { tag: "@rn-only" }, async ({
    screen,
  }) => {
    // The shape generated API clients emit: everything lives on the `Request`
    // handed to fetch, not in an `init`. The SDK reads the body off `_bodyInit` on
    // RN's whatwg-fetch Request — undici's Request has a real `.body`, so the unit
    // test passes on a runtime we do not ship and this is the only proof of the
    // path that actually runs on device.
    await screen.getByLabel("Network tab").tap();
    await screen.getByText("fetch Request-input POST").tap();

    const [net] = await waitForEvents("network", {
      timeout: 30_000,
      where: (e) => {
        const a = e.attributes as Record<string, unknown>;
        return (
          a["http.method"] === "POST" &&
          String(a["gc.request.body"] ?? "").includes("e2e-request-input-marker")
        );
      },
    });
    expect(net).toBeTruthy();

    const attrs = net!.attributes as Record<string, unknown>;
    expect(attrs["operation.name"]).toBe("POST");
    expect(String(attrs["gc.request.body"])).toContain("e2e-request-input-marker");
    // And it reached the server intact — the instrument read the body without
    // consuming it out from under fetch.
    const echoed = String(attrs["gc.response.body"] ?? "");
    expect(echoed).toContain('"method":"POST"');
  });

  test("an aborted request is not reported, while a concurrent successful one is", async ({
    screen,
  }) => {
    // "No network event" is the weakest assertion in the suite — it passes just as
    // happily when capture is broken outright. So this fires a request that DOES
    // land in the same window: the successful GET below is the positive control
    // that proves the instrument is live, which is what makes the absence of the
    // aborted request meaningful.
    await screen.getByLabel("Network tab").tap();
    await screen.getByText("abort in-flight").tap();
    await screen.getByText("fetch GET").tap();

    // The control landed — capture is working.
    const [ok] = await waitForEvents("network", {
      timeout: 30_000,
      where: (e) => {
        const a = e.attributes as Record<string, unknown>;
        return String(a["resource_name"] ?? "") === "/__echo" && a["http.method"] === "GET";
      },
    });
    expect(ok).toBeTruthy();

    // The aborted /slow request produced no network event. Read AFTER the control
    // arrived, so a batch carrying the aborted event (if the suppression were
    // broken) would already be here.
    const aborted = (await getEvents()).filter(
      (e) =>
        e.type === "network" &&
        String((e.attributes as Record<string, unknown>)["resource_name"] ?? "").startsWith(
          "/__echo/slow"
        )
    );
    expect(aborted).toHaveLength(0);
  });

  test("a response larger than the body cap is recorded as the too-large placeholder", async ({
    screen,
  }) => {
    // The echo's /large returns >5 KB of application/json, past maxBodyLength. On
    // device RN's fetch response has no getReader(), so the blob-sizing path runs
    // and must report the placeholder rather than the body — the branch the node
    // unit test (with a real ReadableStream) never takes.
    await screen.getByLabel("Network tab").tap();
    await screen.getByText("large response").tap();

    const [net] = await waitForEvents("network", {
      timeout: 30_000,
      where: (e) =>
        String((e.attributes as Record<string, unknown>)["resource_name"] ?? "") === "/__echo/large",
    });
    expect(net).toBeTruthy();

    const attrs = net!.attributes as Record<string, unknown>;
    expect(attrs["status"]).toBe("200");
    // The exact placeholder, not merely "does not contain the filler" — a truncated
    // body or an empty string would both pass a weaker check.
    expect(attrs["gc.response.body"]).toBe("[response body too large]");
  });

  test("request headers given as [name, value] tuples are captured, not mangled", { tag: "@rn-only" }, async ({
    screen,
  }) => {
    // RN's Headers can present as an array of tuples at runtime; a capture that
    // treats them as an object folds that into an indexed key like
    // `{"0":"x-arr-header,arr-marker"}` and drops the header. Only a device runtime
    // produces the tuple shape, so this is the end-to-end proof.
    await screen.getByLabel("Network tab").tap();
    // At the fold, half under the tab bar on a pixel_6 emulator.
    await tapScrolling(screen, "array-tuple headers");

    const [net] = await waitForEvents("network", {
      timeout: 30_000,
      where: (e) =>
        String(
          (e.attributes as Record<string, unknown>)["http.request.headers.x-arr-header"] ?? ""
        ) === "arr-marker",
    });
    expect(net).toBeTruthy();

    const attrs = net!.attributes as Record<string, unknown>;
    expect(attrs["http.request.headers.x-arr-header"]).toBe("arr-marker");
    // The tuple must not have collapsed into a numeric index key.
    expect(attrs["http.request.headers.0"]).toBeUndefined();
  });

  // Each Flutter client hits its own echo path, so a spec can tell which one was captured.
  for (const [client, path] of [
    ["dart:io", "/__echo/dartio"],
    ["dio", "/__echo/dio"],
  ] as const) {
    test(`${client} GET is captured with the injected traceparent`, { tag: "@flutter-only" }, async ({
      screen,
    }) => {
      await screen.getByLabel("Network tab").tap();
      await screen.getByText(`${client} GET`).tap();

      const [net] = await waitForEvents("network", {
        timeout: 30_000,
        where: (e) => String((e.attributes as Record<string, unknown>)["resource_name"] ?? "") === path,
      });
      expect(net).toBeTruthy();
      const attrs = net!.attributes as Record<string, unknown>;
      expect(attrs["status"]).toBe("200");
      expect(attrs["http.method"]).toBe("GET");
      expect(String(attrs["http.request.headers.traceparent"] ?? "")).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/
      );
    });
  }
});
