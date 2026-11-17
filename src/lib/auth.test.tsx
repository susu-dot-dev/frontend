import { afterEach, expect, rs, test } from "@rstest/core";
import { act, render } from "@testing-library/react";
import { AuthProvider, type AuthState, useAuth } from "./auth";

afterEach(() => {
  rs.unstubAllGlobals();
});

const ref: { current: AuthState | null } = { current: null };

const Probe = () => {
  ref.current = useAuth();
  return null;
};

const renderAuth = async () => {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await act(async () => {});
  return ref as { current: AuthState };
};

test("a second login or logout while one is in flight is ignored", async () => {
  const calls: string[] = [];
  let release: (r: Response) => void = () => {};
  rs.stubGlobal("fetch", (url: string) => {
    calls.push(url);
    if (url === "/api/session") return Promise.resolve(new Response("", { status: 401 }));
    // The first logout hangs until released.
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const auth = await renderAuth();

  let first: Promise<boolean> = Promise.resolve(false);
  let secondLogout = true;
  let secondLogin = true;
  await act(async () => {
    first = auth.current.logout();
    secondLogout = await auth.current.logout();
    secondLogin = await auth.current.login();
  });
  expect(secondLogout).toBe(false);
  expect(secondLogin).toBe(false);
  expect(calls).toEqual(["/api/session", "/api/logout"]);

  await act(async () => {
    release(new Response(null, { status: 204 }));
    await first;
  });
  expect(await first).toBe(true);
  expect(auth.current.busy).toBe(false);
});

test("login is ignored while one is in flight", async () => {
  const calls: string[] = [];
  rs.stubGlobal("fetch", (url: string) => {
    calls.push(url);
    if (url === "/api/session") return Promise.resolve(new Response("", { status: 401 }));
    return new Promise<Response>(() => {});
  });
  rs.stubGlobal("PublicKeyCredential", { parseRequestOptionsFromJSON: (o: unknown) => o });
  rs.stubGlobal("navigator", { credentials: { get: async () => null } });
  const auth = await renderAuth();

  let second = true;
  await act(async () => {
    void auth.current.login();
    second = await auth.current.login();
  });
  expect(second).toBe(false);
  expect(calls).toEqual(["/api/session", "/api/login/begin"]);
});
