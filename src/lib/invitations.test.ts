import { afterEach, describe, expect, rs, test } from "@rstest/core";
import {
  createInvitation,
  describeInvitationError,
  inviteLink,
  isValidLabel,
  isValidNumInvites,
  listInvitations,
  MAX_LABEL_CHARS,
  MAX_NUM_INVITES,
  normalizeLabel,
  parseInvitation,
  revokeInvitation,
  updateNumInvites,
} from "./invitations";

afterEach(() => {
  rs.unstubAllGlobals();
});

const ID = "22222222-2222-4222-8222-222222222222";
const wire = {
  id: ID,
  type: "member",
  label: "Team",
  numInvites: 5,
  uses: 1,
  status: "active",
  createdAt: 100,
};

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

describe("parseInvitation", () => {
  test("reads a minimal invitation", () => {
    expect(parseInvitation(wire)).toEqual(wire);
  });

  test("keeps the optional fields and defaults a missing label", () => {
    expect(
      parseInvitation({
        ...wire,
        label: undefined,
        status: "revoked",
        expiresAt: 300,
        revokedAt: 200,
        createdBy: "admin",
      }),
    ).toEqual({
      ...wire,
      label: "",
      status: "revoked",
      expiresAt: 300,
      revokedAt: 200,
      createdBy: "admin",
    });
  });

  test.each([
    ["not an object", null],
    ["no id", { ...wire, id: 1 }],
    ["no type", { ...wire, type: undefined }],
    ["no numInvites", { ...wire, numInvites: "5" }],
    ["no uses", { ...wire, uses: undefined }],
    ["no createdAt", { ...wire, createdAt: undefined }],
    ["status not a string", { ...wire, status: 1 }],
    ["unknown status", { ...wire, status: "weird" }],
  ])("rejects %s", (_name, value) => {
    expect(parseInvitation(value)).toBeNull();
  });
});

describe("listInvitations", () => {
  test("returns parsed invitations", async () => {
    expect(await listInvitations(reply(200, { invitations: [wire] }))).toEqual({
      ok: true,
      value: [wire],
    });
  });

  test("passes the failure through", async () => {
    expect(await listInvitations(reply(401, { error: { code: "unauthenticated" } }))).toMatchObject(
      { ok: false, error: { kind: "unauthenticated" } },
    );
  });

  test("a malformed list or row is an unknown failure", async () => {
    for (const body of [{}, null, { invitations: 1 }, { invitations: [{}] }]) {
      expect(await listInvitations(reply(200, body))).toMatchObject({
        ok: false,
        error: { kind: "unknown" },
      });
    }
  });

  test("uses the global fetch by default", async () => {
    rs.stubGlobal("fetch", reply(200, { invitations: [] }));
    expect(await listInvitations()).toEqual({ ok: true, value: [] });
  });
});

describe("isValidLabel", () => {
  test("empty and whitespace-only labels are fine: they are sent as no label", () => {
    expect(isValidLabel("")).toBe(true);
    expect(isValidLabel("   ")).toBe(true);
    expect(normalizeLabel("   ")).toBe("");
  });

  test("allows Unicode display text, including the zero-width joiners", () => {
    expect(isValidLabel("Zoë 李")).toBe(true);
    expect(isValidLabel("می\u200cخواهم")).toBe(true);
    expect(isValidLabel("👨\u200d👩\u200d👧")).toBe(true);
  });

  test("refuses other invisible characters and too-long labels", () => {
    expect(isValidLabel("a\u200bb")).toBe(false);
    expect(isValidLabel("a\u202eb")).toBe(false);
    expect(isValidLabel("a\u0000b")).toBe(false);
    expect(isValidLabel("a".repeat(MAX_LABEL_CHARS))).toBe(true);
    expect(isValidLabel("a".repeat(MAX_LABEL_CHARS + 1))).toBe(false);
  });
});

describe("createInvitation", () => {
  test("POSTs the input and returns the invitation with its one-time code", async () => {
    const { fetchFn, seen } = recorder(201, { ...wire, code: "SECRET" });
    const result = await createInvitation(
      { type: "admin", numInvites: 5, label: "Team", expiresAt: 999 },
      fetchFn,
    );
    expect(result).toEqual({ ok: true, value: { ...wire, code: "SECRET" } });
    expect(seen[0]?.url).toBe("/api/invitation");
    expect(seen[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      type: "admin",
      numInvites: 5,
      label: "Team",
      expiresAt: 999,
    });
  });

  test("omits expiresAt when there is none", async () => {
    const { fetchFn, seen } = recorder(201, { ...wire, code: "C" });
    await createInvitation({ type: "member", numInvites: 1, label: "" }, fetchFn);
    expect(JSON.parse(String(seen[0]?.init.body))).not.toHaveProperty("expiresAt");
  });

  test("failures pass through with the server's code", async () => {
    expect(
      await createInvitation(
        { type: "member", numInvites: 1, label: "" },
        reply(400, { error: { code: "invalid_invitation_type" } }),
      ),
    ).toMatchObject({ ok: false, error: { kind: "invalid", code: "invalid_invitation_type" } });
  });

  test("an answer without a code or a valid invitation is an unknown failure", async () => {
    for (const body of [{ ...wire }, { ...wire, code: "" }, { ...wire, code: 3 }, { code: "x" }]) {
      expect(
        await createInvitation({ type: "member", numInvites: 1, label: "" }, reply(201, body)),
      ).toMatchObject({
        ok: false,
        error: { kind: "unknown" },
      });
    }
  });

  test("uses the global fetch by default", async () => {
    rs.stubGlobal("fetch", reply(201, { ...wire, code: "C" }));
    expect(await createInvitation({ type: "member", numInvites: 1, label: "" })).toMatchObject({
      ok: true,
    });
  });
});

describe("updateNumInvites", () => {
  test("PATCHes the new limit", async () => {
    const { fetchFn, seen } = recorder(200, { ...wire, numInvites: 9 });
    const result = await updateNumInvites(ID, 9, fetchFn);
    expect(seen[0]?.url).toBe(`/api/invitation/${ID}`);
    expect(seen[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ numInvites: 9 });
    expect(result).toMatchObject({ ok: true, value: { numInvites: 9 } });
  });

  test("failures and unreadable answers are values", async () => {
    expect(
      await updateNumInvites(
        ID,
        1,
        reply(409, { error: { code: "num_invites_below_uses", data: { uses: 3 } } }),
      ),
    ).toMatchObject({ ok: false, error: { kind: "conflict", data: { uses: 3 } } });
    expect(await updateNumInvites(ID, 1, reply(200, {}))).toMatchObject({
      ok: false,
      error: { kind: "unknown" },
    });
  });

  test("uses the global fetch by default", async () => {
    rs.stubGlobal("fetch", reply(200, wire));
    expect(await updateNumInvites(ID, 5)).toMatchObject({ ok: true });
  });
});

describe("revokeInvitation", () => {
  test("DELETEs the invitation and returns the record", async () => {
    const { fetchFn, seen } = recorder(200, { ...wire, status: "revoked", revokedAt: 7 });
    const result = await revokeInvitation(ID, fetchFn);
    expect(seen[0]?.url).toBe(`/api/invitation/${ID}`);
    expect(seen[0]?.init.method).toBe("DELETE");
    expect(result).toMatchObject({ ok: true, value: { status: "revoked" } });
  });

  test("passes failures through", async () => {
    expect(await revokeInvitation(ID, reply(404, {}))).toMatchObject({
      ok: false,
      error: { kind: "not_found" },
    });
  });

  test("uses the global fetch by default", async () => {
    rs.stubGlobal("fetch", reply(200, wire));
    expect(await revokeInvitation(ID)).toMatchObject({ ok: true });
  });
});

describe("inviteLink", () => {
  test("puts the code in the fragment of the register page", () => {
    expect(inviteLink("abc", "https://susu.dev")).toBe("https://susu.dev/register#abc");
  });
  test("defaults to the current origin", () => {
    expect(inviteLink("abc")).toBe(`${window.location.origin}/register#abc`);
  });
});

test("isValidNumInvites enforces whole numbers within the server's limits", () => {
  expect(isValidNumInvites(1)).toBe(true);
  expect(isValidNumInvites(MAX_NUM_INVITES)).toBe(true);
  for (const n of [0, -1, 1.5, MAX_NUM_INVITES + 1, Number.NaN]) {
    expect(isValidNumInvites(n)).toBe(false);
  }
});

describe("describeInvitationError", () => {
  const err = (code: string | undefined, data?: unknown) => ({
    kind: "invalid" as const,
    code,
    data,
  });

  test.each([
    ["invalid_invitation_type", "doesn't accept that kind"],
    ["invalid_num_invites", `from 1 to ${MAX_NUM_INVITES}`],
    ["missing_num_invites", `from 1 to ${MAX_NUM_INVITES}`],
    ["invalid_label", `${MAX_LABEL_CHARS} characters`],
    ["invalid_expires_at", "in the future"],
    ["invitation_revoked", "was revoked"],
  ])("%s", (code, text) => {
    expect(describeInvitationError(err(code))).toContain(text);
  });

  test("num_invites_below_uses names the count, singular and plural", () => {
    expect(describeInvitationError(err("num_invites_below_uses", { uses: 1 }))).toContain(
      "1 time,",
    );
    expect(describeInvitationError(err("num_invites_below_uses", { uses: 4 }))).toContain(
      "4 times",
    );
  });

  test("num_invites_below_uses without usable data is still explained", () => {
    for (const data of [undefined, null, {}, { uses: "x" }]) {
      expect(describeInvitationError(err("num_invites_below_uses", data))).toContain(
        "can't go below",
      );
    }
  });

  test("anything else uses the generic wording", () => {
    expect(describeInvitationError(err(undefined))).toContain("Something went wrong");
    expect(
      describeInvitationError({
        kind: "forbidden",
        code: "invitations_forbidden",
        data: undefined,
      }),
    ).toContain("Only administrators");
  });
});
