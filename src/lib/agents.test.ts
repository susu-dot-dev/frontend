import { describe, expect, test } from "@rstest/core";
import {
  createAgent,
  describeAgentError,
  isValidAgentName,
  listAgents,
  MAX_AGENTS_PER_USER,
  MAX_NAME_CHARS,
  normalizeAgentName,
  parseAgent,
  revokeAgent,
} from "./agents";

const ID = "01900000-0000-7000-8000-000000000001";
const wire = {
  id: ID,
  name: "Bot",
  scopes: "default:agent",
  status: "active",
  createdAt: 100,
};
const keyWire = { id: "kid", token: "TOKEN", scope: "default:agent", expiresAt: 999 };

const reply = (status: number, body?: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

/** A fetch that records what it was asked and answers once. */
const recorder = (status: number, body: unknown) => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchFn, seen };
};

describe("parseAgent", () => {
  test("reads an agent", () => {
    expect(parseAgent(wire)).toEqual(wire);
  });

  test("keeps revokedAt and defaults missing scopes", () => {
    expect(parseAgent({ ...wire, scopes: undefined, status: "revoked", revokedAt: 200 })).toEqual({
      ...wire,
      scopes: "",
      status: "revoked",
      revokedAt: 200,
    });
  });

  test.each([
    ["not an object", null],
    ["no id", { ...wire, id: 1 }],
    ["no name", { ...wire, name: undefined }],
    ["no createdAt", { ...wire, createdAt: "1" }],
    ["unknown status", { ...wire, status: "weird" }],
  ])("rejects %s", (_name, value) => {
    expect(parseAgent(value)).toBeNull();
  });
});

describe("listAgents", () => {
  test("returns the first page with no query", async () => {
    const { fetchFn, seen } = recorder(200, { agents: [wire], next: "cur" });
    const result = await listAgents(undefined, fetchFn);
    expect(result).toEqual({ ok: true, value: { agents: [wire], next: "cur" } });
    expect(seen[0]?.url).toBe("/api/agent");
    expect(seen[0]?.init.method).toBe("GET");
  });

  test("sends the cursor, encoded, and omits next on the last page", async () => {
    const { fetchFn, seen } = recorder(200, { agents: [] });
    const result = await listAgents("a b", fetchFn);
    expect(result).toEqual({ ok: true, value: { agents: [] } });
    expect(seen[0]?.url).toBe("/api/agent?cursor=a%20b");
  });

  test("ignores an empty next", async () => {
    const result = await listAgents(undefined, reply(200, { agents: [], next: "" }));
    expect(result).toEqual({ ok: true, value: { agents: [] } });
  });

  test.each([
    ["no agents array", { agents: "x" }],
    ["a body that isn't an object", [1]],
    ["a bad agent", { agents: [{ id: 1 }] }],
  ])("is malformed for %s", async (_name, body) => {
    const result = await listAgents(undefined, reply(200, body));
    expect(result).toMatchObject({ ok: false, error: { kind: "unknown" } });
  });

  test("passes failures through", async () => {
    const result = await listAgents(undefined, reply(401, { error: { code: "unauthenticated" } }));
    expect(result).toMatchObject({ ok: false, error: { kind: "unauthenticated" } });
  });

  test("uses the global fetch by default", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = reply(200, { agents: [] });
    try {
      expect(await listAgents()).toEqual({ ok: true, value: { agents: [] } });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("createAgent", () => {
  test("posts the name and returns the agent with its key", async () => {
    const { fetchFn, seen } = recorder(201, { agent: wire, key: keyWire });
    const result = await createAgent("Bot", fetchFn);
    expect(result).toEqual({ ok: true, value: { agent: wire, key: keyWire } });
    expect(seen[0]?.url).toBe("/api/agent");
    expect(seen[0]?.init.method).toBe("POST");
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({ name: "Bot" });
  });

  test("defaults a missing key scope", async () => {
    const result = await createAgent(
      "Bot",
      reply(201, { agent: wire, key: { ...keyWire, scope: undefined } }),
    );
    expect(result).toMatchObject({ ok: true, value: { key: { scope: "" } } });
  });

  test.each([
    ["a body that isn't an object", null],
    ["no agent", { key: keyWire }],
    ["no key", { agent: wire }],
    ["a key that isn't an object", { agent: wire, key: "x" }],
    ["a key with no id", { agent: wire, key: { ...keyWire, id: 1 } }],
    ["a key with an empty token", { agent: wire, key: { ...keyWire, token: "" } }],
    ["a key with no expiry", { agent: wire, key: { ...keyWire, expiresAt: "x" } }],
  ])("is malformed for %s", async (_name, body) => {
    const result = await createAgent("Bot", reply(201, body));
    expect(result).toMatchObject({ ok: false, error: { kind: "unknown" } });
  });

  test("passes failures through with the server's code", async () => {
    const result = await createAgent("Bot", reply(409, { error: { code: "agent_limit_reached" } }));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "conflict", code: "agent_limit_reached" },
    });
  });
});

describe("revokeAgent", () => {
  test("sends DELETE for the encoded id and returns the agent", async () => {
    const revoked = { ...wire, status: "revoked", revokedAt: 5 };
    const { fetchFn, seen } = recorder(200, revoked);
    const result = await revokeAgent("a/b", fetchFn);
    expect(result).toEqual({ ok: true, value: revoked });
    expect(seen[0]?.url).toBe("/api/agent/a%2Fb");
    expect(seen[0]?.init.method).toBe("DELETE");
  });

  test("is malformed when the answer isn't an agent", async () => {
    expect(await revokeAgent(ID, reply(200, { nope: true }))).toMatchObject({
      ok: false,
      error: { kind: "unknown" },
    });
  });

  test("passes failures through", async () => {
    expect(await revokeAgent(ID, reply(404, { error: { code: "agent_not_found" } }))).toMatchObject(
      { ok: false, error: { kind: "not_found", code: "agent_not_found" } },
    );
  });
});

describe("isValidAgentName", () => {
  test("accepts a normal name and the limit, counting characters not bytes", () => {
    expect(isValidAgentName("Bot")).toBe(true);
    expect(isValidAgentName("🤖".repeat(MAX_NAME_CHARS))).toBe(true);
  });

  test("agent names may hold the zero-width joiners (emoji sequences, Persian, Indic)", () => {
    expect(isValidAgentName("👨\u200d👩\u200d👧 helper")).toBe(true);
    expect(isValidAgentName("می\u200cخواهم")).toBe(true);
  });

  test("refuses control and other invisible characters, and a name of only joiners", () => {
    expect(isValidAgentName("a\u200bb")).toBe(false);
    expect(isValidAgentName("a\u202eb")).toBe(false);
    expect(isValidAgentName("a\u0000b")).toBe(false);
    expect(isValidAgentName("\u200d\u200c")).toBe(false);
  });

  test("normalizes to trimmed NFC, and counts the limit after that", () => {
    expect(normalizeAgentName("  Cafe\u0301  ")).toBe("Caf\u00e9");
    expect(isValidAgentName(`${"a".repeat(MAX_NAME_CHARS)}  `)).toBe(true);
  });

  test("refuses blank and too-long names", () => {
    expect(isValidAgentName("   ")).toBe(false);
    expect(isValidAgentName("")).toBe(false);
    expect(isValidAgentName("a".repeat(MAX_NAME_CHARS + 1))).toBe(false);
  });
});

describe("describeAgentError", () => {
  const err = (kind: string, code?: string) =>
    ({ kind, code, data: undefined }) as Parameters<typeof describeAgentError>[0];

  test.each([
    ["invalid_agent_name", new RegExp(`1 to ${MAX_NAME_CHARS}`)],
    ["missing_agent_name", new RegExp(`1 to ${MAX_NAME_CHARS}`)],
    ["agent_limit_reached", new RegExp(`at most ${MAX_AGENTS_PER_USER}`)],
    ["agent_not_found", /no longer exists/],
    ["agent_revoked", /already deleted/],
  ])("words %s", (code, pattern) => {
    expect(describeAgentError(err("invalid", code))).toMatch(pattern);
  });

  test("doesn't call a 403 an admin matter", () => {
    expect(describeAgentError(err("forbidden"))).toBe("You don't have access to agents.");
  });

  test("falls back to the shared wording", () => {
    expect(describeAgentError(err("network"))).toMatch(/Can't reach the server/);
  });
});
