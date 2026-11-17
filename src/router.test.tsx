import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { useAuth } from "./lib/auth";
import { createRouter, createTestRouter } from "./router";

const Probe = () => {
  useAuth();
  return null;
};

const renderAt = (path: string) => render(<App router={createTestRouter([path])} />);

test("home renders Hello, world and a working counter", async () => {
  renderAt("/");
  expect(screen.getByRole("heading", { name: "Hello, world" })).toBeInTheDocument();

  const button = screen.getByRole("button", { name: "Clicked 0 times" });
  await userEvent.click(button);
  expect(screen.getByRole("button", { name: "Clicked 1 times" })).toBeInTheDocument();
});

test("unknown paths render the not-found page, which links home", async () => {
  renderAt("/nope/nothing");
  expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("link", { name: "Back to home" }));
  expect(screen.getByRole("heading", { name: "Hello, world" })).toBeInTheDocument();
});

test("the layout brand links home", async () => {
  renderAt("/missing");
  await userEvent.click(screen.getByRole("link", { name: "susu" }));
  expect(screen.getByRole("heading", { name: "Hello, world" })).toBeInTheDocument();
});

test("createRouter builds a browser router over the same routes", () => {
  const router = createRouter();
  expect(router.state.location.pathname).toBe("/");
  router.dispose();
});

describe("nav bar login", () => {
  let session: Response;
  let loginReply: Response;
  let calls: string[];
  let assertion: Credential | Error;

  beforeEach(() => {
    calls = [];
    session = new Response("", { status: 401 });
    loginReply = new Response(JSON.stringify({ userId: "u", role: "member", expiresAt: 1 }));
    assertion = { type: "public-key", toJSON: () => ({ id: "c" }) } as unknown as Credential;
    rs.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url === "/api/session") return session.clone();
      if (url === "/api/login/begin") return new Response(JSON.stringify({ publicKey: {} }));
      if (url === "/api/login/finish") {
        // The cookie is now set; the next session check succeeds.
        session = new Response(JSON.stringify({ userId: "u", role: "member", expiresAt: 1 }));
        return loginReply.clone();
      }
      return new Response(null, { status: 204 });
    });
    rs.stubGlobal("PublicKeyCredential", { parseRequestOptionsFromJSON: (o: unknown) => o });
    rs.stubGlobal("navigator", {
      credentials: {
        get: async () => {
          if (assertion instanceof Error) throw assertion;
          return assertion;
        },
      },
    });
  });

  afterEach(() => {
    rs.unstubAllGlobals();
  });

  const settle = () => act(async () => {});

  test.each(["/", "/missing", "/admin/first-run"])("shows Login on %s", async (path) => {
    renderAt(path);
    await settle();
    expect(screen.getByRole("button", { name: "Login" })).toBeVisible();
  });

  test("is not shown on the register view", async () => {
    renderAt("/register");
    await settle();
    expect(screen.queryByRole("button", { name: "Login" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  });

  test("shows neither button until the session check answers", () => {
    rs.stubGlobal("fetch", () => new Promise(() => {}));
    renderAt("/");
    expect(screen.queryByRole("button", { name: "Login" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  });

  test("logging in swaps the button for Log out, and logging out swaps it back", async () => {
    renderAt("/");
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(await screen.findByRole("button", { name: "Log out" })).toBeVisible();
    expect(calls).toEqual([
      "/api/session",
      "/api/login/begin",
      "/api/login/finish",
      "/api/session",
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("button", { name: "Login" })).toBeVisible();
    expect(calls.at(-1)).toBe("/api/logout");
  });

  test("login shows a waiting modal while the passkey prompt is open", async () => {
    let release: (c: Credential) => void = () => {};
    rs.stubGlobal("navigator", {
      credentials: { get: () => new Promise<Credential>((resolve) => (release = resolve)) },
    });
    renderAt("/");
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Login" }));

    const dialog = await screen.findByRole("dialog", { name: "Log in with your passkey" });
    expect(dialog).toHaveTextContent("Follow the prompt from your browser or passkey provider");
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();

    await act(async () => release(assertion as Credential));
    await screen.findByRole("button", { name: "Log out" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("a dismissed passkey prompt shows the reason in a modal, which can be closed", async () => {
    assertion = Object.assign(new Error("x"), { name: "NotAllowedError" });
    renderAt("/");
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Login" }));

    const dialog = await screen.findByRole("dialog", { name: "Couldn't log you in" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("prompt was dismissed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Login" })).toBeEnabled();
  });

  test("a refused login explains itself, and Try again runs the ceremony again", async () => {
    const originalFetch = globalThis.fetch;
    let failFinish = true;
    rs.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/login/finish" && failFinish) {
        failFinish = false;
        return new Response(JSON.stringify({ error: { code: "invalid_login" } }), { status: 401 });
      }
      return originalFetch(url, init);
    });
    renderAt("/");
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Login" }));

    const dialog = await screen.findByRole("dialog", { name: "Couldn't log you in" });
    expect(dialog).toHaveTextContent("couldn't match that passkey to an account");
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Log out" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("a failed logout is reported in a modal and keeps the user signed in", async () => {
    session = new Response(JSON.stringify({ userId: "u", role: "member", expiresAt: 1 }));
    let logoutStatus = 503;
    rs.stubGlobal("fetch", async (url: string) =>
      url === "/api/session" ? session.clone() : new Response(null, { status: logoutStatus }),
    );
    renderAt("/");
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));
    // No passkey is involved in logging out, so there is no waiting interstitial.
    const dialog = await screen.findByRole("dialog", { name: "Couldn't log you out" });
    expect(dialog).toHaveTextContent("isn't available");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Log out" })).toBeVisible();

    // Trying again goes through logout again, not login.
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));
    await screen.findByRole("dialog", { name: "Couldn't log you out" });
    logoutStatus = 204;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Login" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("an unreachable session check still offers Login", async () => {
    rs.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    renderAt("/");
    await settle();
    expect(screen.getByRole("button", { name: "Login" })).toBeVisible();
  });

  test("useAuth outside the provider is a programming error", () => {
    const spy = rs.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow("useAuth must be used inside <AuthProvider>");
    spy.mockRestore();
  });
});
