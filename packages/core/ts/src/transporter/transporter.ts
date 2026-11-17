import { ConfigManager } from "../config/config-manager";
import { Batch } from "../events/types";
import { Logger } from "../common/logger";
import { safeWarn } from "../common/safe-warn";
import { encodeUtf8 } from "../common/utf8";
import { gzipSync } from "fflate";

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
// UTF-8 goes through `encodeUtf8`, never a bare `TextEncoder`: that global is
// not present on every host this runs on. It is exact either way, emoji
// included (see common/utf8.ts).
export function encodeInline(data: string, enableCompression: boolean): EncodedPayload {
  const byteArray = encodeUtf8(data);
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
// rejection is logged, and a resolved fetch-like response (`{ ok, status }`)
// that is not 2xx is reported, because fetch resolves rather than rejects on
// 4xx and 5xx. A sender that resolves with anything else is not inspected.
export type BatchSender = (endpoint: string, request: BatchRequest) => Promise<unknown>;

// Statuses that mean the endpoint refuses this SDK's credentials. Every batch
// after one of these is refused the same way, so the app records nothing until
// the apiKey or dsn is fixed: that warrants a warning outside debug mode.
const CREDENTIAL_REJECTIONS = new Set([401, 403]);

function rejectedStatus(response: unknown): number | null {
  if (typeof response !== "object" || response === null) return null;
  const { ok, status } = response as { ok?: unknown; status?: unknown };
  return ok === false && typeof status === "number" ? status : null;
}

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
  // Credential rejections already warned about: one warning per status is
  // enough to act on, and a batch goes out every few seconds.
  private readonly warnedStatuses = new Set<number>();

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

      this.sendBatch(endpoint, {
        method: "POST",
        headers,
        body: finalData,
      })
        .then(response => this.reportRejection(response, endpoint))
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

  // A non-2xx means the batch was refused and its events are gone: log it in
  // debug mode, and warn even without debug when the endpoint refuses the
  // credentials, since that silently drops every batch.
  private reportRejection(response: unknown, endpoint: string): void {
    const status = rejectedStatus(response);
    if (status === null) return;

    this.logger.log(`Batch rejected by ${endpoint} with HTTP ${status}`, { groundcoverIgnore: true });

    if (CREDENTIAL_REJECTIONS.has(status) && !this.warnedStatuses.has(status)) {
      this.warnedStatuses.add(status);
      safeWarn(
        `[groundcover] ${endpoint} rejected a batch with HTTP ${status}. Check the apiKey and dsn passed to init(): no RUM data is recorded until they are accepted.`
      );
    }
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
