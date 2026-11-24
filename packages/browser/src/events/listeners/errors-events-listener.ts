import { handleError } from "@groundcover/rum-core/common/error-handler";
import { _globalThis } from "../../common/global";
import { EnrichedEvent } from "@groundcover/rum-core/events/types";

import { BaseListener } from "@groundcover/rum-core/events/listeners/base-listener";
import {
  shapeErrorEvent,
  type ErrorCaptureOptions,
} from "@groundcover/rum-core/events/errors/shape-error";
import {
  capturedError,
  className,
  coerceToError,
} from "@groundcover/rum-core/events/errors/coerce-error";
import {
  disableCallbackWrapping,
  enableCallbackWrapping,
  forgetRethrown,
  takeLastRethrown,
} from "./callback-wrapping";

// Uncaught errors and unhandled rejections from the window listeners, and
// whatever the app passes to captureException. The two entries stay apart:
// the listeners report only real error and rejection events, while
// captureException accepts any value. While live, the app's timer, animation
// frame and listener callbacks are wrapped, so an error the browser hides can
// still be reported (see callback-wrapping.ts).
export class ErrorsEventsListener extends BaseListener {
  initialize() {
    _globalThis?.addEventListener("error", this.handleEvent);
    _globalThis?.addEventListener("unhandledrejection", this.handleEvent);
    // After the window listeners above, so they aren't wrapped themselves.
    enableCallbackWrapping(this);
  }

  destroy() {
    disableCallbackWrapping(this);
    _globalThis?.removeEventListener("error", this.handleEvent);
    _globalThis?.removeEventListener("unhandledrejection", this.handleEvent);
  }

  handleEvent = (event: Event) => {
    this.logger.log("[errors-events-listener.handleEvent] called");

    try {
      const error = isErrorEvent(event)
        ? errorFromWindowError(event)
        : event.type === "unhandledrejection"
          ? errorFromRejectionEvent(event)
          : null;
      // Anything else is a plain "error" Event a page dispatched or bubbled
      // up, not an error report.
      if (error) this.queueEvent(this.buildEvent(error, { handled: false }));
    } catch (error) {
      handleError(error);
    }
  };

  captureException(value: unknown, metadata?: Record<string, unknown>) {
    this.logger.log("[errors-events-listener.captureException] called");

    try {
      const error = errorFromCapturedValue(value);
      this.queueEvent(this.buildEvent(error, { handled: true, metadata }));
    } catch (error) {
      handleError(error);
    }
  }

  buildEvent(error: Error, config?: ErrorCaptureOptions) {
    return this.enricher.enrich(
      shapeErrorEvent(error, config, this.config.getPrivacy())
    );
  }

  queueEvent(event: EnrichedEvent) {
    try {
      this.logger.log("[errors-events-listener.queueEvent] called");

      if (event) {
        this.eventsPool.addEvent(event);
      }
    } catch (error) {
      handleError(error);
    }
  }
}

// Every `instanceof` on a DOM type is typeof-guarded: not every runtime has
// them (happy-dom lacks PromiseRejectionEvent), and a bare `instanceof` on a
// missing global throws.
function isErrorEvent(value: unknown): value is ErrorEvent {
  return typeof ErrorEvent !== "undefined" && value instanceof ErrorEvent;
}

function isEvent(value: unknown): value is Event {
  return typeof Event !== "undefined" && value instanceof Event;
}

// An uncaught error. `event.error` is whatever was thrown (`throw "boom"`
// puts the bare value there, `throw 0` a falsy one). It is null only when the
// browser hides a cross-origin script's error, which arrives as the message
// "Script error." and carries nothing worth reporting.
function errorFromErrorEvent(event: ErrorEvent): Error | null {
  const thrown: unknown = event.error;
  if (thrown == null) {
    if (isHiddenError(event)) return null;
    return atThrowSite(new Error(event.message || "Unknown error"), event);
  }
  return errorFromThrown(thrown, event);
}

// What the window "error" listener reports. An error the browser hid is
// reported as the value a callback wrapper caught and rethrew just before the
// event (see callback-wrapping.ts); with no such value, a hidden error is
// still dropped.
function errorFromWindowError(event: ErrorEvent): Error | null {
  if (event.error == null && isHiddenError(event)) {
    const recovered = takeLastRethrown();
    return recovered ? errorFromThrown(recovered.value, event) : null;
  }
  forgetRethrown(event.error);
  return errorFromErrorEvent(event);
}

function isHiddenError(event: ErrorEvent): boolean {
  return /^Script error\.?$/.test(event.message || "");
}

function errorFromThrown(thrown: unknown, event: ErrorEvent): Error {
  const error = coerceToError(thrown);
  // The SDK built this Error, so its own stack would point into the SDK.
  // Use the throw site instead, unless the thrown value brought a stack.
  return error === thrown || hasStack(thrown) ? error : atThrowSite(error, event);
}

// A value the app passed to captureException. An error or rejection event is
// reported by what it carries; any other DOM Event is described.
function errorFromCapturedValue(value: unknown): Error {
  if (isErrorEvent(value)) {
    return errorFromErrorEvent(value) ?? new Error(value.message || "Unknown error");
  }
  if (isEvent(value)) {
    const rejection = value.type === "unhandledrejection" ? errorFromRejectionEvent(value) : null;
    return rejection ?? describeEvent(value);
  }
  return coerceToError(value);
}

// An unhandled rejection. A native PromiseRejectionEvent carries `reason`;
// Bluebird dispatches a CustomEvent with the reason on `reason` and on
// `detail.reason`. An event with neither isn't a rejection report.
function errorFromRejectionEvent(event: Event): Error | null {
  const rejection = event as Event & { reason?: unknown; detail?: { reason?: unknown } };
  const isNative =
    typeof PromiseRejectionEvent !== "undefined" && event instanceof PromiseRejectionEvent;
  if (isNative || "reason" in rejection) {
    return coerceToError(rejection.reason, "UnhandledRejection");
  }
  const detail = rejection.detail;
  if (detail && typeof detail === "object" && "reason" in detail) {
    return coerceToError(detail.reason, "UnhandledRejection");
  }
  return null;
}

// A DOM Event the app passed to captureException (an image's or a socket's
// onerror). Its own fields carry nothing, so describe it by its class, type
// and target, and send the target's address (see addressOf) as metadata.
function describeEvent(event: Event): Error {
  try {
    const cls = className(event);
    const type = typeof event.type === "string" ? event.type : "";
    const target = event.target as (EventTarget & Record<string, unknown>) | null;
    let targetName = "";
    let address = "";
    if (target && typeof target === "object") {
      targetName = typeof target.nodeName === "string" ? target.nodeName.toLowerCase() : className(target);
      const getAttribute = target.getAttribute;
      const raw =
        typeof getAttribute === "function"
          ? getAttribute.call(target, "src") ?? getAttribute.call(target, "href")
          : target.url;
      if (typeof raw === "string") address = addressOf(raw);
    }
    const details = [type && `type=${type}`, targetName && `target=${targetName}`].filter(Boolean).join(", ");
    const message = `${cls} captured as exception${details ? ` (${details})` : ""}`;
    const value: Record<string, string> = {};
    if (type) value.type = type;
    if (targetName) value.target = targetName;
    if (address) value.src = address;
    return capturedError(message, "Error", value);
  } catch {
    return coerceToError(event);
  }
}

// The address as scheme://host/path: no credentials (`user:pass@`), query or
// fragment, any of which can hold a secret. A data: or blob: address keeps
// only its scheme, since the rest is the resource's content.
function addressOf(raw: string): string {
  try {
    const url = new URL(raw, _globalThis?.location?.href);
    if (/^(https?|wss?|file):$/.test(url.protocol)) {
      return `${url.protocol}//${url.host}${url.pathname}`;
    }
    return url.protocol;
  } catch {
    return "";
  }
}

function hasStack(value: unknown): boolean {
  try {
    return typeof value === "object" && value !== null && typeof (value as { stack?: unknown }).stack === "string";
  } catch {
    return false;
  }
}

// One V8-style frame at the location the browser reported, or no frames at
// all when it reported none.
function atThrowSite(error: Error, event: ErrorEvent): Error {
  const { filename, lineno, colno } = event;
  error.stack = filename
    ? `${error.name}: ${error.message}\n    at ${filename}:${lineno || 0}:${colno || 0}`
    : "";
  return error;
}
