import { createIngestServer, INGEST_PORT } from "./ingest-server";
import { assertDeviceAvailable } from "./preflight";

// Starts the mock ingest server once for the whole run. Mobilewright uses
// Playwright's runner, so a globalSetup that returns a teardown fn is honored.
// Kept in a module-level ref so the teardown returned below can close it.
let handle: Awaited<ReturnType<typeof start>> | null = null;

async function start() {
  const ingest = createIngestServer(INGEST_PORT);
  await ingest.listen();
  return ingest;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Fail fast (before the runner blocks on device connection) when no device is
  // booted — turns the classic silent hang into an actionable error.
  await assertDeviceAvailable();

  handle = await start();
  // eslint-disable-next-line no-console
  console.log(`[e2e] mock ingest listening on :${INGEST_PORT}`);
  return async () => {
    await handle?.close();
    handle = null;
  };
}
