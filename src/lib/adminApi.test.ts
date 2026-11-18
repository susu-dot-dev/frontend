import { describe, expect, test } from "@rstest/core";
import {
  adminRequest,
  classifyAdminStatus,
  describeAdminError,
  isRecord,
  malformed,
} from "./adminApi";

const reply = (status: number, body?: unknown) =>
  (async () =>
    new Response(body === undefined ? "" : JSON.stringify(body), { status })) as typeof fetch;

describe("classifyAdminStatus", () => {
  test.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [400, "invalid"],
    [500, "unavailable"],
    [503, "unavailable"],
    [418, "unknown"],
  ])("%i is %s", (status, kind) => {
    expect(classifyAdminStatus(status)).toBe(kind);
  });
});

describe("adminRequest", () => {
  test("sends credentials, JSON headers and the payload, and returns the body", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: 1 }));
    }) as typeof fetch;
    const signal = new AbortController().signal;

    const result = await adminRequest(fetchFn, "PATCH", "/api/x", { a: 1 }, signal);

    expect(result).toEqual({ ok: true, value: { ok: 1 } });
    expect(seen?.url).toBe("/api/x");
    expect(seen?.init.method).toBe("PATCH");
    expect(seen?.init.credentials).toBe("include");
    expect(seen?.init.cache).toBe("no-store");
    expect(seen?.init.body).toBe('{"a":1}');
    expect(seen?.init.signal).toBe(signal);
    expect(seen?.init.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  });

  test("a bodiless DELETE still declares JSON, which the server demands", async () => {
    let init: RequestInit | undefined;
    await adminRequest(
      (async (_url: string, i: RequestInit) => {
        init = i;
        return new Response("{}");
      }) as typeof fetch,
      "DELETE",
      "/api/x",
    );
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  test("an unreadable success body is undefined, not a failure", async () => {
    expect(await adminRequest(reply(200), "GET", "/api/x")).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("a failure carries the classified kind, the server code and its data", async () => {
    const result = await adminRequest(
      reply(409, { error: { code: "num_invites_below_uses", data: { uses: 3 } } }),
      "PATCH",
      "/api/x",
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "conflict", code: "num_invites_below_uses", data: { uses: 3 } },
    });
  });

  test("a failure without a usable envelope has no code", async () => {
    for (const body of [undefined, null, { error: { code: 5 } }]) {
      const result = await adminRequest(reply(503, body), "GET", "/api/x");
      expect(result).toEqual({
        ok: false,
        error: { kind: "unavailable", code: undefined, data: undefined },
      });
    }
  });

  test("a network failure is reported, not thrown", async () => {
    const result = await adminRequest(
      (async () => {
        throw new TypeError("offline");
      }) as typeof fetch,
      "GET",
      "/api/x",
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "network", code: undefined, data: undefined },
    });
  });
});

test("malformed is an unknown failure", () => {
  expect(malformed()).toEqual({
    ok: false,
    error: { kind: "unknown", code: undefined, data: undefined },
  });
});

test("isRecord accepts plain objects only", () => {
  expect(isRecord({})).toBe(true);
  for (const value of [null, [], "s", 1, undefined]) expect(isRecord(value)).toBe(false);
});

test.each([
  ["unauthenticated", "Log in again"],
  ["forbidden", "Only administrators"],
  ["unavailable", "isn't available"],
  ["network", "Can't reach"],
  ["not_found", "no longer exists"],
  ["conflict", "Something went wrong"],
] as const)("describeAdminError(%s)", (kind, text) => {
  expect(describeAdminError({ kind, code: undefined, data: undefined })).toContain(text);
});
