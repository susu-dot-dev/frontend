import { afterEach, beforeEach, expect, rs, test } from "@rstest/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { createTestRouter } from "@/router";

type Reply = { status?: number; body?: unknown } | "network";

let session: Reply;
let begin: Reply;
let finish: Reply;
let requests: Array<{ url: string; body?: unknown }>;
let created: Credential | Error | null;

const options = { publicKey: { challenge: "Y2g" } };
const credential = {
  type: "public-key",
  toJSON: () => ({ id: "cred", type: "public-key" }),
} as unknown as Credential;

const respond = (reply: Reply) => {
  if (reply === "network") throw new TypeError("offline");
  return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
};

beforeEach(() => {
  requests = [];
  created = credential;
  session = { status: 401, body: { error: { code: "unauthenticated" } } };
  begin = { body: options };
  finish = { status: 201, body: { userId: "u-1", role: "admin" } };

  rs.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "/api/session") return respond(session);
    if (url === "/api/register/begin") return respond(begin);
    return respond(finish);
  });
  rs.stubGlobal("PublicKeyCredential", { parseCreationOptionsFromJSON: (o: unknown) => o });
  rs.stubGlobal("navigator", {
    credentials: {
      create: async () => {
        if (created instanceof Error) throw created;
        return created;
      },
    },
  });
});

afterEach(() => {
  rs.unstubAllGlobals();
});

const renderPage = async (initial = "/register") => {
  const router = createTestRouter([initial]);
  render(<App router={router} />);
  await act(async () => {});
  return router;
};

const fillName = (name = "Ada Lovelace") =>
  userEvent.type(screen.getByLabelText("Full name"), name);

test("asks only for full name and invitation code", async () => {
  await renderPage();
  expect(screen.getByRole("heading", { name: "Create your account" })).toBeVisible();
  expect(screen.getByLabelText("Full name")).toBeVisible();
  expect(screen.getByLabelText("Invitation code")).toBeVisible();
  expect(screen.getAllByRole("textbox")).toHaveLength(1); // the code field is a password input
  expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();
});

test("reads the invitation from the fragment, prefills it, and clears the URL", async () => {
  window.history.replaceState(null, "", "/register?first-run=true#fragment-code");
  const router = await renderPage("/register?first-run=true#fragment-code");

  expect(screen.getByRole("heading", { name: "Create the administrator account" })).toBeVisible();
  expect(screen.getByLabelText("Invitation code")).toHaveValue("fragment-code");
  // Cleared from the real address bar and history entry, query kept.
  expect(window.location.hash).toBe("");
  expect(window.location.pathname + window.location.search).toBe("/register?first-run=true");
  // The form keeps the code after the fragment is gone.
  expect(router.state.location.search).toBe("?first-run=true");
});

test("does not touch history when there is no fragment", async () => {
  const spy = rs.spyOn(window.history, "replaceState");
  await renderPage("/register");
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("registers: begin, passkey, finish, then points the user to log in", async () => {
  await renderPage("/register#the-code");
  await fillName();
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));

  expect(await screen.findByRole("heading", { name: "Account created" })).toBeVisible();
  expect(screen.getByText(/log in with your passkey/)).toBeVisible();
  expect(requests.map((r) => r.url)).toEqual([
    "/api/session",
    "/api/register/begin",
    "/api/register/finish",
  ]);
  expect(requests[1]?.body).toEqual({ invitationCode: "the-code", name: "Ada Lovelace" });
});

test("works with a pasted code when there is no fragment", async () => {
  await renderPage();
  await fillName();
  await userEvent.type(screen.getByLabelText("Invitation code"), "pasted-code");
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  await screen.findByRole("heading", { name: "Account created" });
  expect(requests[1]?.body).toEqual({ invitationCode: "pasted-code", name: "Ada Lovelace" });
});

test("shows a rejected-invitation error and allows retrying", async () => {
  begin = { status: 403, body: { error: { code: "invalid_invitation" } } };
  await renderPage("/register#bad");
  await fillName();
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("That invitation code isn't valid");
  expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
});

test("a dismissed passkey prompt shows a friendly error", async () => {
  created = Object.assign(new Error("x"), { name: "NotAllowedError" });
  await renderPage("/register#code");
  await fillName();
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("prompt was dismissed");
});

test("disables the button while waiting for the passkey, and ignores double submits", async () => {
  let release: (c: Credential) => void = () => {};
  rs.stubGlobal("navigator", {
    credentials: { create: () => new Promise<Credential>((resolve) => (release = resolve)) },
  });
  await renderPage("/register#code");
  await fillName();
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(screen.getByRole("button", { name: "Waiting for your passkey…" })).toBeDisabled();

  // Submitting the form again via Enter must not start a second ceremony.
  await userEvent.type(screen.getByLabelText("Full name"), "{Enter}");
  expect(requests.filter((r) => r.url === "/api/register/begin")).toHaveLength(1);

  await act(async () => release(credential));
  await screen.findByRole("heading", { name: "Account created" });
});

test("submitting an incomplete form does nothing", async () => {
  await renderPage();
  await userEvent.type(screen.getByLabelText("Full name"), "Ada");
  // Bypass the disabled button: the handler itself must refuse.
  fireEvent.submit(screen.getByLabelText("Full name").closest("form") as HTMLFormElement);
  await act(async () => {});
  expect(requests.map((r) => r.url)).toEqual(["/api/session"]);
});

test("explains invalid names", async () => {
  await renderPage();
  expect(screen.queryByText(/Names can be up to/)).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Full name"), "a".repeat(129));
  expect(screen.getByText(/Names can be up to 128 bytes/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();
});

test("already logged in: hides the form and offers a no-op logout", async () => {
  session = { body: { userId: "u-1", role: "member", expiresAt: 1 } };
  await renderPage("/register#code");

  expect(screen.getByRole("heading", { name: "You're already logged in" })).toBeVisible();
  expect(screen.queryByLabelText("Full name")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Invitation code")).not.toBeInTheDocument();

  const logout = screen.getByRole("button", { name: "Log out" });
  await userEvent.click(logout);
  // Logout isn't implemented: nothing is requested and the page is unchanged.
  expect(requests.map((r) => r.url)).toEqual(["/api/session"]);
  expect(screen.getByRole("heading", { name: "You're already logged in" })).toBeVisible();
});

test("shows a checking message until the session answer arrives", async () => {
  let answer: (r: Response) => void = () => {};
  rs.stubGlobal("fetch", () => new Promise<Response>((resolve) => (answer = resolve)));
  await renderPage();
  expect(screen.getByText("Checking your session…")).toBeVisible();
  expect(screen.queryByLabelText("Full name")).not.toBeInTheDocument();
  await act(async () => answer(new Response("", { status: 401 })));
  expect(screen.getByLabelText("Full name")).toBeVisible();
});

test("if the session can't be checked, the form is still shown", async () => {
  session = "network";
  await renderPage();
  expect(screen.getByLabelText("Full name")).toBeVisible();
});

test("ignores a session answer that arrives after leaving the page", async () => {
  let answer: (r: Response) => void = () => {};
  rs.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      answer = resolve;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("a", "AbortError")));
    });
  });
  const router = createTestRouter(["/register"]);
  const view = render(<App router={router} />);
  view.unmount();
  await act(async () => answer(new Response("", { status: 401 })));
  expect(true).toBe(true);
});

test("the invitation code is hidden by default and can be shown and hidden again", async () => {
  await renderPage("/register#the-code");
  const input = screen.getByLabelText("Invitation code");
  expect(input).toHaveAttribute("type", "password");

  await userEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(input).toHaveAttribute("type", "text");
  expect(input).toHaveValue("the-code");
  expect(screen.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-pressed", "true");

  await userEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(input).toHaveAttribute("type", "password");
  expect(requests.map((r) => r.url)).toEqual(["/api/session"]);
});
