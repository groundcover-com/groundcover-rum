import { handleError } from "@groundcover/rum-core/common/error-handler";
import { safeWarn } from "@groundcover/rum-core/common/safe-warn";
import {
  SDKOptions,
  SDKConfigUpdate,
  EventTypes,
  PrivacyOptions,
  PrivacyLevel,
  Redactor,
  RedactField,
  RedactKind,
  ErrorReportingOptions,
  ErrorDeduplicationOptions,
} from "./config/types";
import { UserIdentifiers } from "@groundcover/rum-core/events/types";
import { SessionManager } from "./session-manager/session-manager";
import { Logger } from "./logger/logger";

export type {
  EventTypes,
  SDKOptions,
  PrivacyOptions,
  PrivacyLevel,
  Redactor,
  RedactField,
  RedactKind,
  ErrorReportingOptions,
  ErrorDeduplicationOptions,
};

declare global {
  interface Window {
    groundcover?: typeof groundcover;
  }
}

let manager: SessionManager | undefined;
let initializedAppId: string | undefined;
const logger = new Logger();


function init(params: {
  cluster?: string;
  environment?: string;
  namespace?: string;
  appId: string;
  releaseId?: string;
  user?: Partial<UserIdentifiers>;
  dsn?: string;
  options?: Partial<SDKOptions>;
  apiKey?: string;
  sessionId?: string;
}) {
  if (initializedAppId !== undefined) {
    return;
  }

  try {
    const appId = params?.appId;
    // Reading a caller's getter can synchronously complete another init.
    if (initializedAppId !== undefined) {
      return;
    }

    if (typeof appId !== "string" || appId.trim().length === 0) {
      safeWarn("[groundcover] init requires a nonblank appId; the SDK was not initialized.");
      return;
    }

    // Claim before reading other inputs or constructing callback-capable listeners.
    initializedAppId = appId;
    manager = new SessionManager({
      cluster: params.cluster || "",
      environment: params.environment || "",
      namespace: params.namespace,
      releaseId: params.releaseId,
      dsn: params.dsn || "",
      appId,
      user: params.user,
      apiKey: params.apiKey || "",
      options: params.options,
      sessionId: params.sessionId,
    });
    logger.manager = manager;
  } catch (error) {
    // Preserve an init completed inside the appId getter; otherwise allow retry.
    if (!manager) {
      initializedAppId = undefined;
    }
    handleError(error);
  }
}

function identifyUser(userIdentifier: Partial<UserIdentifiers>) {
  if (!manager) {
    console.warn(
      "[groundcover] identifyUser: groundcover is not initialized. please call init() first"
    );
    return;
  }

  manager.identifyUser(userIdentifier);
}

function sendCustomEvent(params: {
  event: string;
  attributes: Record<string, unknown>;
}) {
  if (!manager) {
    return;
  }

  manager.sendCustomEvent(params);
}

function captureException(error: unknown, metadata?: Record<string, unknown>) {
  if (!manager) {
    return;
  }

  manager.captureException(error, metadata);
}


function updateConfig(params: SDKConfigUpdate) {
  if (!manager) {
    return;
  }

  // Contained like init(): a malformed config (e.g. a throwing getter) must
  // never crash the host app through a public entry point.
  try {
    manager.updateConfig(params);
  } catch (error) {
    handleError(error);
  }
}

function startNavigation(metadata: Record<string, unknown>) {
  if (!manager) {
    console.warn(
      "[groundcover] startNavigation: groundcover is not initialized. please call init() first"
    );
    return;
  }

  manager.startNavigation(metadata);
}

function endNavigation(metadata: Record<string, unknown>) {
  if (!manager) {
    console.warn(
      "[groundcover] endNavigation: groundcover is not initialized. please call init() first"
    );
    return;
  }

  manager.endNavigation(metadata);
}

function getSessionId(): string {
  if (!manager) {
    console.warn(
      "[groundcover] getSessionId: groundcover is not initialized. please call init() first"
    );
    return "";
  }

  return manager.getSessionId();
}

async function setSessionId(newSessionId?: string) {
  if (!manager) {
    console.warn(
      "[groundcover] setSessionId: groundcover is not initialized. please call init() first"
    );
    return;
  }

  try {
    await manager.setSessionId(newSessionId);
  } catch (error) {
    console.error("[groundcover] setSessionId: failed to set session ID:", error);
  }
}

function startReplayRecording() {
  if (!manager) {
    console.warn(
      "[groundcover] startReplayRecording: groundcover is not initialized. please call init() first"
    );
    return;
  }

  manager.startReplayRecording();
}

function stopReplayRecording() {
  if (!manager) {
    console.warn(
      "[groundcover] stopReplayRecording: groundcover is not initialized. please call init() first"
    );
    return;
  }

  manager.stopReplayRecording();
}

const groundcover = {
  init,
  identifyUser,
  sendCustomEvent,
  captureException,
  logger,
  updateConfig,
  startNavigation,
  endNavigation,
  getSessionId,
  setSessionId,
  startReplayRecording,
  stopReplayRecording,
};

if (typeof window !== 'undefined' && !window.groundcover) {
  try {
    window.groundcover = groundcover;
  } catch (error) {
    // ignore error
    console.warn('[groundcover] Failed to expose groundcover on window:', error);
  }
}

export default groundcover;
