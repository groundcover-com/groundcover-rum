import { ConfigManager } from "../config/config-manager";
import { Batch } from "../events/types";
import { Logger } from "../common/logger";
import { safeWarn } from "../common/safe-warn";
import { gzipSync, strToU8 } from "fflate";

export interface EncodedPayload {
  data: Uint8Array;
  isCompressed: boolean;
}

// Optional host-provided async encoder (e.g. one that compresses off the main
// thread). The inline fflate path below is the universal default — a platform
// with no off-thread primitive simply doesn't provide one.
export type AsyncEncoder = (
  data: string,
  enableCompression: boolean
) => Promise<EncodedPayload>;

// The universal, synchronous encode path. Exported so a host's async encoder
// can reuse it as its own fallback.
//
// UTF-8 goes through fflate's `strToU8`, never a bare `TextEncoder`: that
// global is not present on every host this runs on. `strToU8` uses it when it
// exists (decided once, at import) and otherwise its own encoder, which is
// exact for the BMP but mis-encodes surrogate pairs (emoji) — the batch is
// still sent, never dropped.
export function encodeInline(data: string, enableCompression: boolean): EncodedPayload {
  const byteArray = strToU8(data);
  if (!enableCompression) {
    return { data: byteArray, isCompressed: false };
  }

  try {
    return { data: gzipSync(byteArray), isCompressed: true };
  } catch {
    return { data: byteArray, isCompressed: false };
  }
}

export interface BatchRequest {
  method: "POST";
  headers: Record<string, string>;
  body: Uint8Array;
}

// The single network primitive core needs. Required, not optional-with-a-
// host-global default: no network global is universal across the hosts this
// package targets, and a default here would silently introduce the platform
// coupling the platform gate exists to prevent. The platform package owns HOW a
// batch reaches the wire; core owns what and when.
//
// Fire-and-forget by contract: Transporter never awaits the returned promise,
// so a slow network can't stall a flush. It only attaches handlers: a
// rejection is logged, and a resolved response with a 401 or 403 `status`
// warns once (fetch resolves rather than rejects on 4xx and 5xx).
//
// `options` is passed only for a lifecycle send (EventsPool.flush({ lifecycle:
// true }), when the host is hidden or torn down), so the platform can ask its
// network layer to let the request outlive the page or process (the browser's
// fetch `keepalive`). A sender with no such thing ignores it.
export interface BatchSendOptions {
  lifecycle: true;
}

export type BatchSender = (
  endpoint: string,
  request: BatchRequest,
  options?: BatchSendOptions
) => Promise<unknown>;

export interface TransporterDeps {
  config: ConfigManager;
  sendBatch: BatchSender;
  encodeAsync?: AsyncEncoder;
}

export class Transporter {
  private logger = Logger.getInstance();
  private readonly config: ConfigManager;
  private readonly sendBatch: BatchSender;
  private readonly encodeAsync: AsyncEncoder | null;
  private warnedRefusedKey = false;

  constructor(deps: TransporterDeps) {
    this.config = deps.config;
    this.sendBatch = deps.sendBatch;
    this.encodeAsync = deps.encodeAsync ?? null;
  }

  // Encode via the host's async encoder when provided; fall back to the inline
  // path on any encoder failure so an encoder hiccup never drops a batch.
  private compressAsync(data: string, enableCompression: boolean): Promise<EncodedPayload> {
    if (!this.encodeAsync) {
      return Promise.resolve(encodeInline(data, enableCompression));
    }

    // try/catch covers a SYNCHRONOUS throw (a custom encoder that throws before
    // returning a promise); .catch covers a rejected promise. Both funnel to the
    // same inline fallback — otherwise a sync throw would skip .catch, bubble to
    // send()'s outer catch, and silently drop the batch.
    try {
      return this.encodeAsync(data, enableCompression).catch(() =>
        encodeInline(data, enableCompression)
      );
    } catch {
      return Promise.resolve(encodeInline(data, enableCompression));
    }
  }

  // `lifecycle: true` skips the async encoder round-trip and compresses inline
  // so the request is queued before the host can suspend or tear down the
  // process. Set by EventsPool.flush from the platform's suspend handler.
  async send<TType extends string = string>(
    batch: Batch<TType>,
    { lifecycle = false }: { lifecycle?: boolean } = {}
  ): Promise<void> {
    const config = this.config.getConfig();

    if (!config) {
      return;
    }

    try {
      if (config?.options?.debug) {
        this.logger.log("Sending batch:", batch, { groundcoverIgnore: true });
      }

      const apiKey = config.apiKey;
      const endpoint = this.buildEndpoint();

      if (!apiKey) {
        this.logger.log("No API key found");
        return;
      }

      const stringifiedData = JSON.stringify(batch);
      const enableCompression = !!config?.options?.transport?.compression;
      const { data: finalData, isCompressed } = lifecycle
        ? encodeInline(stringifiedData, enableCompression)
        : await this.compressAsync(stringifiedData, enableCompression);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        apikey: apiKey,
        "Content-Encoding": isCompressed ? "gzip" : "",
      };

      const request: BatchRequest = { method: "POST", headers, body: finalData };
      // The third argument only on the lifecycle path (as flush() passes
      // { lifecycle } here): an ordinary send reaches the sender as it always has.
      (lifecycle
        ? this.sendBatch(endpoint, request, { lifecycle: true })
        : this.sendBatch(endpoint, request))
        .then(response => this.warnIfKeyRefused(response, endpoint))
        .catch(error => {
          this.logger.log("Network error while sending batch:", error, { groundcoverIgnore: true });
        });
    } catch (error) {
      // Optional-chained like the try path above: this handler runs inside an
      // async fn, so a second throw here would surface as an unhandled
      // rejection instead of the intended debug log.
      if (config?.options?.debug) {
        this.logger.log("Failed to send batch:", error, {
          groundcoverIgnore: true,
        });
      }
    }
  }

  // A 401 or 403 means the endpoint refuses the apiKey or dsn, so every batch
  // is dropped until they're fixed: warn once, even with debug off.
  private warnIfKeyRefused(response: unknown, endpoint: string): void {
    const status = (response as { status?: unknown } | null | undefined)?.status;
    if ((status !== 401 && status !== 403) || this.warnedRefusedKey) return;
    this.warnedRefusedKey = true;
    safeWarn(
      `[groundcover] ${endpoint} rejected a batch with HTTP ${status}. Check the apiKey and dsn passed to init(): no RUM data is recorded until they are accepted.`
    );
  }

  private buildEndpoint(): string {
    const config = this.config.getConfig();

    if (!config) {
      return "";
    }

    // getEndpoint() upgrades a bare host to https://; using the raw dsn here
    // would hand the sender a scheme-less dsn, which resolves as a relative URL.
    return `${config.getEndpoint()}/json/rum`;
  }
}
