import { afterEach, beforeEach, expect, rs, test } from "@rstest/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
    if (url === "/api/logout") return new Response(null, { status: 204 });
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

test("a rejected passkey opens a modal with the reason, and Try again retries", async () => {
  finish = {
    status: 400,
    body: {
      error: {
        code: "invalid_credential",
        message: "the passkey registration response is not valid",
      },
    },
  };
  await renderPage("/register#code");
  await fillName();
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));

  const dialog = await screen.findByRole("dialog", { name: "Couldn't create your passkey" });
  const alert = within(dialog).getByRole("alert");
  expect(alert).toHaveTextContent("Your passkey was rejected");
  expect(alert).toHaveTextContent("try again");
  expect(alert).toHaveTextContent("different passkey provider");

  // Try again runs the whole ceremony again, with the same name and code.
  finish = { status: 201, body: { userId: "u-1", role: "admin" } };
  await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Account created" });
  expect(requests.filter((r) => r.url === "/api/register/begin")).toHaveLength(2);
  expect(requests.at(-2)?.body).toEqual({ invitationCode: "code", name: "Ada Lovelace" });
});

test("Close dismisses the modal and leaves the form filled in", async () => {
  finish = { status: 400, body: { error: { code: "invalid_credential" } } };
  await renderPage("/register#code");
  await fillName();
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  expect(screen.getByLabelText("Full name")).toHaveValue("Ada Lovelace");
});

test("Escape also dismisses an error modal", async () => {
  finish = { status: 400, body: { error: { code: "invalid_credential" } } };
  await renderPage("/register#code");
  await fillName();
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  await screen.findByRole("dialog");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("problems with what was typed stay beside the form, not in a modal", async () => {
  begin = { status: 403, body: { error: { code: "invalid_invitation" } } };
  await renderPage("/register#bad");
  await fillName();
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("That invitation code isn't valid");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("an unrecognised 400 from finish is also reported as a rejected passkey", async () => {
  finish = { status: 400, body: { error: { code: "unknown_field" } } };
  await renderPage("/register#code");
  await fillName();
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("different passkey provider");
});

test("a dismissed passkey prompt shows a friendly error", async () => {
  created = Object.assign(new Error("x"), { name: "NotAllowedError" });
  await renderPage("/register#code");
  await fillName();
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("prompt was dismissed");
});

test("shows a waiting modal during the ceremony, and ignores double submits", async () => {
  let release: (c: Credential) => void = () => {};
  rs.stubGlobal("navigator", {
    credentials: { create: () => new Promise<Credential>((resolve) => (release = resolve)) },
  });
  await renderPage("/register#code");
  await fillName();
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  const dialog = await screen.findByRole("dialog", { name: "Create your passkey" });
  expect(dialog).toHaveTextContent("Follow the prompt from your browser or passkey provider");
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for your passkey…");
  // Nothing to dismiss: the ceremony can't be cancelled from here.
  expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeVisible();

  // The handler itself refuses a second submit, whatever the DOM allows.
  fireEvent.submit(
    screen.getByLabelText("Full name", { selector: "input" }).closest("form") as HTMLFormElement,
  );
  await act(async () => {});
  expect(requests.filter((r) => r.url === "/api/register/begin")).toHaveLength(1);

  await act(async () => release(credential));
  await screen.findByRole("heading", { name: "Account created" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

test("explains an invitation code the server would refuse as malformed", async () => {
  await renderPage();
  const code = screen.getByLabelText("Invitation code");
  await userEvent.type(screen.getByLabelText("Full name"), "Ada");
  expect(screen.queryByText(/An invitation code is up to/)).not.toBeInTheDocument();
  // A pasted code with stray punctuation (here a base64 "=" and ".") is a 400, so stop it here.
  await userEvent.type(code, "abc.def==");
  expect(screen.getByText(/An invitation code is up to 256 letters, digits/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();
  await userEvent.clear(code);
  await userEvent.type(code, "abc_def-123");
  expect(screen.queryByText(/An invitation code is up to/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
});

test("already logged in: hides the form, and logging out reveals it", async () => {
  session = { body: { userId: "u-1", role: "member", expiresAt: 1 } };
  await renderPage("/register#code");

  expect(screen.getByRole("heading", { name: "You're already logged in" })).toBeVisible();
  expect(screen.queryByLabelText("Full name")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Invitation code")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Log out" }));
  expect(await screen.findByLabelText("Full name")).toBeVisible();
  expect(requests.map((r) => r.url)).toEqual(["/api/session", "/api/logout"]);
});

test("already logged in: a failed logout is reported in a modal", async () => {
  session = { body: { userId: "u-1", role: "member", expiresAt: 1 } };
  await renderPage("/register#code");
  rs.stubGlobal("fetch", async (url: string) =>
    url === "/api/session" ? respond(session) : new Response(null, { status: 503 }),
  );

  await userEvent.click(screen.getByRole("button", { name: "Log out" }));
  const dialog = await screen.findByRole("dialog", { name: "Couldn't log you out" });
  expect(dialog).toHaveTextContent("isn't available");
  // Still signed in: the page behind the modal is unchanged (and aria-hidden while it's open).
  expect(
    screen.getByRole("heading", { name: "You're already logged in", hidden: true }),
  ).toBeVisible();
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
