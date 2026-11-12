import { test, expect } from "@mobilewright/test";
import { getEvents, getRequests, settleAndClear, waitForEvents } from "../support/ingest-client";
import { app } from "../support/app";

// Two ways the SDK could turn a customer's own telemetry against them, both
// invisible to every other spec in the suite.
//
// The playground runs with `debug: true` AND console capture on, which is the
// combination that makes the first one live rather than theoretical: the SDK logs
// through the same console it patches, so one debug line that interpolates config
// — or one missing `groundcoverIgnore` — publishes the customer's API key into
// their own event stream. `logs-custom.spec.ts` already proves the general
// feedback loop is closed; this is the same shape with a security payload.
test.describe("rn-playground — security", () => {
  test("the API key authenticates in a header and never reaches an event or a URL", async ({
    screen,
  }) => {
    // Three ingest waits, up to 70 s together, more than the default timeout allows.
    test.setTimeout(90_000);

    await settleAndClear();

    // Generate real traffic: a tap (interaction), a log, and a network request,
    // so the assertion below covers the three surfaces that carry attacker-useful
    // text rather than just one.
    await screen.getByText(/Increment counter/).tap();
    await waitForEvents("interaction");
    await screen.getByLabel("Logs tab").tap();
    await screen.getByText(app.platformLog.button).tap();
    await waitForEvents("log");
    await screen.getByLabel("Network tab").tap();
    await screen.getByText("fetch GET").tap();
    await waitForEvents("network", { timeout: 30_000 });

    const requests = await getRequests();
    expect(requests.length).toBeGreaterThan(0);

    // Learn the key from the wire rather than from the environment. The spec
    // process does not necessarily share the app's EXPO_PUBLIC_GC_API_KEY (it is
    // baked into the bundle at Metro start), and a hardcoded "e2e-key" here would
    // silently stop testing anything the day the harness changed it.
    const header = requests[0]!.headers["apikey"];
    const apiKey = Array.isArray(header) ? header[0] : header;
    // The batch must authenticate with an `apikey` header at all.
    expect(apiKey).toBeTruthy();
    expect(String(apiKey).length).toBeGreaterThan(3);

    // In a HEADER, not the URL. A key in a query string is logged by every proxy,
    // CDN and access log between the device and the ingest — and this is exactly
    // the kind of thing that gets "temporarily" moved to a query param to debug
    // something and never moved back.
    for (const request of requests) {
      expect(request.url).not.toContain(String(apiKey));
    }

    // And nowhere in any captured event. The whole payload is searched, not a
    // list of fields: the leak paths that matter are the ones nobody predicted —
    // a debug log, an error message quoting the config, a network event that
    // captured the SDK's own request headers.
    const events = await getEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(String(apiKey));
  });

  test("the SDK never captures its own batch POSTs as network events", async ({ screen }) => {
    test.setTimeout(90_000);

    await settleAndClear();

    // A tap produces a batch POST to the ingest, and the network instrument is
    // watching every request the app makes — including that one, unless it is
    // deliberately skipped (network-events-listener's `url.includes(endpoint)`).
    // Capturing it would be a feedback loop, not a cosmetic leak: the event
    // describing the POST is itself queued, which produces another POST.
    //
    // Then a REAL request, so this cannot pass by the network instrument simply
    // being dead — which is the failure mode a bare "no /json/rum events"
    // assertion would happily accept.
    await screen.getByText(/Increment counter/).tap();
    await waitForEvents("interaction");
    await screen.getByLabel("Network tab").tap();
    await screen.getByText("fetch GET").tap();
    await waitForEvents("network", { timeout: 30_000 });

    const events = await getEvents();
    const network = events.filter((e) => e.type === "network");
    expect(network.length).toBeGreaterThan(0);

    const selfReports = network.filter((e) => {
      const attrs = e.attributes as Record<string, unknown>;
      const url = `${String(attrs["url.full"] ?? "")} ${String(attrs["resource_name"] ?? "")}`;
      return url.includes("/json/rum");
    });
    expect(selfReports).toHaveLength(0);
  });
});
