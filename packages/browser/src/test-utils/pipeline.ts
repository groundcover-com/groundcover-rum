import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SDKConfigInput } from "@/config/types";

// Shared by the suites that run the whole browser pipeline against a stubbed fetch. Test-only:
// nothing in the SDK imports this file, so it never reaches the bundle.

// __dirname rather than import.meta.url: under happy-dom, `URL` is the DOM's, not Node's.
const FIXTURE_DIR = join(__dirname, "../../../core/wire");

/** A file from packages/core/wire, the request fixtures every SDK's golden test shares. */
export const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));

// wire/config.json, shared with every golden: a bare-host dsn (pins the getEndpoint()
// https:// upgrade), and batchSize 0 so every enqueued event triggers a flush (except types in
// EVENTS_TO_SKIP_FLUSH), keeping the tests deterministic without timers.
export const BASE_CONFIG = fixture("config.json") as SDKConfigInput;

export async function drainAsyncSends(): Promise<void> {
  // transporter.send awaits the async encode path before calling fetch; a few
  // macrotask turns are enough for all pending sends to reach the fetch stub.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
