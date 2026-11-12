/** Who sent a batch, as far as its session envelope reveals. */
export type ReporterIdentity = { os: string; model: string; sessionId: string };

type Enveloped = { __sessionAttributes?: unknown };

/**
 * Every reporter in `events` that is not the device under test. A stray playground POSTing to the
 * mock ingest falsifies every NEGATIVE assertion in the suite, plausibly enough that the failure
 * points at the SDK rather than the room.
 *
 * Platform alone does not identify the intruder: a SECOND DEVICE ON THE SAME PLATFORM matches on
 * `os.name`, and `device.model` cannot separate two simulators of one model. What separates them
 * is the WINDOW — idle and post-clear, so the device owns exactly one session id. First arrival
 * is ours; a batch with no session id is ignored rather than called foreign, and an undefined
 * `platform` stands that half down rather than failing the run on the gate's own ignorance.
 */
export function findForeignReporters(
  events: Enveloped[],
  platform: string | undefined
): ReporterIdentity[] {
  const foreign = new Map<string, ReporterIdentity>();
  let ours: string | null = null;

  for (const event of events) {
    const id = identify(event);
    if (!id) continue;

    // Wrong platform is foreign whatever its session id — including, if it ever
    // happens, a batch sharing the id we adopted.
    if (platform !== undefined && id.os !== "" && id.os !== platform) {
      foreign.set(id.sessionId, id);
      continue;
    }

    ours ??= id.sessionId;
    if (id.sessionId !== ours) foreign.set(id.sessionId, id);
  }

  return [...foreign.values()];
}

function identify(event: Enveloped): ReporterIdentity | null {
  const session = event.__sessionAttributes as
    | { os?: { name?: string }; device?: { model?: string }; session_id?: string }
    | undefined;
  const sessionId = String(session?.session_id ?? "");
  if (sessionId === "") return null;
  return {
    os: String(session?.os?.name ?? ""),
    model: String(session?.device?.model ?? ""),
    sessionId,
  };
}

/** One line per intruder, for the failure message. */
export function describeReporters(reporters: ReporterIdentity[]): string {
  return reporters.map((r) => `${r.os}/${r.model} session=${r.sessionId}`).join(", ");
}
