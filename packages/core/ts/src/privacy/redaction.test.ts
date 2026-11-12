import { describe, it, expect } from "vitest";
import {
  REDACTED,
  isSensitiveKey,
  redactHeaders,
  redactQueryString,
  redactUrl,
  redactBody,
  redactText,
  redactObject,
  redactLogFields,
} from "./redaction";

// Hand-rolled `application/x-www-form-urlencoded` reader (first value per
// key), so these tests assert on redaction output without a host
// URLSearchParams.
function parseQuery(query: string): { get(key: string): string | null } {
  const values = new Map<string, string>();
  for (const pair of query.replace(/^\?/, "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const decode = (v: string) => decodeURIComponent(v.replace(/\+/g, " "));
    const key = decode(eq === -1 ? pair : pair.slice(0, eq));
    if (!values.has(key)) values.set(key, eq === -1 ? "" : decode(pair.slice(eq + 1)));
  }
  return { get: (key) => values.get(key) ?? null };
}

describe("redaction", () => {
  describe("isSensitiveKey", () => {
    it("matches built-in sensitive patterns", () => {
      expect(isSensitiveKey("password")).toBe(true);
      expect(isSensitiveKey("user_token")).toBe(true);
      expect(isSensitiveKey("apiKey")).toBe(true);
      expect(isSensitiveKey("api-key")).toBe(true);
      expect(isSensitiveKey("Authorization")).toBe(true);
      expect(isSensitiveKey("creditCard")).toBe(true);
      expect(isSensitiveKey("cardNumber")).toBe(true);
    });

    it("does not over-match innocuous keys", () => {
      expect(isSensitiveKey("cardinality")).toBe(false);
      expect(isSensitiveKey("session_id")).toBe(false);
      expect(isSensitiveKey("username")).toBe(false);
      expect(isSensitiveKey("email")).toBe(false);
    });

    it("honors extra keys", () => {
      expect(isSensitiveKey("ssn")).toBe(true);
      expect(isSensitiveKey("internal_ref", ["internal_ref"])).toBe(true);
      expect(isSensitiveKey("internal_ref")).toBe(false);
    });
  });

  describe("redactHeaders", () => {
    it("redacts sensitive header names and patterns, keeps others", () => {
      const result = redactHeaders({
        Authorization: "Bearer abc",
        Cookie: "sid=1",
        "x-api-token": "secret",
        "Content-Type": "application/json",
        Accept: "*/*",
      });
      expect(result.Authorization).toBe(REDACTED);
      expect(result.Cookie).toBe(REDACTED);
      expect(result["x-api-token"]).toBe(REDACTED);
      expect(result["Content-Type"]).toBe("application/json");
      expect(result.Accept).toBe("*/*");
    });

    it("redacts header names containing a bare `key` substring", () => {
      // SENSITIVE_KEY_REGEX alone does not match a bare `key`, so these key
      // headers must still be caught at header level.
      const result = redactHeaders({
        "x-functions-key": "abc",
        "x-encryption-key": "def",
        "x-key": "ghi",
      });
      expect(result["x-functions-key"]).toBe(REDACTED);
      expect(result["x-encryption-key"]).toBe(REDACTED);
      expect(result["x-key"]).toBe(REDACTED);
    });
  });

  describe("redactQueryString", () => {
    it("redacts sensitive params and preserves the rest", () => {
      const out = redactQueryString("user=bob&token=abc123&page=2");
      const params = parseQuery(out);
      expect(params.get("user")).toBe("bob");
      expect(params.get("token")).toBe(REDACTED);
      expect(params.get("page")).toBe("2");
    });

    it("returns input unchanged when nothing is sensitive", () => {
      expect(redactQueryString("a=1&b=2")).toBe("a=1&b=2");
    });

    it("preserves repeated keys (does not collapse duplicates)", () => {
      const out = redactQueryString("token=a&token=b&user=x");
      expect(out).toBe(
        `token=${encodeURIComponent(REDACTED)}&token=${encodeURIComponent(
          REDACTED
        )}&user=x`
      );
    });

    it("redacts OAuth params (code/state/session_state) by exact key match", () => {
      const out = redactQueryString("code=authcode123&state=csrf456&session_state=s789&page=2");
      const params = parseQuery(out);
      expect(params.get("code")).toBe(REDACTED);
      expect(params.get("state")).toBe(REDACTED);
      expect(params.get("session_state")).toBe(REDACTED);
      expect(params.get("page")).toBe("2");
    });

    it("does not over-redact params that merely contain code/state as a substring", () => {
      const out = redactQueryString("zipcode=90210&statename=CA&mode=dark");
      const params = parseQuery(out);
      expect(params.get("zipcode")).toBe("90210");
      expect(params.get("statename")).toBe("CA");
      expect(params.get("mode")).toBe("dark");
    });
  });

  describe("redactUrl", () => {
    it("redacts query params and keeps path + fragment", () => {
      const out = redactUrl("https://x.com/p?token=abc&q=1#frag");
      expect(out).toContain("https://x.com/p?");
      expect(out).toContain(`token=${encodeURIComponent(REDACTED)}`);
      expect(out).toContain("q=1");
      expect(out).toContain("#frag");
    });

    it("leaves URLs without a query untouched", () => {
      expect(redactUrl("https://x.com/path")).toBe("https://x.com/path");
    });

    it("redacts an OAuth authorization-code callback URL", () => {
      const out = redactUrl("https://app.com/?code=authcode123&state=csrf456&page=2");
      expect(out).not.toContain("authcode123");
      expect(out).not.toContain("csrf456");
      expect(out).toContain("page=2");
    });

    it("redacts a query string inside a URL fragment (after a real query)", () => {
      const out = redactUrl("https://app.com/path?a=1#/reset?token=SUPERSECRET&section=2");
      expect(out).not.toContain("SUPERSECRET");
      expect(out).toContain("a=1");
      expect(out).toContain("section=2");
      expect(out).toContain("#/reset?");
    });

    it("redacts a query string in a URL fragment with no preceding query", () => {
      const out = redactUrl("https://app.com/#/auth?access_token=SUPERSECRET");
      expect(out).not.toContain("SUPERSECRET");
      expect(out).toContain("#/auth?");
    });

    it("strips embedded userinfo credentials from the authority", () => {
      const out = redactUrl("https://admin:s3cr3t@internal.api/data?x=1");
      expect(out).not.toContain("s3cr3t");
      expect(out).not.toContain("admin:");
      expect(out).toContain("@internal.api/data");
      expect(out).toContain("x=1");
    });

    it("does not treat an `@` in the path/query as userinfo", () => {
      const out = redactUrl("https://x.com/p?email=a@b.com");
      expect(out).toContain("a@b.com");
    });
  });

  describe("redactBody", () => {
    it("deep-redacts JSON object bodies", () => {
      const out = redactBody('{"user":"bob","password":"hunter2","nested":{"token":"t"}}');
      const parsed = JSON.parse(out);
      expect(parsed.user).toBe("bob");
      expect(parsed.password).toBe(REDACTED);
      expect(parsed.nested.token).toBe(REDACTED);
    });

    it("redacts JSON inside arrays", () => {
      const out = redactBody('[{"secret":"x"},{"ok":"y"}]');
      const parsed = JSON.parse(out);
      expect(parsed[0].secret).toBe(REDACTED);
      expect(parsed[1].ok).toBe("y");
    });

    it("redacts form-encoded bodies (an OAuth /token request)", () => {
      const out = redactBody("grant_type=password&password=secret&user=bob");
      const params = parseQuery(out);
      expect(params.get("password")).toBe(REDACTED);
      expect(params.get("user")).toBe("bob");
    });

    it("redacts an analytics writeKey in a JSON body", () => {
      const out = redactBody('{"writeKey":"fixture-write-key-0000000","event":"track"}');
      const parsed = JSON.parse(out);
      expect(parsed.writeKey).toBe(REDACTED);
      expect(parsed.event).toBe("track");
    });

    it("does NOT redact generic code/state keys inside JSON bodies", () => {
      // code/state are exact-match for query/form keys only — in JSON they mean
      // HTTP status / UI state and must be preserved.
      const out = redactBody('{"code":200,"state":"open","user":"bob"}');
      const parsed = JSON.parse(out);
      expect(parsed.code).toBe(200);
      expect(parsed.state).toBe("open");
    });

    it("falls back to free-text scrub for non-JSON", () => {
      const out = redactBody("login failed for token: abc123");
      expect(out).toContain(REDACTED);
    });

    it("bounds deep nesting without throwing and never leaks below the depth cap", () => {
      let deep: Record<string, unknown> = { password: "x" };
      for (let i = 0; i < 50; i++) deep = { nested: deep };
      const body = JSON.stringify(deep);
      expect(() => redactBody(body)).not.toThrow();
      // The deeply-nested object beyond the depth cap is redacted wholesale, so
      // the raw secret never appears in the output.
      expect(redactBody(body)).not.toContain('"password":"x"');
    });

    it("preserves array length (does not silently truncate)", () => {
      const arr = Array.from({ length: 5000 }, (_, i) => ({ i }));
      const out = JSON.parse(redactBody(JSON.stringify(arr)));
      expect(out).toHaveLength(5000);
    });

    it("falls back to text scrub for oversized JSON bodies (no expensive parse)", () => {
      const filler = "x".repeat(200_000);
      // Sensitive pair in the head so the bounded text scrub still reaches it.
      const body = `{"password":"secret","note":"${filler}"}`;
      const out = redactBody(body);
      // Over the parse cap → text scrub path still redacts the sensitive pair.
      expect(out).toContain(REDACTED);
      expect(out).not.toContain("secret");
    });

    it("returns empty/undefined input unchanged", () => {
      expect(redactBody("")).toBe("");
    });
  });

  describe("redactText", () => {
    it("scrubs key=value and key: value pairs in free text", () => {
      expect(redactText("password=secret")).toContain(REDACTED);
      expect(redactText("token: abc123")).toContain(REDACTED);
    });

    it("leaves non-sensitive text untouched", () => {
      expect(redactText("user logged in successfully")).toBe(
        "user logged in successfully"
      );
    });

    it("redacts the full value after a space, not just the first token", () => {
      // `Authorization: Bearer eyJ...` must not mask only "Bearer", which would
      // leak the actual token after the space.
      const out = redactText("Authorization: Bearer eyJtoken123");
      expect(out).not.toContain("eyJtoken123");
      expect(out).not.toContain("Bearer");
      expect(out).toContain(REDACTED);
    });

    it("does not bleed redaction past a line boundary", () => {
      const out = redactText("token: abc123\nstatus: ok");
      expect(out).not.toContain("abc123");
      expect(out).toContain("status: ok");
    });

    it("redacts OAuth code/state in a query-string-shaped free-text payload", () => {
      const out = redactText("callback code=oauthcode123&state=csrf456&page=2");
      expect(out).not.toContain("oauthcode123");
      expect(out).not.toContain("csrf456");
      expect(out).toContain("page=2");
    });

    it("does not over-redact `code:`/`state:` in plain log lines", () => {
      // The `key: value` shape must stay benign — HTTP status / state machine.
      const out = redactText("request finished code: 200 state: idle");
      expect(out).toContain("200");
      expect(out).toContain("idle");
    });

    it("redacts header-style bare-`key` names in free text", () => {
      // Mirrors redactHeaders: a header-like pair scrubbed as free text (log /
      // error message / non-JSON body) must not leak the secret value.
      const out = redactText("x-functions-key: supersecret");
      expect(out).not.toContain("supersecret");
      expect(out).toContain(REDACTED);
    });

    it("redacts a sensitive pair embedded after a non-sensitive key=", () => {
      // `next=/home?token=X` must not match as one greedy pair under the
      // benign `next` key, which would leave token=X unredacted.
      const out = redactText("navigated to /login?next=/home?token=SUPERSECRET");
      expect(out).not.toContain("SUPERSECRET");
      expect(out).toContain(REDACTED);
    });

    it("bounds work on oversized input without scanning the whole string", () => {
      const huge = "a".repeat(200_000) + " token=SUPERSECRET";
      const out = redactText(huge);
      // Head is kept (truncated with an ellipsis); the tail past the cap is
      // dropped fail-closed, so the trailing secret never ships.
      expect(out).not.toContain("SUPERSECRET");
      expect(out.endsWith("…")).toBe(true);
    });
  });

  describe("redactObject", () => {
    it("deep-redacts a structured object without mutating input", () => {
      const input = { a: "1", secret: "x", nested: { token: "t" } };
      const out = redactObject(input);
      expect(out.secret).toBe(REDACTED);
      expect((out.nested as Record<string, unknown>).token).toBe(REDACTED);
      expect(input.secret).toBe("x"); // not mutated
    });

    it("terminates on a cyclic object instead of recursing forever", () => {
      const a: Record<string, unknown> = { name: "a" };
      const b: Record<string, unknown> = { name: "b", a };
      a.b = b; // cycle a → b → a
      let out: Record<string, unknown> | undefined;
      expect(() => {
        out = redactObject(a);
      }).not.toThrow();
      expect(out?.name).toBe("a");
      // The back-edge to `a` is redacted (not re-walked).
      expect((out?.b as Record<string, unknown>).a).toBe(REDACTED);
    });

    it("preserves a non-cyclic object shared across sibling keys (stack-based guard)", () => {
      // The same reference under two sibling keys is NOT a cycle — both copies
      // must be walked, not redacted by a lifetime visited-set.
      const shared = { city: "NYC" };
      const out = redactObject({ home: shared, work: shared });
      expect((out.home as Record<string, unknown>).city).toBe("NYC");
      expect((out.work as Record<string, unknown>).city).toBe("NYC");
    });

    it("fails closed (object-shaped) when a top-level getter throws", () => {
      const input = {
        get boom(): string {
          throw new Error("hostile getter");
        },
      };
      let out: Record<string, unknown> | undefined;
      expect(() => {
        out = redactObject(input as unknown as Record<string, unknown>);
      }).not.toThrow();
      // Returns an object (spreadable as ...safeAttributes), never the raw data
      // and never a string sentinel that would spread into {0:'[',…}.
      expect(out).toEqual({});
      expect(JSON.stringify(out)).not.toContain("hostile getter");
    });

    describe("platform-opaque host objects", () => {
      class HostNode {
        secret = "x";
        self: HostNode = this;
      }
      const isOpaqueNode = (v: unknown) => v instanceof HostNode;

      it("does not descend into a value the platform marks opaque", () => {
        const out = redactObject({ node: new HostNode(), user: "bob" }, { isOpaqueNode });
        expect(out.node).toBe(REDACTED);
        expect(out.user).toBe("bob");
      });

      it("walks node-like plain data the predicate rejects", () => {
        const out = redactObject(
          { widget: { nodeType: 1, nodeName: "item", component: "Widget" } },
          { isOpaqueNode }
        );
        expect(out.widget).toEqual({ nodeType: 1, nodeName: "item", component: "Widget" });
      });

      it("treats nothing as opaque when no predicate is injected", () => {
        const out = redactObject({ node: { kind: "plain" } });
        expect(out.node).toEqual({ kind: "plain" });
      });

      it("fails closed when the predicate throws", () => {
        const out = redactObject(
          { node: { kind: "plain" } },
          {
            isOpaqueNode: () => {
              throw new Error("hostile");
            },
          }
        );
        // The root itself is judged opaque, so nothing is walked or emitted.
        expect(out).toEqual({});
      });
    });
  });

  describe("redactLogFields", () => {
    const privacy = { shouldMaskLogs: true, sensitiveKeys: [] };

    it("forwards the platform's opaque-node predicate to attribute redaction", () => {
      class HostNode {}
      const out = redactLogFields(
        { ...privacy, isOpaqueNode: (v) => v instanceof HostNode },
        "msg",
        { node: new HostNode() }
      );
      expect(out.attributes?.node).toBe(REDACTED);
    });

    it("masks message text and attribute values", () => {
      const out = redactLogFields(privacy, "login password=secret", {
        password: "secret",
        user: "bob",
      });
      expect(out.message).toBe("login password=[REDACTED]");
      expect(out.attributes?.password).toBe(REDACTED);
      expect(out.attributes?.user).toBe("bob");
    });

    it("is a no-op when shouldMaskLogs is off", () => {
      const out = redactLogFields(
        { shouldMaskLogs: false },
        "password=secret",
        { password: "secret" }
      );
      expect(out.message).toBe("password=secret");
      expect(out.attributes?.password).toBe("secret");
    });

    it("keeps attributes object-shaped when a getter throws, so the log builder spread stays clean", () => {
      // Both log builders do
      // `{ ...safeAttributes, message, level }`. If redaction returned the
      // "[REDACTED]" string, spreading it would yield {0:'[',1:'R',…}.
      const hostile = {
        get boom(): string {
          throw new Error("hostile getter");
        },
      };
      const out = redactLogFields(
        privacy,
        "msg",
        hostile as unknown as Record<string, unknown>
      );
      const event = { ...out.attributes, message: out.message, level: "warn" };
      // No numeric-index keys leaked from a stringified sentinel.
      expect(Object.keys(event)).toEqual(
        expect.arrayContaining(["message", "level"])
      );
      expect(event).not.toHaveProperty("0");
      expect(JSON.stringify(event)).not.toContain("hostile getter");
    });
  });

  describe("redact visitor", () => {
    it("is called per leaf with typed value, path, kind and sensitive flag", () => {
      const seen: Array<Record<string, unknown>> = [];
      redactObject(
        { user: "bob", nested: { count: 3 } },
        {
          kind: "log",
          redact: (f) => {
            seen.push({ key: f.key, value: f.value, path: f.path, kind: f.kind, sensitive: f.sensitive });
            return undefined;
          },
        }
      );
      expect(seen).toContainEqual({ key: "user", value: "bob", path: ["user"], kind: "log", sensitive: false });
      // nested numeric leaf keeps its type and full path
      expect(seen).toContainEqual({ key: "count", value: 3, path: ["nested", "count"], kind: "log", sensitive: false });
    });

    it("is never called on container values, only leaves", () => {
      const values: unknown[] = [];
      redactObject({ a: { b: { c: "x" } } }, { kind: "log", redact: (f) => { values.push(f.value); return undefined; } });
      expect(values).toEqual(["x"]); // only the leaf, not the objects
    });

    it("lets the hook transform the original value (e.g. partial mask)", () => {
      const out = JSON.parse(
        redactBody('{"card":"4111111111111111"}', {
          kind: "request-body",
          redact: (f) => (f.key === "card" ? `****${String(f.value).slice(-4)}` : undefined),
        })
      );
      expect(out.card).toBe("****1111");
    });

    it("redacts a field the built-ins miss when the hook returns a value", () => {
      const out = JSON.parse(
        redactBody('{"nickname":"bob"}', {
          kind: "request-body",
          redact: (f) => (f.key === "nickname" ? REDACTED : undefined),
        })
      );
      expect(out.nickname).toBe(REDACTED);
    });

    it("defers to the default when the hook returns undefined", () => {
      const out = JSON.parse(
        redactBody('{"password":"hunter2","user":"bob"}', {
          kind: "request-body",
          redact: () => undefined,
        })
      );
      expect(out.password).toBe(REDACTED); // built-in still applies
      expect(out.user).toBe("bob");
    });

    it("does not descend into a sensitive key's object subtree", () => {
      const seen: string[] = [];
      const out = JSON.parse(
        redactBody('{"credential":{"token":"x"}}', {
          kind: "request-body",
          redact: (f) => { seen.push(f.key); return undefined; },
        })
      );
      expect(out.credential).toBe(REDACTED); // whole subtree
      expect(seen).not.toContain("token"); // hook never saw the descendant
    });

    it("falls back to the built-in result when the hook throws", () => {
      const out = JSON.parse(
        redactBody('{"password":"hunter2"}', {
          kind: "request-body",
          redact: () => { throw new Error("boom"); },
        })
      );
      expect(out.password).toBe(REDACTED);
    });

    it("passes request-body vs response-body kind", () => {
      const kinds: string[] = [];
      const collect = { kind: "request-body" as const, redact: (f: { kind: string }) => { kinds.push(f.kind); return undefined; } };
      redactBody('{"a":"1"}', collect);
      redactBody('{"a":"1"}', { ...collect, kind: "response-body" });
      expect(kinds).toEqual(["request-body", "response-body"]);
    });

    it("calls the hook once with the whole string for unstructured text", () => {
      const seen: Array<{ key: string; value: unknown }> = [];
      redactText("plain log line", { kind: "log", redact: (f) => { seen.push({ key: f.key, value: f.value }); return undefined; } });
      expect(seen).toEqual([{ key: "", value: "plain log line" }]);
    });

    it("honors any non-undefined primitive returned for a whole string (not just strings)", () => {
      // null → "", number/boolean → string form (matches applyLeaf semantics).
      expect(redactText("token: abc", { redact: () => null })).toBe("");
      expect(redactText("token: abc", { redact: () => 0 })).toBe("0");
      expect(redactText("token: abc", { redact: () => false })).toBe("false");
      // undefined still defers to the built-in scrub.
      expect(redactText("token: abc", { redact: () => undefined })).toContain(REDACTED);
    });
  });
});
