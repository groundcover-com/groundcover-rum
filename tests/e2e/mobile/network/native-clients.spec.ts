import { test, expect } from "@mobilewright/test";
import { clearEvents, expectEvents, getEchoes, getEvents, type RumEvent } from "../support/ingest-client";
import { tapScrolling } from "../support/ui";

// The other ways a native app calls HTTP, beside the one under RN's "fetch" labels that
// network.spec.ts drives. Each has an echo path of its own, so a spec can tell which one produced
// an event:
//   - iOS: plain URLSession, with no SDK call, recorded by the SDK's URLSession hook: a
//     completion handler, a delegate of the app's own, and async/await.
//   - Android: OkHttp's enqueue and execute, and a client derived with newBuilder(), which
//     inherits the app's interceptor and event listener.
// One test per way, keyed on its path: a test waiting for "any network event" would pass on the
// fetch path and keep passing with one of these uncaptured.
type Client = { label: string; path: string };

const CLIENTS: Record<"ios" | "android", Record<string, Client>> = {
  ios: {
    callback: { label: "URLSession completion GET", path: "/__echo/completion" },
    inPlace: { label: "URLSession async GET", path: "/__echo/async" },
    secondClient: { label: "URLSession delegate GET", path: "/__echo/delegate" },
  },
  android: {
    callback: { label: "OkHttp enqueue GET", path: "/__echo/enqueue" },
    inPlace: { label: "OkHttp execute GET", path: "/__echo/execute" },
    secondClient: { label: "OkHttp derived client GET", path: "/__echo/derived" },
  },
};

const WAYS = [
  ["callback", "a request completed through a callback"],
  ["inPlace", "a request awaited in place"],
  ["secondClient", "a request through a second, separately built session or client"],
] as const;

const resourceName = (e: RumEvent) => String(e.attributes?.["resource_name"] ?? "");

test.describe("native — every way the app calls HTTP", { tag: "@native-app-only" }, () => {
  test.beforeEach(async () => {
    await clearEvents();
  });

  for (const [way, title] of WAYS) {
    test(`${title} is captured with the injected traceparent`, async ({ screen, platform }) => {
      const client = CLIENTS[platform === "android" ? "android" : "ios"][way]!;

      await screen.getByLabel("Network tab").tap();
      await tapScrolling(screen, client.label);

      const [net] = await expectEvents("network", {
        timeout: 30_000,
        where: (e) => resourceName(e) === client.path,
        describe: `the request to ${client.path}`,
      });

      const attrs = net!.attributes ?? {};
      expect(attrs["status"]).toBe("200");
      expect(attrs["http.method"]).toBe("GET");
      const traceparent = String(attrs["http.request.headers.traceparent"] ?? "");
      expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
      // The server's view: the header the SDK recorded is the one that left the device. iOS's
      // hook never reads a response body, so the echo's own log is the proof, not its reply.
      const received = (await getEchoes()).filter((e) => e.url.split("?")[0] === client.path);
      expect(received.map((e) => e.headers["traceparent"])).toEqual([traceparent]);
    });
  }

  test("a request recorded through the API is reported once, not again by the hook", async ({
    screen,
    platform,
  }) => {
    test.skip(platform !== "ios", "the URLSession hook is iOS's");
    await screen.getByLabel("Network tab").tap();
    // Through `groundcoverDataTask`, on a URLSession the hook also sees.
    await screen.getByText("fetch GET").tap();
    await expectEvents("network", {
      timeout: 30_000,
      where: (e) => resourceName(e) === "/__echo",
      describe: "the request through the API",
    });

    // A later request, through the hook: once it lands, a second event for the first would have
    // landed too, in its batch or an earlier one.
    await tapScrolling(screen, "URLSession completion GET");
    await expectEvents("network", {
      timeout: 30_000,
      where: (e) => resourceName(e) === "/__echo/completion",
      describe: "the later request through the hook",
    });

    const echoEvents = (await getEvents()).filter(
      (e) => e.type === "network" && resourceName(e) === "/__echo"
    );
    expect(echoEvents).toHaveLength(1);
    // And the one event is the API's, with the response body the hook never reads.
    expect(String(echoEvents[0]!.attributes?.["gc.response.body"])).toContain('"method":"GET"');
  });
});
