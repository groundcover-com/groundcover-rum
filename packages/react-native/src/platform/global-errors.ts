import { reportSafely } from "../internal/report-safely";

type Handler = (error: unknown, fatal?: boolean) => void;

type ErrorUtils = {
  getGlobalHandler?: () => Handler | undefined;
  setGlobalHandler?: (handler: Handler) => void;
};

export function observeGlobalErrors(capture: Handler): () => void {
  try {
    const utils = (globalThis as { ErrorUtils?: ErrorUtils }).ErrorUtils;
    if (typeof utils?.getGlobalHandler !== "function" || typeof utils.setGlobalHandler !== "function") {
      return () => {};
    }
    const previous = utils.getGlobalHandler();
    let active = true;
    const handler: Handler = (error, fatal) => {
      try {
        if (active) capture(error, fatal);
      } catch (failure) {
        reportSafely(failure);
      } finally {
        previous?.(error, fatal);
      }
    };
    utils.setGlobalHandler(handler);
    return () => {
      active = false;
      try {
        if (utils.getGlobalHandler?.() === handler) utils.setGlobalHandler?.(previous ?? (() => {}));
      } catch (failure) {
        reportSafely(failure);
      }
    };
  } catch (failure) {
    reportSafely(failure);
    return () => {};
  }
}
