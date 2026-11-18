import { afterEach, describe, expect, rs, test } from "@rstest/core";
import { describeUserError, listUsers, parseUser, revokeUser, userName } from "./users";

afterEach(() => {
  rs.unstubAllGlobals();
});

const ID = "11111111-1111-4111-8111-111111111111";
const wire = {
  id: ID,
  role: "member",
  invitationId: "inv",
  profile: { name: "Ada" },
  status: "active",
  createdAt: 100,
};

const reply = (status: number, body?: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe("parseUser", () => {
  test("reads an active user", () => {
    expect(parseUser(wire)).toEqual(wire);
  });

  test("keeps revokedAt when present, and defaults a missing profile to empty", () => {
    expect(parseUser({ ...wire, status: "revoked", revokedAt: 200, profile: null })).toEqual({
      ...wire,
      status: "revoked",
      revokedAt: 200,
      profile: {},
    });
  });

  test.each([
    ["not an object", null],
    ["no id", { ...wire, id: 1 }],
    ["no role", { ...wire, role: undefined }],
    ["no invitationId", { ...wire, invitationId: undefined }],
    ["no createdAt", { ...wire, createdAt: "x" }],
    ["unknown status", { ...wire, status: "weird" }],
  ])("rejects %s", (_name, value) => {
    expect(parseUser(value)).toBeNull();
  });
});

describe("userName", () => {
  test("is the profile name when it is a non-empty string", () => {
    expect(userName({ profile: { name: "Ada" } })).toBe("Ada");
  });
  test("is null otherwise", () => {
    expect(userName({ profile: {} })).toBeNull();
    expect(userName({ profile: { name: "" } })).toBeNull();
    expect(userName({ profile: { name: 4 } })).toBeNull();
  });
});

describe("listUsers", () => {
  test("returns parsed users", async () => {
    expect(await listUsers(reply(200, { users: [wire] }))).toEqual({ ok: true, value: [wire] });
  });

  test("passes the failure through", async () => {
    const result = await listUsers(reply(403, { error: { code: "users_forbidden" } }));
    expect(result).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });

  test("a malformed list or row is an unknown failure", async () => {
    for (const body of [{}, null, { users: "x" }, { users: [{ id: 1 }] }]) {
      expect(await listUsers(reply(200, body))).toMatchObject({
        ok: false,
        error: { kind: "unknown" },
      });
    }
  });

  test("uses the global fetch by default", async () => {
    rs.stubGlobal("fetch", reply(200, { users: [] }));
    expect(await listUsers()).toEqual({ ok: true, value: [] });
  });
});

describe("revokeUser", () => {
  test("DELETEs the user and returns the revoked record", async () => {
    let seen: { url: string; method?: string } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, method: init.method };
      return new Response(JSON.stringify({ ...wire, status: "revoked", revokedAt: 5 }));
    }) as typeof fetch;
    const result = await revokeUser(ID, fetchFn);
    expect(seen).toEqual({ url: `/api/user/${ID}`, method: "DELETE" });
    expect(result).toMatchObject({ ok: true, value: { status: "revoked", revokedAt: 5 } });
  });

  test("escapes the id in the path", async () => {
    let url = "";
    await revokeUser("a/b", (async (u: string) => {
      url = u;
      return new Response("{}");
    }) as typeof fetch);
    expect(url).toBe("/api/user/a%2Fb");
  });

  test("failures and unreadable answers are values", async () => {
    expect(await revokeUser(ID, reply(409, { error: { code: "user_last_admin" } }))).toMatchObject({
      ok: false,
      error: { kind: "conflict", code: "user_last_admin" },
    });
    expect(await revokeUser(ID, reply(200, { nope: 1 }))).toMatchObject({
      ok: false,
      error: { kind: "unknown" },
    });
  });

  test("uses the global fetch by default", async () => {
    rs.stubGlobal("fetch", reply(200, wire));
    expect(await revokeUser(ID)).toMatchObject({ ok: true });
  });
});

describe("describeUserError", () => {
  test("explains the last-admin refusal", () => {
    expect(
      describeUserError({ kind: "conflict", code: "user_last_admin", data: undefined }),
    ).toContain("last active administrator");
  });
  test("falls back to the generic wording", () => {
    expect(describeUserError({ kind: "forbidden", code: undefined, data: undefined })).toContain(
      "Only administrators",
    );
    expect(describeUserError({ kind: "conflict", code: "other", data: undefined })).toContain(
      "Something went wrong",
    );
  });
});
