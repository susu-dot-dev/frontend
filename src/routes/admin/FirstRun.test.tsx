import { afterEach, beforeEach, expect, rs, test } from "@rstest/core";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { FIRST_RUN_STORAGE_KEY } from "@/lib/firstRun";
import { createTestRouter } from "@/router";
import { POLL_INTERVAL_MS } from "./FirstRun";

const originalFetch = globalThis.fetch;
let responses: Array<{ status?: number; body: unknown } | "network">;
let calls: number;

beforeEach(() => {
  localStorage.clear();
  calls = 0;
  responses = [];
  globalThis.fetch = (async () => {
    const next = responses[Math.min(calls++, responses.length - 1)];
    if (next === "network") throw new TypeError("offline");
    return new Response(JSON.stringify(next?.body), { status: next?.status ?? 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rs.useRealTimers();
});

const renderPage = async (initial = "/admin/first-run") => {
  const router = createTestRouter([initial]);
  render(<App router={router} />);
  // Let the first poll settle.
  await act(async () => {});
  return router;
};
const status = (s: string) => ({ body: { status: s } });

test("missing secret: shows generated secret and the wrangler commands", async () => {
  responses = [status("missing_secret")];
  await renderPage();
  expect(screen.getByRole("heading", { name: "Step 1: set the deployment secrets" })).toBeVisible();
  const stored = localStorage.getItem(FIRST_RUN_STORAGE_KEY);
  expect(stored).toHaveLength(43);
  expect(screen.getByLabelText("FIRST_RUN_SECRET value")).toHaveValue(stored as string);
  expect(screen.getByLabelText("Set FIRST_RUN_SECRET")).toHaveValue(
    "npx wrangler secret put FIRST_RUN_SECRET",
  );
  expect(screen.getByLabelText("Set AUTH_HMAC_SECRET")).toHaveValue(
    "npx wrangler secret put AUTH_HMAC_SECRET",
  );
  expect(screen.getByText(/proves you own this deployment/)).toBeVisible();
});

test("reuses a stored secret across reloads and can regenerate", async () => {
  const existing = "e".repeat(43);
  localStorage.setItem(FIRST_RUN_STORAGE_KEY, existing);
  responses = [status("missing_secret")];
  await renderPage();
  expect(screen.getByLabelText("FIRST_RUN_SECRET value")).toHaveValue(existing);

  const hmacBefore = screen.getByLabelText<HTMLTextAreaElement>("AUTH_HMAC_SECRET value").value;
  const [regenFirstRun, regenHmac] = screen.getAllByRole("button", {
    name: "Generate a different value",
  });
  await userEvent.click(regenFirstRun as HTMLElement);
  expect(localStorage.getItem(FIRST_RUN_STORAGE_KEY)).not.toBe(existing);
  expect(screen.getByLabelText("FIRST_RUN_SECRET value")).not.toHaveValue(existing);
  await userEvent.click(regenHmac as HTMLElement);
  expect(screen.getByLabelText<HTMLTextAreaElement>("AUTH_HMAC_SECRET value").value).not.toBe(
    hmacBefore,
  );
});

test("ignores a too-short stored value", async () => {
  localStorage.setItem(FIRST_RUN_STORAGE_KEY, "short");
  responses = [status("missing_secret")];
  await renderPage();
  expect(localStorage.getItem(FIRST_RUN_STORAGE_KEY)).toHaveLength(43);
});

test("copy button copies the value and reports it", async () => {
  responses = [status("missing_secret")];
  const writeText = rs.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await renderPage();
  const [copy] = screen.getAllByRole("button", { name: "Copy" });
  await userEvent.click(copy as HTMLElement);
  expect(writeText).toHaveBeenCalledWith(localStorage.getItem(FIRST_RUN_STORAGE_KEY));
  expect(await screen.findByRole("button", { name: "Copied" })).toBeVisible();
});

test("copy failure leaves the button usable", async () => {
  responses = [status("missing_secret")];
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
    configurable: true,
  });
  await renderPage();
  const [copy] = screen.getAllByRole("button", { name: "Copy" });
  await userEvent.click(copy as HTMLElement);
  expect(screen.getAllByRole("button", { name: "Copy" })[0]).toBeVisible();
});

test("polls and advances by itself, tolerating a bouncing status and outages", async () => {
  rs.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  responses = [
    status("missing_secret"),
    "network",
    status("invitation_pending"),
    status("missing_secret"),
    status("invitation_pending"),
  ];
  await renderPage();
  expect(screen.getByText("Step 1: set the deployment secrets")).toBeVisible();

  await act(async () => {
    await rs.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });
  // A failed poll keeps the last known step and says so.
  expect(screen.getByRole("alert")).toHaveTextContent(/Can't reach the server/);
  expect(screen.getByText("Step 1: set the deployment secrets")).toBeVisible();

  await act(async () => {
    await rs.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Step 2: create the administrator account")).toBeVisible();

  await act(async () => {
    await rs.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });
  expect(screen.getByText("Step 1: set the deployment secrets")).toBeVisible();

  await act(async () => {
    await rs.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });
  expect(screen.getByText("Step 2: create the administrator account")).toBeVisible();
});

test("shows a retry notice instead of a step when the first check fails", async () => {
  responses = [{ status: 503, body: { error: { code: "first_run_users_check_failed" } } }];
  await renderPage();
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.queryByText("Checking status…")).toBeNull();
});

test("shows a checking message before the first answer", async () => {
  responses = [status("missing_secret")];
  const router = createTestRouter(["/admin/first-run"]);
  render(<App router={router} />);
  expect(screen.getByText("Checking status…")).toBeVisible();
  await act(async () => {});
});

test("pending with the stored secret hands off to registration via the fragment", async () => {
  const secret = "p".repeat(43);
  localStorage.setItem(FIRST_RUN_STORAGE_KEY, secret);
  responses = [status("invitation_pending")];
  const router = await renderPage();
  await userEvent.click(screen.getByRole("button", { name: "Create the administrator account" }));
  expect(router.state.location.pathname).toBe("/register");
  expect(router.state.location.search).toBe("?first-run=true");
  expect(router.state.location.hash).toBe(`#${secret}`);
});

test("pending without the secret asks the owner to paste it", async () => {
  responses = [status("invitation_pending")];
  const router = await renderPage();
  const continueButton = screen.getByRole("button", { name: "Continue" });
  expect(continueButton).toBeDisabled();

  const input = screen.getByLabelText("FIRST_RUN_SECRET value");
  await userEvent.type(input, "too short");
  expect(continueButton).toBeDisabled();
  await userEvent.click(continueButton);
  expect(router.state.location.pathname).toBe("/admin/first-run");

  await userEvent.clear(input);
  const pasted = "q".repeat(43);
  await userEvent.type(input, `  ${pasted}  `);
  expect(continueButton).toBeEnabled();
  await userEvent.type(input, "{Enter}");
  expect(router.state.location.pathname).toBe("/register");
  expect(router.state.location.hash).toBe(`#${pasted}`);
  expect(screen.queryByText(pasted)).toBeNull();
});

test("pending page signposts wipe-and-redeploy recovery", async () => {
  responses = [status("invitation_pending")];
  await renderPage();
  expect(screen.getByText(/wipe the database and redeploy/)).toBeVisible();
});

test("accepted: setup complete, stops polling and clears the stored secret", async () => {
  rs.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.setItem(FIRST_RUN_STORAGE_KEY, "a".repeat(43));
  responses = [status("invitation_accepted")];
  await renderPage();
  expect(screen.getByRole("heading", { name: "Setup complete" })).toBeVisible();
  expect(screen.getByText(/delete/)).toBeVisible();
  expect(localStorage.getItem(FIRST_RUN_STORAGE_KEY)).toBeNull();

  await act(async () => {
    await rs.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
  });
  expect(calls).toBe(1);
});

test("stops polling when the page unmounts", async () => {
  rs.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  responses = [status("missing_secret")];
  const router = await renderPage();
  await act(async () => {
    await router.navigate("/");
  });
  const before = calls;
  await act(async () => {
    await rs.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
  });
  expect(calls).toBe(before);
});

test("an in-flight poll resolving after unmount is dropped", async () => {
  let release: (r: Response) => void = () => {};
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      release = resolve;
    })) as typeof fetch;
  const router = createTestRouter(["/admin/first-run"]);
  render(<App router={router} />);
  await act(async () => {
    await router.navigate("/");
  });
  await act(async () => {
    release(new Response('{"status":"missing_secret"}'));
  });
  expect(screen.queryByText("Step 1: set the deployment secrets")).toBeNull();
});

test("pending treats a too-short stored value as missing and asks for a paste", async () => {
  localStorage.setItem(FIRST_RUN_STORAGE_KEY, "short");
  responses = [status("invitation_pending")];
  await renderPage();
  expect(screen.getByLabelText("FIRST_RUN_SECRET value")).toBeVisible();
});

test("focusing a value selects it for copying", async () => {
  responses = [status("missing_secret")];
  await renderPage();
  const field = screen.getByLabelText<HTMLTextAreaElement>("FIRST_RUN_SECRET value");
  await userEvent.click(field);
  expect(field.selectionStart).toBe(0);
  expect(field.selectionEnd).toBe(field.value.length);
});
