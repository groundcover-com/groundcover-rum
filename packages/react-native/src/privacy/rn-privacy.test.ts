import { describe, it, expect } from "vitest";
import { ConfigManager } from "@groundcover/rum-core";
import type { PrivacyOptions } from "../config/types";
import { resolveRNPrivacy } from "./rn-privacy";

function manager(privacy?: PrivacyOptions) {
  const config = new ConfigManager();
  config.initialize({ dsn: "d", apiKey: "k", cluster: "c", environment: "e", appId: "a", options: { privacy } });
  return config;
}

describe("resolveRNPrivacy", () => {
  it("layers maskInteractionLabels over core's resolved privacy", () => {
    const privacy = resolveRNPrivacy(manager({ sensitiveKeys: ["tenant"] }));
    expect(privacy.maskInteractionLabels).toBe(false);
    expect(privacy.sensitiveKeys).toEqual(["tenant"]);
  });

  it("masks labels when asked, or under mask-all", () => {
    expect(resolveRNPrivacy(manager({ maskInteractionLabels: true })).maskInteractionLabels).toBe(true);
    expect(resolveRNPrivacy(manager({ level: "mask-all" })).maskInteractionLabels).toBe(true);
  });

  it("follows a runtime privacy update", () => {
    const config = manager();
    config.updateConfig({ options: { privacy: { maskInteractionLabels: true } } } as never);
    expect(resolveRNPrivacy(config).maskInteractionLabels).toBe(true);
  });
});
