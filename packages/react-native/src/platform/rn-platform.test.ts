import { describe, it, expect, afterEach } from "vitest";
import { ConfigManager } from "@groundcover/rum-core";
import { getRNDeviceAttributes, createScreenHolder, __resetDeviceModelCache } from "./rn-platform";
import { __reset, __setNativeModule, Platform } from "../test-utils/react-native-stub";
import { NATIVE_MODULE_NAME } from "./native-types";

function config(): ConfigManager {
  const c = new ConfigManager();
  c.initialize({ dsn: "d", apiKey: "k", cluster: "c", environment: "e", appId: "a" });
  return c;
}

describe("getRNDeviceAttributes", () => {
  afterEach(() => {
    __reset();
    __resetDeviceModelCache();
  });

  it("stamps a fixed source and the real platform in os/device", () => {
    const attrs = getRNDeviceAttributes(config())();
    expect(attrs.source).toBe("mobile-rum");
    const os = attrs.os as { name: string; version: string };
    expect(os.name).toBe("ios");
    expect(os.version).toEqual(expect.any(String));
    const device = attrs.device as {
      model: string;
      brand: string;
      screen: { width: number; height: number; scale: number; fontScale: number };
    };
    expect(device.model).toEqual(expect.any(String));
    expect(device.brand).toEqual(expect.any(String));
    expect(device.screen.width).toBeGreaterThan(0);
    expect(device.screen.height).toBeGreaterThan(0);
  });

  it("reflects Android when Platform.OS changes", () => {
    Platform.OS = "android";
    const attrs = getRNDeviceAttributes(config())();
    expect((attrs.os as { name: string }).name).toBe("android");
    // source stays constant — it identifies the SDK family, not the platform.
    expect(attrs.source).toBe("mobile-rum");
  });

  it("maps a non-mobile Platform.OS to \"other\" instead of mislabeling it", () => {
    // Platform.OS is a 5-member union; the SDK targets ios/android and must
    // narrow anything else at RUNTIME, not assert a type the value doesn't hold.
    Platform.OS = "web";
    const attrs = getRNDeviceAttributes(config())();
    expect((attrs.os as { name: string }).name).toBe("other");
  });

  it("rejects a non-string Model/Brand from the native bridge (guards the ?? fallback)", () => {
    // Platform.constants is a native-bridge payload; a numeric Model on some
    // OEM builds must not slip past `??` (which only guards null/undefined) onto
    // the wire as a number in a string field.
    Platform.constants = { Model: 12345, Brand: 42 };
    const attrs = getRNDeviceAttributes(config())();
    const device = attrs.device as { model: string; brand: string };
    expect(device.model).toBe("unknown");
    // ios brand fallback kicks in because the numeric Brand is rejected.
    expect(device.brand).toBe("Apple");
  });

  it("rejects a blank Model/Brand from the native bridge, not just a non-string one", () => {
    // A blank or whitespace-only constant is a string, so it slips past the type guard and wins
    // the ?? chain — putting an empty `device.model` on the wire, which is worse than "unknown":
    // it reads as a real value nobody can group by. Same discipline the native-module path already
    // applies to a blank `deviceModel`.
    Platform.constants = { Model: "   ", Brand: "" };
    const attrs = getRNDeviceAttributes(config())();
    const device = attrs.device as { model: string; brand: string };
    expect(device.model).toBe("unknown");
    expect(device.brand).toBe("Apple");
  });

  it("trims a real Model/Brand rather than shipping the surrounding whitespace", () => {
    Platform.OS = "android";
    Platform.constants = { Model: "  Pixel 8  ", Brand: " google " };
    const attrs = getRNDeviceAttributes(config())();
    const device = attrs.device as { model: string; brand: string };
    expect(device.model).toBe("Pixel 8");
    expect(device.brand).toBe("google");
  });

  // region device.model on iOS
  //
  // RN's iOS Platform.constants carries NO model: it has forceTouchAvailable, interfaceIdiom,
  // isTesting, osVersion, reactNativeVersion and systemName, and nothing else. Android's carries
  // Model/Brand/Manufacturer, so read from there alone `device.model` would be correct on Android
  // and permanently "unknown" on iOS. The model has to come from native (`uname()`'s
  // utsname.machine).
  //
  // The react-native stub mirrors the real iOS constants — no `model` — which is what makes the
  // assertions below mean anything: a stub that handed iOS a `model` would have every test here
  // exercise a shape iOS never produces.

  it("takes device.model from the native module on iOS, where Platform.constants has none", () => {
    expect(Platform.constants.model).toBeUndefined();
    expect(Platform.constants.Model).toBeUndefined();

    __setNativeModule(NATIVE_MODULE_NAME, { deviceModel: "iPhone17,1" });

    const attrs = getRNDeviceAttributes(config())();
    expect((attrs.device as { model: string }).model).toBe("iPhone17,1");
  });

  it("prefers Platform.constants over the native module, so Android is untouched", () => {
    // Android's constants are authoritative there and need no bridge round trip. If the native
    // constant ever won, an Android OEM's real Model would be replaced by whatever the engine
    // reported — a regression invisible on iOS, where there is nothing to lose the race to.
    Platform.OS = "android";
    Platform.constants = { Model: "Pixel 8", Brand: "google" };
    __setNativeModule(NATIVE_MODULE_NAME, { deviceModel: "should-not-win" });

    const attrs = getRNDeviceAttributes(config())();
    expect((attrs.device as { model: string }).model).toBe("Pixel 8");
  });

  it("falls back to unknown when neither the constants nor the native module have a model", () => {
    // Expo Go: no native module at all. "unknown" is the honest answer, and the SDK still reports.
    const attrs = getRNDeviceAttributes(config())();
    expect((attrs.device as { model: string }).model).toBe("unknown");
  });

  it("stamps device.codename from the Android native module's Build.DEVICE", () => {
    // Google's device catalog is keyed on codename + model to resolve a marketing name;
    // `Build.MODEL` ("SM-G991B") alone is ambiguous across regional variants, so the codename
    // ("o1s") is what disambiguates. It comes from OUR native module (Build.DEVICE), not RN's
    // Platform.constants, which does not carry it.
    Platform.OS = "android";
    Platform.constants = { Model: "SM-G991B", Brand: "samsung" };
    __setNativeModule(NATIVE_MODULE_NAME, { deviceCodename: "o1s" });

    const device = getRNDeviceAttributes(config())().device as { model: string; codename?: string };
    expect(device.model).toBe("SM-G991B");
    expect(device.codename).toBe("o1s");
  });

  it("omits device.codename when the native module has none (iOS / older binary)", () => {
    // iOS never sets it — its identifier is already the mapping key — so the field must be ABSENT,
    // not an empty string that reads as a real codename nobody can group by.
    __setNativeModule(NATIVE_MODULE_NAME, { deviceModel: "iPhone17,1" });
    const device = getRNDeviceAttributes(config())().device as { codename?: string };
    expect(device).not.toHaveProperty("codename");
  });

  it("rejects a non-string or blank codename from the native module", () => {
    Platform.OS = "android";
    Platform.constants = { Model: "SM-G991B", Brand: "samsung" };
    __setNativeModule(NATIVE_MODULE_NAME, { deviceCodename: "   " });
    expect(getRNDeviceAttributes(config())().device).not.toHaveProperty("codename");

    __resetDeviceModelCache();
    __setNativeModule(NATIVE_MODULE_NAME, { deviceCodename: 42 });
    expect(getRNDeviceAttributes(config())().device).not.toHaveProperty("codename");
  });

  it("rejects a non-string or blank deviceModel from the native module", () => {
    // Same bridge-payload discipline the Model/Brand guard above applies: a native constant is
    // marshalled data, and an empty string would put a blank model on the wire — worse than
    // "unknown", because it reads as a real value nobody can group by.
    __setNativeModule(NATIVE_MODULE_NAME, { deviceModel: "   " });
    expect((getRNDeviceAttributes(config())().device as { model: string }).model).toBe("unknown");

    __resetDeviceModelCache();
    __setNativeModule(NATIVE_MODULE_NAME, { deviceModel: 17 });
    expect((getRNDeviceAttributes(config())().device as { model: string }).model).toBe("unknown");
  });

  it("does not cache an absent native module, so a late registration is still picked up", () => {
    // The module is registered before JS runs in practice, but caching the MISS would make that
    // an assumption the SDK cannot recover from: every event for the rest of the process would
    // report "unknown" because of one early read. Caching only a hit costs one property lookup.
    expect((getRNDeviceAttributes(config())().device as { model: string }).model).toBe("unknown");

    __setNativeModule(NATIVE_MODULE_NAME, { deviceModel: "iPhone17,1" });
    expect((getRNDeviceAttributes(config())().device as { model: string }).model).toBe("iPhone17,1");
  });

  // endregion

  it("keeps the required os/device fields even when app-metadata resolution throws", () => {
    // A broken config makes getAppMetadata throw; the required os/device must
    // still be present (RNSessionAttributes' contract), never a source-only
    // envelope.
    const broken = {
      getConfig: () => {
        throw new Error("boom");
      },
    } as unknown as ConfigManager;

    const attrs = getRNDeviceAttributes(broken)();

    expect(attrs.source).toBe("mobile-rum");
    expect((attrs.os as { name: string }).name).toBe("ios");
    const device = attrs.device as { model: string; screen: { width: number } };
    expect(device.model).toEqual(expect.any(String));
    expect(device.screen.width).toBeGreaterThan(0);
    // app metadata failed → empty, but never drops os/device.
    expect(attrs.app).toEqual({});
  });
});

describe("createScreenHolder", () => {
  it("defaults to an empty screen and reflects the last set value", () => {
    const holder = createScreenHolder();
    expect(holder.get()).toEqual({ name: "", key: "" });
    holder.set({ name: "Checkout", key: "checkout-1" });
    expect(holder.get()).toEqual({ name: "Checkout", key: "checkout-1" });
  });

  it("notifies subscribers of the transition, with the new screen already current", () => {
    const holder = createScreenHolder();
    const changes: Array<{ outgoing: string; incoming: string; first: boolean; seen: string }> = [];
    holder.subscribe((c) =>
      changes.push({
        outgoing: c.outgoing.name,
        incoming: c.incoming.name,
        first: c.isFirstScreen,
        // `get()` inside a listener must already return the incoming screen.
        seen: holder.get().name,
      })
    );

    holder.set({ name: "Home", key: "h1" });
    holder.set({ name: "Cart", key: "c1" });

    expect(changes).toEqual([
      { outgoing: "", incoming: "Home", first: true, seen: "Home" },
      { outgoing: "Home", incoming: "Cart", first: false, seen: "Cart" },
    ]);
  });

  it("stops delivering after unsubscribe, and isolates a throwing listener", () => {
    const holder = createScreenHolder();
    const after: string[] = [];
    holder.subscribe(() => {
      throw new Error("listener blew up");
    });
    holder.subscribe((c) => after.push(c.incoming.name));

    // A throw from the first listener must not stop the second, nor escape set().
    expect(() => holder.set({ name: "Home", key: "h1" })).not.toThrow();
    expect(after).toEqual(["Home"]);

    const unsub = holder.subscribe((c) => after.push(`late:${c.incoming.name}`));
    unsub();
    holder.set({ name: "Cart", key: "c1" });
    expect(after).toEqual(["Home", "Cart"]); // no "late:Cart"
  });
});
