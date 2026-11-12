// Worker entrypoint — stateless dispatcher: { id, op, payload } in,
// { id, ok, result | error } out. Failures reported so caller can fall back.

import { gzipSync, strToU8 } from "fflate";
import { pack } from "@rrweb/packer";

type RawReplayEvent = Parameters<typeof pack>[0];

type Request =
  | { id: number; op: "pack-replay"; payload: { events: RawReplayEvent[] } }
  | { id: number; op: "encode-batch"; payload: { json: string; compress: boolean } };

type Response =
  | { id: number; ok: true; result: { packed: string[] } }
  | { id: number; ok: true; result: { bytes: Uint8Array; isCompressed: boolean } }
  | { id: number; ok: false; error: string };

// tsconfig lib has no "webworker"; declare a minimal structural self instead
// of pulling in the conflicting WorkerGlobalScope lib.
interface WorkerSelf {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Response, transfer?: Transferable[]) => void;
}

const ctx = self as unknown as WorkerSelf;

ctx.onmessage = (event) => {
  // Guard the destructure: a malformed message must not throw outside try
  // — that surfaces as onerror and latches the worker off in WorkerClient.
  const data = event.data as Partial<Request> | null | undefined;
  if (!data || typeof data.id !== "number" || (data.op !== "pack-replay" && data.op !== "encode-batch")) {
    if (data && typeof data.id === "number") {
      ctx.postMessage({ id: data.id, ok: false, error: "malformed message" });
    }
    return;
  }
  const { id, op, payload } = data as Request;

  try {
    if (op === "pack-replay") {
      const packed = payload.events.map((e) => pack(e));
      ctx.postMessage({ id, ok: true, result: { packed } });
      return;
    }

    if (op === "encode-batch") {
      const { json, compress } = payload;
      if (!compress) {
        const bytes = new TextEncoder().encode(json);
        ctx.postMessage({ id, ok: true, result: { bytes, isCompressed: false } }, [bytes.buffer]);
        return;
      }
      try {
        const bytes = gzipSync(strToU8(json));
        ctx.postMessage({ id, ok: true, result: { bytes, isCompressed: true } }, [bytes.buffer]);
        return;
      } catch {
        const bytes = new TextEncoder().encode(json);
        ctx.postMessage({ id, ok: true, result: { bytes, isCompressed: false } }, [bytes.buffer]);
        return;
      }
    }

    ctx.postMessage({ id, ok: false, error: "unknown op" });
  } catch (error) {
    ctx.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
