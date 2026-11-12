import { EnrichedEvent, CoreEventType } from "../types";
import { BaseListener } from "./base-listener";
import { handleError } from "../../common/error-handler";
import { truncate } from "../../common/text";
import { redactLogFields } from "../../privacy/redaction";

const levels = ["log", "info", "warn", "error", "debug", "assert", "trace"] as const;
type ConsoleLevel = (typeof levels)[number];

type ConsoleMethodFunction = (...args: unknown[]) => void;

// Console capture is platform-agnostic, but a platform composes it against its
// OWN pool (`EventsPool<CoreEventType | TExtra>`); `TExtra` threads that pool
// type through BaseListener (default `string` — see base-listener.ts).
// Emits only `"log"` events regardless of TExtra.
export class LogEventsListener<TExtra extends string = string> extends BaseListener<TExtra> {
  private originalConsole: Record<ConsoleLevel, ConsoleMethodFunction> | null = null;
  // The exact wrapper we installed per level, remembered so destroy() can tell
  // "still ours" from "a host wrapped us". Null until initialize() / after destroy().
  private patchedConsole: Partial<Record<ConsoleLevel, ConsoleMethodFunction>> | null = null;
  private isInitialized = false;

  initialize(): void {
    if (this.isInitialized) {
      return;
    }

    try {
      this.originalConsole = this.captureConsoleMethods();
      const patched: Partial<Record<ConsoleLevel, ConsoleMethodFunction>> = {};

      levels.forEach((level) => {
        if (!(level in console)) {
          return;
        }

        // Use type assertion to handle the different console method signatures
        const wrapped = ((...args: unknown[]): void => {
          try {
            // A host may wrap console[level] on top of us and delegate down, so
            // our wrapper stays reachable after destroy() (guarded restore leaves
            // the host's wrapper in place). Once torn down, capture nothing —
            // but still forward to the original so the host chain is unbroken.
            if (this.isInitialized) {
              this.handleEvent(args, level);
            }
          } catch (error) {
            handleError(error);
          } finally {
            if (this.originalConsole?.[level]) {
              this.originalConsole[level](...args);
            }
          }
        }) as unknown as typeof console[typeof level];

        console[level] = wrapped;
        patched[level] = wrapped as unknown as ConsoleMethodFunction;
      });

      this.patchedConsole = patched;
      this.isInitialized = true;
    } catch (error) {
      handleError(error);
    }
  }

  destroy(): void {
    try {
      if (!this.isInitialized) {
        return;
      }

      levels.forEach((level) => {
        // Only unwrap where WE are STILL the current console method. If a host
        // (another monitoring lib / router) wrapped console[level] on top of us
        // after initialize(), leave their wrapper in place instead of restoring
        // the pre-SDK original — that would silently uninstall their
        // instrumentation. Mirrors the network listener's guarded restore.
        if (
          this.originalConsole?.[level] &&
          this.patchedConsole?.[level] &&
          console[level] === this.patchedConsole[level]
        ) {
          console[level] = this.originalConsole[
            level
          ] as (typeof console)[ConsoleLevel];
        }
      });

      this.patchedConsole = null;
      this.isInitialized = false;
    } catch (error) {
      handleError(error);
    }
  }

  handleEvent(args: unknown[], level: ConsoleLevel) {
    try {
      const normalizedArgs = Array.isArray(args) ? args : [args];

      // console.assert only emits when its FIRST arg (the condition) is falsy —
      // a passing assertion prints nothing. Mirror that here: a passed assert is
      // not a log, so never capture it. (Capturing it drowns the SDK in dev-time
      // noise — a host shim that asserts on every event of some chatty source
      // would otherwise storm this listener and peg the JS thread.)
      if (level === "assert" && normalizedArgs[0]) {
        return;
      }

      const message = this.formatMessage(normalizedArgs, level);

      if (!message || message?.includes("groundcoverIgnore")) {
        return;
      }

      const attributes = this.extractAttributes(normalizedArgs);

      const fullEvent = this.buildEvent({
        message,
        level,
        attributes,
      });

      this.queueEvent(fullEvent);
    } catch (error) {
      handleError(error);
    }
  }

  buildEvent({
    message,
    level,
    attributes,
  }: {
    message: string;
    level: ConsoleLevel;
    attributes?: Record<string, unknown>;
  }) {
    // The message is arbitrary concatenated text (not necessarily JSON), so it
    // is text-scrubbed; attributes are structured → deep key-based redaction.
    // Shared with the explicit groundcover.logger.* path (emitLog) so both
    // follow one masking contract.
    const { message: safeMessage, attributes: safeAttributes } = redactLogFields(
      this.config.getPrivacy(),
      message,
      attributes
    );

    return this.enricher.enrich({
      type: "log",
      attributes: {
        ...safeAttributes,
        message: truncate({ text: safeMessage }),
        level,
      },
    });
  }

  queueEvent(event: EnrichedEvent<CoreEventType | TExtra>) {
    try {
      this.logger.log("[logs-events-listener.queueEvent] called");

      if (event) {
        this.eventsPool.addEvent(event);
      }
    } catch (error) {
      handleError(error);
    }
  }

  private extractAttributes(args: unknown[]): Record<string, unknown> | undefined {
    if (!Array.isArray(args) || args.length === 0) {
      return undefined;
    }

    try {
      const merged: Record<string, unknown> = {};

      for (const arg of args) {
        if (
          arg !== null &&
          typeof arg === "object" &&
          Object.prototype.toString.call(arg) === "[object Object]"
        ) {
          Object.assign(merged, arg as Record<string, unknown>);
        }
      }

      // Strip keys reserved by the log-event contract: message/level are
      // stamped by buildEvent; the platform's keys are stamped by the enricher.
      delete merged.message;
      delete merged.level;
      for (const key of this.enricher.reservedAttributeKeys) delete merged[key];

      return merged;
    } catch (error) {
      handleError(error);
      return undefined;
    }
  }

  private formatMessage(args: unknown[], level?: ConsoleLevel): string {
    if (!Array.isArray(args)) {
      return String(args);
    }

    try {
      return args
        .map((arg) => {
          if (arg === undefined) return "undefined";
          if (arg === null) return "null";

          if (typeof arg === "object") {
            if (arg instanceof Error) {
              try {
                // Include stack trace only for error level logs
                if (level === "error") {
                  return arg.stack || arg.toString();
                } else {
                  return arg.toString();
                }
              } catch {
                try {
                  const errorInfo = {
                    name: arg.name,
                    message: arg.message,
                    stack: arg.stack,
                  };
                  return JSON.stringify(errorInfo);
                } catch {
                  return Object.prototype.toString.call(arg);
                }
              }
            }
            
            try {
              return JSON.stringify(arg);
            } catch {
              return Object.prototype.toString.call(arg);
            }
          }
          return String(arg);
        })
        .join(" ");
    } catch (error) {
      handleError(error);
      return "[Error formatting console message]";
    }
  }
  
  private captureConsoleMethods(): Record<ConsoleLevel, ConsoleMethodFunction> {
    const methods: Partial<Record<ConsoleLevel, ConsoleMethodFunction>> = {};

    try {
      levels.forEach((level) => {
        if (console && typeof console[level] === "function") {
          methods[level] = console[level].bind(console) as ConsoleMethodFunction;
        }
      });
    } catch (error) {
      handleError(error);
    }

    return methods as Record<ConsoleLevel, ConsoleMethodFunction>;
  }
}
