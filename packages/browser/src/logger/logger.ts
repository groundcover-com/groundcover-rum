import { LogLevel } from "@groundcover/rum-core/events/types";
import { SessionManager } from "../session-manager/session-manager";

export class Logger {
  constructor(public manager?: SessionManager) {}

  private emit(
    level: LogLevel,
    message: string,
    attributes?: Record<string, unknown>
  ): void {
    if (!this.manager) return;
    this.manager.emitLog(message, level, attributes);
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
