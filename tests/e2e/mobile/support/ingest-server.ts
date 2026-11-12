import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";

// Local stand-in for the groundcover RUM ingest: mobilewright has no network assertion, so the
// SDK is pointed here and the specs assert on what it recorded. The runner uses worker processes,
// so state cannot be shared in-process — hence a query API called over HTTP.
//
//   POST /json/rum, GET|DELETE /__e2e/events, GET /__e2e/health
//   GET /__e2e/stats, GET /__e2e/requests, POST /__e2e/fail-next, GET /__e2e/echoes
//
// Those last four exist for claims reading events cannot test: that delivery is retried, that
// the SDK authenticates in a HEADER, that volume stays bounded, and that a header the SDK says it
// sent reached the server.

export type RecordedBatch = {
  sessionAttributes: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
};

/** A request the echo received, as it arrived. */
export type EchoedRequest = {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
};

/** What the server observed about one batch POST, independent of its contents. */
export type RecordedRequest = {
  seq: number;
  receivedAtMs: number;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** Bytes ON THE WIRE — post-gzip when the transport compresses. */
  bytes: number;
  /** The status this server answered with; non-2xx means armed by fail-next. */
  status: number;
};

export const INGEST_PORT = 9393;
// The echo target for the NetworkScreen buttons lives on a SIBLING port, not the
// ingest port: the SDK's network instrument deliberately ignores any request to
// its own DSN endpoint (network-events-listener: `url.includes(endpoint)`), so
// an echo on :9393 would never be captured. :9394 is a different endpoint, so
// the fetch/axios/XHR calls are captured — while still never leaving the host.
export const ECHO_PORT = 9394;

function readBody(req: import("node:http").IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

export function createIngestServer(port: number = INGEST_PORT): {
  server: Server;
  listen: () => Promise<void>;
  close: () => Promise<void>;
} {
  const batches: RecordedBatch[] = [];
  // Batches the server REJECTED (fail-next armed). Kept apart from `batches` so
  // `/__e2e/events` keeps meaning "what the ingest accepted": a spec asserting
  // that a rejected crash is redelivered must not find the rejected attempt and
  // conclude it already arrived.
  const rejectedBatches: RecordedBatch[] = [];
  const requests: RecordedRequest[] = [];
  const echoes: EchoedRequest[] = [];
  let seq = 0;
  // Armed by /__e2e/fail-next. Counts DOWN per batch POST, so a spec can fail
  // exactly one delivery or (with a large count) every delivery until it disarms.
  let failRemaining = 0;
  let failStatus = 500;

  const handler = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    try {
      const url = req.url || "";
      const method = req.method || "GET";

      if (url.startsWith("/__echo")) {
        echoes.push({ url, method, headers: req.headers as EchoedRequest["headers"] });
      }

      if (method === "POST" && url.startsWith("/json/rum")) {
        const raw = await readBody(req);
        const encoding = req.headers["content-encoding"];
        const text = (encoding === "gzip" ? gunzipSync(raw) : Buffer.from(raw)).toString("utf8");
        const failing = failRemaining > 0;
        if (failing) failRemaining -= 1;
        const status = failing ? failStatus : 200;
        seq += 1;
        requests.push({
          seq,
          receivedAtMs: Date.now(),
          url,
          headers: req.headers as Record<string, string | string[] | undefined>,
          bytes: raw.byteLength,
          status,
        });
        try {
          const batch = JSON.parse(text) as RecordedBatch;
          if (batch && Array.isArray(batch.events)) {
            (failing ? rejectedBatches : batches).push(batch);
          }
        } catch {
          /* ignore a malformed batch — the test will fail on a missing event */
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      // Arm/disarm the failure injector: ?count=N (default 1; 0 disarms) and
      // ?status=S (default 500). Echoes the resulting state so a spec can assert
      // it armed rather than assume it.
      if (method === "POST" && url.startsWith("/__e2e/fail-next")) {
        const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
        const count = Number(query.get("count") ?? "1");
        const status = Number(query.get("status") ?? "500");
        failRemaining = Number.isFinite(count) && count >= 0 ? count : 1;
        failStatus = Number.isFinite(status) && status >= 400 ? status : 500;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ failRemaining, failStatus }));
        return;
      }

      // The privacy target, and DELIBERATELY not an echo. The general echo below replays
      // the request url and headers, which would put the very secrets a privacy spec hunts
      // for into the RESPONSE body — where redaction is by KEY, so a token inside the
      // echoed `url` string survives. That is real SDK behaviour and worth knowing, but
      // mixing the two would make a redaction test fail on the echo's shape.
      if (url.startsWith("/__echo/sensitive")) {
        await readBody(req).catch(() => new Uint8Array());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // A deliberately SLOW response, for the abort spec: the device starts a
      // request here and aborts it before this resolves, so the request never
      // completes and no network event should be recorded for it. `?ms=` (default
      // 5000) is the hold; kept well above the spec's abort delay so the abort
      // always wins the race. Drains the body first so the socket does not stall.
      if (url.startsWith("/__echo/slow")) {
        await readBody(req).catch(() => new Uint8Array());
        const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
        const ms = Number(query.get("ms") ?? "5000");
        const holdMs = Number.isFinite(ms) && ms >= 0 ? ms : 5000;
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, slow: true }));
        return;
      }

      // A response LARGER than the SDK's body cap (maxBodyLength = 5000), for the
      // response-cap spec: the SDK must record the too-large placeholder rather
      // than the body. `application/json` so it takes the text path, not the
      // binary placeholder. Padded well past the cap so a small change in the
      // cap does not silently make this fit.
      if (url.startsWith("/__echo/large")) {
        await readBody(req).catch(() => new Uint8Array());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ filler: "x".repeat(8000) }));
        return;
      }

      if (url.startsWith("/__echo")) {
        const body = await readBody(req).catch(() => new Uint8Array());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method, url, headers: req.headers, bytes: body.length }));
        return;
      }

      if (url.startsWith("/__e2e/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Counters, for the claims that are about VOLUME rather than content: an
      // SDK that flushes per event instead of per window, or that keeps
      // reporting while the app sits idle, is invisible to every event-shape
      // assertion in the suite.
      if (url.startsWith("/__e2e/stats")) {
        const accepted = requests.filter((r) => r.status < 400);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            batches: batches.length,
            rejectedBatches: rejectedBatches.length,
            events: batches.reduce((n, b) => n + b.events.length, 0),
            requests: requests.length,
            bytes: requests.reduce((n, r) => n + r.bytes, 0),
            firstAtMs: accepted[0]?.receivedAtMs ?? 0,
            lastAtMs: accepted[accepted.length - 1]?.receivedAtMs ?? 0,
            failRemaining,
          })
        );
        return;
      }

      if (url.startsWith("/__e2e/echoes")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echoes }));
        return;
      }

      if (url.startsWith("/__e2e/requests")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ requests }));
        return;
      }

      if (url.startsWith("/__e2e/events")) {
        if (method === "DELETE") {
          // Clears everything RECORDED (accepted, rejected, request and echo logs) but
          // deliberately leaves fail-next armed: a spec that arms the injector
          // and then clears before relaunching must not silently disarm it.
          batches.length = 0;
          rejectedBatches.length = 0;
          requests.length = 0;
          echoes.length = 0;
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        const includeRejected = /[?&]includeRejected=1/.test(url);
        const source = includeRejected ? [...batches, ...rejectedBatches] : batches;
        const events = source.flatMap((b) =>
          b.events.map((e) => ({ ...e, __sessionAttributes: b.sessionAttributes }))
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ batches: source, events }));
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  };

  // Ingest on `port`; the same handler also serves the echo target on ECHO_PORT.
  const server = createServer(handler);
  const echoServer = createServer(handler);

  // 0.0.0.0 so a simulator (localhost) and an Android emulator (10.0.2.2) can
  // both reach the host.
  const listenOn = (s: Server, p: number) =>
    new Promise<void>((resolve) => s.listen(p, "0.0.0.0", () => resolve()));
  const closeOne = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));

  return {
    server,
    listen: async () => {
      await Promise.all([listenOn(server, port), listenOn(echoServer, ECHO_PORT)]);
    },
    close: async () => {
      await Promise.all([closeOne(server), closeOne(echoServer)]);
    },
  };
}
