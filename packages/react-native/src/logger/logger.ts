import { handleError, type LogLevel } from "@groundcover/rum-core";

// The public `groundcover.logger` surface. Thin by design: it forwards to a sink
// (the composition root's ManualEventEmitter once ready, or the pre-ready queue
// before that) supplied via `setSink`. Mirrors the browser logger's delegation.
export type LogSink = (
  message: string,
  level: LogLevel,
  attributes?: Record<string, unknown>
) => void;

export class RNLogger {
  private sink: LogSink | null = null;

  setSink(sink: LogSink | null): void {
    this.sink = sink;
  }

  private emit(level: LogLevel, message: string, attributes?: Record<string, unknown>): void {
    // A publicly configurable sink must never crash the host via logger.*.
    try {
      this.sink?.(message, level, attributes);
    } catch (error) {
      handleError(error);
    }
  }

  log(message: string, attributes?: Record<string, unknown>): void {
    this.emit("log", message, attributes);
  }
  info(message: string, attributes?: Record<string, unknown>): void {
    this.emit("info", message, attributes);
  }
  warn(message: string, attributes?: Record<string, unknown>): void {
    this.emit("warn", message, attributes);
  }
  error(message: string, attributes?: Record<string, unknown>): void {
    this.emit("error", message, attributes);
  }
  debug(message: string, attributes?: Record<string, unknown>): void {
    this.emit("debug", message, attributes);
  }
  trace(message: string, attributes?: Record<string, unknown>): void {
    this.emit("trace", message, attributes);
  }
}
