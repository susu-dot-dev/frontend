import { describe, expect, test } from "@rstest/core";
import {
  clearStoredSecret,
  FIRST_RUN_STORAGE_KEY,
  fetchFirstRunStatus,
  generateSecret,
  isFirstRunStatus,
  isPlausibleSecret,
  loadStoredSecret,
  registerUrl,
  storeSecret,
} from "./firstRun";

const json = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const throwing = () => {
  throw new Error("storage unavailable");
};

describe("generateSecret", () => {
  test("is 43 base64url characters from 32 bytes", () => {
    const secret = generateSecret((bytes) => bytes.fill(0xfb));
    expect(secret).toBe("-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_s");
    expect(secret).toHaveLength(43);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("uses the CSPRNG by default and differs between calls", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe("fetchFirstRunStatus: 409 first_run_blocked", () => {
  const blocked = { error: { code: "first_run_blocked", message: "wipe it and redeploy" } };

  test("is reported as blocked, not as a retryable failure", async () => {
    expect(await fetchFirstRunStatus(json(blocked, 409))).toEqual({ ok: false, blocked: true });
  });

  test("a 409 with any other or unreadable body is just a retryable failure", async () => {
    expect(await fetchFirstRunStatus(json({ error: { code: "other" } }, 409))).toEqual({
      ok: false,
    });
    const garbled = (async () => new Response("<html>", { status: 409 })) as typeof fetch;
    expect(await fetchFirstRunStatus(garbled)).toEqual({ ok: false });
  });
});

describe("isFirstRunStatus", () => {
  test.each(["missing_secret", "invitation_pending", "invitation_accepted"])("accepts %s", (v) => {
    expect(isFirstRunStatus(v)).toBe(true);
  });
  test.each(["nope", null, 1])("rejects %s", (v) => {
    expect(isFirstRunStatus(v)).toBe(false);
  });
});

describe("fetchFirstRunStatus", () => {
  test("returns a known status", async () => {
    expect(await fetchFirstRunStatus(json({ status: "invitation_pending" }))).toEqual({
      ok: true,
      status: "invitation_pending",
    });
  });

  test("requests the endpoint without caching", async () => {
    let seen: [RequestInfo | URL, RequestInit | undefined] | undefined;
    const fetchFn = (async (input, init) => {
      seen = [input, init];
      return new Response('{"status":"missing_secret"}');
    }) as typeof fetch;
    await fetchFirstRunStatus(fetchFn);
    expect(seen?.[0]).toBe("/api/first-run");
    expect(seen?.[1]?.cache).toBe("no-store");
  });

  test.each([
    ["503", json({ error: { code: "first_run_mint_failed" } }, 503)],
    ["unknown status", json({ status: "weird" })],
    ["missing status", json({})],
    ["null body", json(null)],
    [
      "network error",
      (async () => {
        throw new TypeError("offline");
      }) as typeof fetch,
    ],
  ])("treats %s as retryable", async (_name, fetchFn) => {
    expect(await fetchFirstRunStatus(fetchFn)).toEqual({ ok: false });
  });

  test("defaults to global fetch", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = json({ status: "invitation_accepted" });
    try {
      expect(await fetchFirstRunStatus()).toEqual({ ok: true, status: "invitation_accepted" });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("registerUrl", () => {
  test("puts the code in the fragment", () => {
    expect(registerUrl("abc")).toBe("/register?first-run=true#abc");
  });
});

describe("secret storage", () => {
  test("round-trips through storage", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    storeSecret("s".repeat(40), storage);
    expect(data.get(FIRST_RUN_STORAGE_KEY)).toBe("s".repeat(40));
    expect(loadStoredSecret(storage)).toBe("s".repeat(40));
    clearStoredSecret(storage);
    expect(loadStoredSecret(storage)).toBeNull();
  });

  test("defaults to localStorage", () => {
    storeSecret("x".repeat(40));
    expect(loadStoredSecret()).toBe("x".repeat(40));
    clearStoredSecret();
    expect(loadStoredSecret()).toBeNull();
  });

  test("tolerates unavailable storage", () => {
    expect(loadStoredSecret({ getItem: throwing })).toBeNull();
    expect(() => storeSecret("x", { setItem: throwing })).not.toThrow();
    expect(() => clearStoredSecret({ removeItem: throwing })).not.toThrow();
  });
});

describe("isPlausibleSecret: what the server will accept as FIRST_RUN_SECRET", () => {
  test("only base64url characters, 32 to 256 of them", () => {
    expect(isPlausibleSecret(generateSecret())).toBe(true);
    expect(isPlausibleSecret("a".repeat(256))).toBe(true);
    expect(isPlausibleSecret("a".repeat(257))).toBe(false);
  });

  test.each(["+", "/", "=", ".", " ", "é"])("refuses a secret containing %j", (bad) => {
    // `openssl rand -base64 32` is 44 characters ending in "=": long enough, wrong alphabet.
    expect(isPlausibleSecret(`${"a".repeat(31)}${bad}${"a".repeat(5)}`)).toBe(false);
  });
});

describe("isPlausibleSecret", () => {
  test("requires the server's minimum length, ignoring whitespace", () => {
    expect(isPlausibleSecret("a".repeat(32))).toBe(true);
    expect(isPlausibleSecret(`  ${"a".repeat(31)}  `)).toBe(false);
  });
});
