import { Dimensions, PixelRatio, Platform } from "react-native";
import { handleError, type ConfigManager, type DeviceAttributesProvider } from "@groundcover/rum-core";

import type { ScreenAttributes, ScreenChange, ScreenHolder } from "../events/rn-event-types";
import type { RNSessionAttributes } from "../config/types";
import { loadExpoConstants } from "./optional-modules";
import { loadNativeModule } from "./native-bridge";
import { reportSafely } from "../internal/report-safely";

// Device/app metadata provider + the current-screen holder — RN's answers to the
// browser's getWebDeviceAttributes and makeWebViewProvider. The pool spreads the
// device attributes verbatim into session attributes.
//
// `source` is a FIXED SDK-family stamp ("mobile-rum") consumers key on to tell
// mobile RUM from web RUM; the actual platform lives in `os.name`, so
// ios-vs-android is a separate dimension. Every read is guarded — a metadata
// failure must never break event delivery.

type ExpoConstants = {
  expoConfig?: { version?: string; ios?: { buildNumber?: string }; android?: { versionCode?: number } };
  applicationId?: string;
};

function getAppMetadata(config: ConfigManager): { version?: string; build?: string; id?: string } {
  const options = config.getConfig()?.options as
    | { appVersion?: string; appBuild?: string }
    | undefined;
  const appId = config.getConfig()?.appId;

  let version = options?.appVersion;
  let build = options?.appBuild;

  if (!version || !build) {
    const mod = loadExpoConstants<{ default?: ExpoConstants } | ExpoConstants>();
    const constants = (mod && "default" in mod ? mod.default : mod) as ExpoConstants | null;
    version = version ?? constants?.expoConfig?.version;
    build =
      build ??
      constants?.expoConfig?.ios?.buildNumber ??
      (constants?.expoConfig?.android?.versionCode != null
        ? String(constants.expoConfig.android.versionCode)
        : undefined);
  }

  const app: { version?: string; build?: string; id?: string } = {};
  if (version) app.version = version;
  if (build) app.build = build;
  if (appId) app.id = appId;
  return app;
}

type OsDevice = Pick<RNSessionAttributes, "os" | "device">;

/** Cached once resolved. A device does not change model mid-process. */
let cachedNativeModel: string | undefined;
/** Same for the Android codename (`Build.DEVICE`); constant for the process. */
let cachedNativeCodename: string | undefined;

/**
 * The hardware model from the native module's exported constants — `uname()`'s `utsname.machine`,
 * e.g. `"iPhone17,1"`, the standard hardware identifier for an Apple device.
 *
 * This exists because RN's iOS `Platform.constants` has no model at all: it carries
 * forceTouchAvailable, interfaceIdiom, isTesting, osVersion, reactNativeVersion and systemName, and
 * that is the whole set. Android's carries Model/Brand/Manufacturer, so without this
 * `device.model` would be right there and permanently `"unknown"` on iOS.
 *
 * Only a HIT is cached. Caching the miss would turn "the module was not registered yet on the very
 * first event" into "this process reports no model, ever" — an assumption with no recovery, traded
 * against one property read per event.
 */
function nativeDeviceModel(): string | undefined {
  if (cachedNativeModel !== undefined) return cachedNativeModel;
  try {
    // A native constant is marshalled bridge data like Platform.constants, so it gets the same
    // treatment: a non-string or a blank is no answer. A blank would be worse than "unknown",
    // reading as a real value that nothing can group by.
    const value = (loadNativeModule() as { deviceModel?: unknown } | null)?.deviceModel;
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    cachedNativeModel = trimmed;
    return trimmed;
  } catch (error) {
    handleError(error);
    return undefined;
  }
}

/**
 * The Android device codename from the native module's exported constants — `Build.DEVICE`, e.g.
 * `"o1s"` (Galaxy S21). Android-only: iOS does not export it, since its model IDENTIFIER already
 * keys the marketing-name lookup. Same marshalled-bridge discipline as `nativeDeviceModel` — a
 * non-string or blank is no answer — and only a HIT is cached, so a not-yet-registered module on
 * the first event does not become "no codename, ever".
 */
function nativeDeviceCodename(): string | undefined {
  if (cachedNativeCodename !== undefined) return cachedNativeCodename;
  try {
    const value = (loadNativeModule() as { deviceCodename?: unknown } | null)?.deviceCodename;
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    cachedNativeCodename = trimmed;
    return trimmed;
  } catch (error) {
    handleError(error);
    return undefined;
  }
}

/** Test-only: clears BOTH device memos so a spec can drive the absent and present paths. */
export function __resetDeviceModelCache(): void {
  cachedNativeModel = undefined;
  cachedNativeCodename = undefined;
}

// os/device come from RN's Platform/Dimensions with a per-field fallback and are
// declared REQUIRED on RNSessionAttributes, so they are built with their own
// guard that ALWAYS returns them (safe unknowns on failure) — never dropped.
function getOsAndDevice(): OsDevice {
  // Platform.OS is RN's broad union (ios/android/windows/macos/web); this SDK
  // targets the mobile platforms, so map anything else to "other" at RUNTIME
  // rather than asserting a type the value may not hold — a web/macos host would
  // otherwise report a false "ios"/"android" and pollute the os.name dimension.
  const osName: "ios" | "android" | "other" =
    Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "other";
  const os = { name: osName, version: String(Platform.Version) };
  try {
    const constants = (Platform.constants ?? {}) as Record<string, unknown>;
    // Platform.constants is a native-bridge payload — a field can be a non-string
    // (e.g. a numeric Model on some OEM builds). Guard on the VALUE's type, not
    // just null/undefined: a bare `??` with an `as string` would pass a number
    // straight through onto the wire in a string-typed field.
    // Guard the VALUE's type AND its emptiness: a blank or whitespace-only string is still a
    // string, so a bare type check would let it win the ?? chain and put an empty `device.model`
    // on the wire — worse than "unknown", which at least groups. Return the TRIMMED value so
    // surrounding whitespace never reaches the wire either.
    const str = (v: unknown): string | undefined => {
      if (typeof v !== "string") return undefined;
      const trimmed = v.trim();
      return trimmed === "" ? undefined : trimmed;
    };
    // Platform.constants FIRST, native second. Android's constants are authoritative there and
    // need no bridge value; if native won, an OEM's real Model would be replaced by whatever the
    // engine reported — a regression invisible on iOS, which has nothing to lose the race to.
    const model = str(constants.Model) ?? str(constants.model) ?? nativeDeviceModel() ?? "unknown";
    const brand =
      str(constants.Brand) ??
      str(constants.brand) ??
      (osName === "ios" ? "Apple" : "unknown");

    const screen = Dimensions.get("screen");

    const device: OsDevice["device"] = {
      model,
      brand,
      screen: {
        width: screen.width,
        height: screen.height,
        scale: screen.scale ?? PixelRatio.get(),
        fontScale: screen.fontScale ?? PixelRatio.getFontScale(),
      },
    };
    // Android only — omitted (not blank) when absent, so iOS and older binaries carry no empty
    // codename that would read as a real value nothing can group by.
    const codename = nativeDeviceCodename();
    if (codename) device.codename = codename;

    return { os, device };
  } catch (error) {
    handleError(error);
    return {
      os,
      device: { model: "unknown", brand: "unknown", screen: { width: 0, height: 0, scale: 1, fontScale: 1 } },
    };
  }
}

export function getRNDeviceAttributes(config: ConfigManager): DeviceAttributesProvider {
  return () => {
    // os/device are always present (see getOsAndDevice). Only app metadata reads
    // the optional expo-constants peer, so ONLY that is guarded here — a failure
    // there must not drop the required os/device fields from the session envelope.
    let app: { version?: string; build?: string; id?: string } = {};
    try {
      app = getAppMetadata(config);
    } catch (error) {
      handleError(error);
    }
    return { source: "mobile-rum", ...getOsAndDevice(), app };
  };
}

export function createScreenHolder(): ScreenHolder {
  let current: ScreenAttributes = { name: "", key: "" };
  const listeners = new Set<(change: ScreenChange) => void>();
  return {
    get: () => current,
    set: (screen: ScreenAttributes) => {
      const outgoing = current;
      const isFirstScreen = !outgoing.name;
      // Make the new screen current BEFORE notifying, so `get()` inside a listener returns it.
      current = screen;
      const change: ScreenChange = { outgoing, incoming: screen, isFirstScreen };
      // Snapshot the set: a listener may unsubscribe mid-notify. Isolate each — set() runs on
      // every navigation, so one listener's throw must not break the others or the navigation.
      //
      // `reportSafely`, not `handleError`: the reporter reaches a host console other
      // monitors patch, so it can throw too — and a throw HERE lands in the host's navigation
      // dispatch, which is the one thing this loop exists to protect. Guarded on the holder rather
      // than at each call site, so every subscriber inherits it.
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch (error) {
          reportSafely(error);
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
