import { Logger } from "./logger";

const logger = Logger.getInstance();

function handleError(error: Error | string | unknown) {
  logger.log("[error-handler.handleError] called", error, {
    groundcoverIgnore: true,
  });
}

export { handleError };