import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { BrowserRouter, Routes, Route } from "react-router";

import groundcover from "@groundcover/browser";

// Named redactors selectable from the URL config (functions can't be JSON-
// serialized). `marker` overrides the `username` leaf so e2e can assert the
// per-field hook ran; every other field defers to the SDK default (undefined).
const REDACTORS: Record<string, (field: { key: string }) => unknown> = {
  marker: (field) => (field.key === "username" ? "CUSTOM_REDACTED" : undefined),
};

const BASE_OPTIONS = {
  transport: { compression: false },
  debug: true,
  enabledEvents: ["dom", "exceptions", "logs", "pageload", "navigation", "performance", "replay", "network"],
  sessionMaxDuration: 60_000,
};

// Default privacy config (used when no ?gcp= override is present). Privacy is
// ON by default (mask-sensitive); set explicitly to exercise custom extensions.
const DEFAULT_PRIVACY = {
  level: "mask-sensitive",
  sensitiveKeys: ["playground_secret"],
  maskSelectors: [".gc-mask"],
};

// Merge an override onto the base options the way the SDK itself does: nested
// option groups merge one level deep, so a partial override (e.g. only
// `transport.batchSize`) doesn't wipe sibling defaults like
// `transport.compression`. Top-level scalars/arrays replace wholesale.
const NESTED_OPTION_KEYS = ["transport", "privacy", "tracing", "replay", "errors"] as const;
function mergeOptions(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...override };
  for (const key of NESTED_OPTION_KEYS) {
    const inc = override[key];
    if (inc && typeof inc === "object" && !Array.isArray(inc)) {
      merged[key] = { ...(base[key] as object | undefined), ...(inc as object) };
    }
  }
  return merged;
}

// E2E hook: `?gcp=<base64 JSON>` overrides the options so each spec can boot the
// SDK with a specific config. Shape:
//   { privacy?: {..., redactorName?: keyof REDACTORS}, errors?: {...}, ... }
// Without the param, the default config above is used (existing specs rely on it).
function buildOptions() {
  const raw = new URLSearchParams(window.location.search).get("gcp");
  if (!raw) return { ...BASE_OPTIONS, privacy: DEFAULT_PRIVACY };
  try {
    const override = JSON.parse(atob(raw));
    if (override.privacy?.redactorName) {
      override.privacy.redact = REDACTORS[override.privacy.redactorName];
      delete override.privacy.redactorName;
    }
    // Merge override onto the base; when it omits `privacy`, privacy defaults to
    // mask-sensitive via resolvePrivacy.
    return mergeOptions(BASE_OPTIONS, override);
  } catch {
    return { ...BASE_OPTIONS, privacy: DEFAULT_PRIVACY };
  }
}

groundcover.init({
  cluster: "playground",
  environment: "development",
  dsn: "http://localhost:3000",
  appId: "playground",
  apiKey: "playground-key",
  releaseId: "v1.0.0-playground",
  options: buildOptions(),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App title="groundcover SDK Playground" />} />
        <Route path="/other-page" element={<App title="Another Page" />} />
        <Route path="/#/other-page" element={<App title="# Another Page" />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
