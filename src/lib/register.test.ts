import { afterEach, describe, expect, rs, test } from "@rstest/core";
import {
  type CredentialsApi,
  classifyCredentialError,
  classifyServerError,
  clearFragment,
  fetchSession,
  isValidCode,
  isValidName,
  isWebAuthnSupported,
  normalizeName,
  readRegisterLocation,
  register,
  type WebAuthnStatics,
} from "./register";

afterEach(() => {
  rs.unstubAllGlobals();
});

describe("name and code validation", () => {
  test("normalizes to trimmed NFC", () => {
    expect(normalizeName("  Cafe\u0301  ")).toBe("Caf\u00e9");
  });

  test("accepts ordinary names, including non-ASCII", () => {
    expect(isValidName("Ada Lovelace")).toBe(true);
    expect(isValidName("Zoë 李")).toBe(true);
  });

  test("rejects empty, over-long, control and format characters", () => {
    expect(isValidName("   ")).toBe(false);
    expect(isValidName("a".repeat(129))).toBe(false);
    expect(isValidName("a".repeat(128))).toBe(true);
    // Counted in bytes, not characters: 43 three-byte characters is 129 bytes.
    expect(isValidName("李".repeat(43))).toBe(false);
    expect(isValidName("bad\u0000name")).toBe(false);
    expect(isValidName("zero\u200bwidth")).toBe(false);
    expect(isValidName("bidi\u202eoverride")).toBe(false);
  });

  test("codes must be non-empty and at most 256 bytes", () => {
    expect(isValidCode("")).toBe(false);
    expect(isValidCode("  ")).toBe(false);
    expect(isValidCode("c".repeat(43))).toBe(true);
    expect(isValidCode("c".repeat(256))).toBe(true);
    expect(isValidCode("c".repeat(257))).toBe(false);
  });
});

describe("readRegisterLocation", () => {
  test("reads the code from the fragment and the first-run flag", () => {
    expect(readRegisterLocation({ search: "?first-run=true", hash: "#abc_-123" })).toEqual({
      code: "abc_-123",
      firstRun: true,
    });
  });

  test("defaults to no code and not first-run", () => {
    expect(readRegisterLocation({ search: "", hash: "" })).toEqual({ code: "", firstRun: false });
    expect(readRegisterLocation({ search: "?first-run=false", hash: "" }).firstRun).toBe(false);
  });

  test("decodes percent-encoding and tolerates bad encoding", () => {
    expect(readRegisterLocation({ search: "", hash: "#a%20b" }).code).toBe("a b");
    expect(readRegisterLocation({ search: "", hash: "#100%" }).code).toBe("100%");
  });

  test("accepts a hash without the leading #", () => {
    expect(readRegisterLocation({ search: "", hash: "raw" }).code).toBe("raw");
  });
});

describe("clearFragment", () => {
  test("replaces the current entry with path and query only, keeping state", () => {
    const calls: unknown[][] = [];
    clearFragment(
      { pathname: "/register", search: "?first-run=true" },
      { state: { idx: 1 }, replaceState: (...args: unknown[]) => void calls.push(args) },
    );
    expect(calls).toEqual([[{ idx: 1 }, "", "/register?first-run=true"]]);
  });

  test("defaults to the real window", () => {
    window.history.replaceState(null, "", "/register?x=1#secret");
    clearFragment();
    expect(window.location.hash).toBe("");
    expect(window.location.pathname + window.location.search).toBe("/register?x=1");
  });
});

describe("classifyServerError", () => {
  test.each([
    [403, "invalid_invitation", "invitation_rejected"],
    [400, "invalid_invitation", "invalid_invitation"],
    [400, "invalid_name", "invalid_name"],
    [400, "invalid_challenge", "invalid_challenge"],
    [400, "invalid_credential", "invalid_credential"],
    [400, "unknown_field", "unknown"],
    [400, undefined, "unknown"],
    [409, "registration_accept_failed", "conflict"],
    [503, "registration_not_configured", "unavailable"],
    [500, "internal", "unavailable"],
    [415, "unsupported_media_type", "unknown"],
    [403, "something_else", "unknown"],
  ] as const)("%i %s -> %s", (status, code, expected) => {
    expect(classifyServerError({ status, code })).toBe(expected);
  });
});

describe("classifyCredentialError", () => {
  test.each([
    [{ name: "NotAllowedError" }, "cancelled"],
    [{ name: "AbortError" }, "cancelled"],
    [{ name: "InvalidStateError" }, "already_registered"],
    [{ name: "NotSupportedError" }, "authenticator_failed"],
    [new Error("boom"), "authenticator_failed"],
    [null, "authenticator_failed"],
  ] as const)("%j -> %s", (error, expected) => {
    expect(classifyCredentialError(error)).toBe(expected);
  });
});

describe("isWebAuthnSupported", () => {
  const credentials: CredentialsApi = { create: async () => null };
  const statics: WebAuthnStatics = { parseCreationOptionsFromJSON: () => ({}) as never };

  test("needs both credentials and the JSON parser", () => {
    expect(isWebAuthnSupported(credentials, statics)).toBe(true);
    expect(isWebAuthnSupported(undefined, statics)).toBe(false);
    expect(isWebAuthnSupported(credentials, undefined)).toBe(false);
    expect(isWebAuthnSupported(credentials, {} as WebAuthnStatics)).toBe(false);
  });
});

describe("register", () => {
  const options = { publicKey: { challenge: "Y2g", rp: { id: "localhost", name: "localhost" } } };
  const parsed = {
    challenge: new Uint8Array([1]),
  } as unknown as PublicKeyCredentialCreationOptions;
  const credentialJSON = { id: "cred", type: "public-key", response: {} };
  const credential = { type: "public-key", toJSON: () => credentialJSON } as unknown as Credential;

  type Reply = { status?: number; body?: unknown; raw?: string } | "network";

  function setup(replies: Reply[], created: Credential | null | Error = credential) {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const parseCalls: unknown[] = [];
    let n = 0;
    const fetchFn = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const reply = replies[n++];
      if (reply === "network" || reply === undefined) throw new TypeError("offline");
      return new Response(reply.raw ?? JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }) as typeof fetch;
    const credentials: CredentialsApi = {
      create: async () => {
        if (created instanceof Error) throw created;
        return created;
      },
    };
    const statics: WebAuthnStatics = {
      parseCreationOptionsFromJSON: (o) => {
        parseCalls.push(o);
        return parsed;
      },
    };
    return { requests, parseCalls, deps: { fetchFn, credentials, statics } };
  }

  const input = { code: "  the-code ", name: "  Ada Lovelace " };

  test("runs begin, create, finish and returns the new account", async () => {
    const { requests, parseCalls, deps } = setup([
      { body: options },
      { status: 201, body: { userId: "u-1", role: "admin" } },
    ]);
    expect(await register(input, deps)).toEqual({ ok: true, userId: "u-1", role: "admin" });

    expect(requests.map((r) => r.url)).toEqual(["/api/register/begin", "/api/register/finish"]);
    for (const { init } of requests) {
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    }
    expect(JSON.parse(requests[0]?.init.body as string)).toEqual({
      invitationCode: "the-code",
      name: "Ada Lovelace",
    });
    // The wrapper key is unwrapped before parsing, and finish repeats code and name.
    expect(parseCalls).toEqual([options.publicKey]);
    expect(JSON.parse(requests[1]?.init.body as string)).toEqual({
      invitationCode: "the-code",
      name: "Ada Lovelace",
      credential: credentialJSON,
    });
  });

  test("uses the global fetch by default", async () => {
    const calls: string[] = [];
    rs.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ error: { code: "invalid_invitation" } }), {
        status: 403,
      });
    });
    const { deps } = setup([]);
    expect(await register(input, { ...deps, fetchFn: undefined })).toEqual({
      ok: false,
      code: "invitation_rejected",
    });
    expect(calls).toEqual(["/api/register/begin"]);
  });

  test("defaults to the browser's credentials and statics", async () => {
    rs.stubGlobal("navigator", { credentials: undefined });
    expect(await register(input)).toEqual({ ok: false, code: "unsupported" });
    rs.stubGlobal("navigator", { credentials: { create: async () => null } });
    rs.stubGlobal("PublicKeyCredential", undefined);
    expect(await register(input)).toEqual({ ok: false, code: "unsupported" });
  });

  test("copes with no navigator at all", async () => {
    rs.stubGlobal("navigator", undefined);
    expect(await register(input)).toEqual({ ok: false, code: "unsupported" });
  });

  test("reports unsupported browsers without calling the server", async () => {
    const { requests, deps } = setup([]);
    expect(await register(input, { ...deps, credentials: undefined })).toEqual({
      ok: false,
      code: "unsupported",
    });
    expect(await register(input, { ...deps, statics: {} as WebAuthnStatics })).toEqual({
      ok: false,
      code: "unsupported",
    });
    expect(requests).toHaveLength(0);
  });

  test("a rejected code fails at begin, before any passkey prompt", async () => {
    let prompted = false;
    const { requests, deps } = setup([
      { status: 403, body: { error: { code: "invalid_invitation", message: "x" } } },
    ]);
    deps.credentials.create = async () => {
      prompted = true;
      return credential;
    };
    expect(await register(input, deps)).toEqual({ ok: false, code: "invitation_rejected" });
    expect(prompted).toBe(false);
    expect(requests).toHaveLength(1);
  });

  test("network failures and unreadable error bodies are handled", async () => {
    expect(await register(input, setup(["network"]).deps)).toEqual({ ok: false, code: "network" });
    expect(await register(input, setup([{ status: 503, raw: "<html>" }]).deps)).toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(await register(input, setup([{ status: 400, body: { error: "str" } }]).deps)).toEqual({
      ok: false,
      code: "unknown",
    });
    expect(await register(input, setup([{ status: 400, body: null }]).deps)).toEqual({
      ok: false,
      code: "unknown",
    });
    expect(
      await register(input, setup([{ status: 400, body: { error: { code: 5 } } }]).deps),
    ).toEqual({ ok: false, code: "unknown" });
  });

  test("a malformed begin response is an unknown error", async () => {
    for (const body of [{}, null, { publicKey: "no" }, { publicKey: null }]) {
      expect(await register(input, setup([{ body }]).deps)).toEqual({ ok: false, code: "unknown" });
    }
    expect(await register(input, setup([{ raw: "not json" }]).deps)).toEqual({
      ok: false,
      code: "unknown",
    });
  });

  test("passkey prompt failures are categorised", async () => {
    const cancelled = Object.assign(new Error("x"), { name: "NotAllowedError" });
    expect(await register(input, setup([{ body: options }], cancelled).deps)).toEqual({
      ok: false,
      code: "cancelled",
    });
    const dup = Object.assign(new Error("x"), { name: "InvalidStateError" });
    expect(await register(input, setup([{ body: options }], dup).deps)).toEqual({
      ok: false,
      code: "already_registered",
    });
  });

  test("a null or non-passkey credential is an authenticator failure", async () => {
    expect(await register(input, setup([{ body: options }], null).deps)).toEqual({
      ok: false,
      code: "authenticator_failed",
    });
    const password = { type: "password", toJSON: () => ({}) } as unknown as Credential;
    expect(await register(input, setup([{ body: options }], password).deps)).toEqual({
      ok: false,
      code: "authenticator_failed",
    });
    const noJson = { type: "public-key" } as unknown as Credential;
    expect(await register(input, setup([{ body: options }], noJson).deps)).toEqual({
      ok: false,
      code: "authenticator_failed",
    });
  });

  test("finish errors are mapped, and a malformed success body is unknown", async () => {
    expect(
      await register(
        input,
        setup([
          { body: options },
          { status: 409, body: { error: { code: "registration_accept_failed" } } },
        ]).deps,
      ),
    ).toEqual({ ok: false, code: "conflict" });
    for (const body of [{}, null, { userId: "u" }, { userId: 1, role: "admin" }]) {
      expect(await register(input, setup([{ body: options }, { status: 201, body }]).deps)).toEqual(
        { ok: false, code: "unknown" },
      );
    }
  });
});

describe("fetchSession", () => {
  const reply = (status: number, body?: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  test("200 with a userId is signed in, and cookies are sent", async () => {
    let init: RequestInit | undefined;
    const fetchFn = (async (_url: string, i: RequestInit) => {
      init = i;
      return new Response(JSON.stringify({ userId: "u", role: "member", expiresAt: 1 }));
    }) as typeof fetch;
    expect(await fetchSession(fetchFn)).toEqual({ state: "signed_in" });
    expect(init?.credentials).toBe("include");
  });

  test("401 is signed out", async () => {
    expect(await fetchSession(reply(401, { error: { code: "unauthenticated" } }))).toEqual({
      state: "signed_out",
    });
  });

  test("anything else is unknown", async () => {
    expect(await fetchSession(reply(503))).toEqual({ state: "unknown" });
    expect(await fetchSession(reply(200, {}))).toEqual({ state: "unknown" });
    expect(await fetchSession(reply(200, null))).toEqual({ state: "unknown" });
    expect(
      await fetchSession((async () => {
        throw new TypeError("offline");
      }) as typeof fetch),
    ).toEqual({ state: "unknown" });
  });

  test("uses the global fetch by default", async () => {
    rs.stubGlobal("fetch", reply(401));
    expect(await fetchSession()).toEqual({ state: "signed_out" });
  });
});
