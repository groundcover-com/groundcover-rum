import type { BatchSender } from "@groundcover/rum-core";

// How a batch reaches the wire on React Native. RN's fetch (whatwg-fetch over XHR) has no
// default timeout, so a stalled connection — a backgrounded socket, a flaky network — would
// hang forever and let in-flight sends pile up unbounded; an AbortController bounds it. And
// RN's fetch sends a Uint8Array body as raw bytes at runtime, but its RequestInit body type
// omits ArrayBufferView, so the body is cast at this one boundary.
//
// One definition, two callers: the live pool (RNSessionManager) sends fire-and-forget, and
// the crash drain needs to know whether each report actually landed for its at-least-once
// ack. `onOutcome` serves the second without the first paying for it.

/** Upper bound on a single batch POST before it is aborted. */
export const RN_SEND_TIMEOUT_MS = 30_000;

/**
 * Builds the RN {@link BatchSender}.
 *
 * @param onOutcome Called at most once per request with whether the server ACCEPTED it — a
 *   resolved 2xx is `true`; a non-2xx, a network rejection, or a synchronous `fetch` throw is
 *   `false`. Omit it for the live path, which is fire-and-forget: the {@link Transporter} never
 *   awaits the returned promise and never retries, it only reports a non-2xx response.
 */
export function createRnBatchSender(onOutcome?: (delivered: boolean) => void): BatchSender {
  return (endpoint, request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RN_SEND_TIMEOUT_MS);
    try {
      const response = fetch(endpoint, {
        method: request.method,
        headers: request.headers,
        body: request.body as unknown as string,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (onOutcome) {
        response.then(
          (res) => onOutcome(res?.ok === true),
          () => onOutcome(false)
        );
      }
      return response;
    } catch (error) {
      // `fetch` threw synchronously (e.g. a host with no global fetch): clear the timer and
      // surface it as a rejection so the transporter's .catch handles it uniformly — never a
      // sync throw or a leaked timer.
      clearTimeout(timer);
      onOutcome?.(false);
      return Promise.reject(error);
    }
  };
}
