import { afterEach, beforeEach, expect, rs, test } from "@rstest/core";
import { act, render, screen } from "@testing-library/react";
import {
  PasskeyDialog,
  type PasskeyDialogState,
  WAITING_DELAY_MS,
  WAITING_MIN_MS,
} from "./PasskeyDialog";

beforeEach(() => {
  rs.useFakeTimers();
});

afterEach(() => {
  rs.useRealTimers();
});

const waiting: PasskeyDialogState = { status: "waiting" };
const error = (message: string): PasskeyDialogState => ({ status: "error", message });

const ui = (state: PasskeyDialogState | null) => (
  <PasskeyDialog action="login" state={state} onRetry={() => {}} onClose={() => {}} />
);

const advance = (ms: number) => act(async () => rs.advanceTimersByTimeAsync(ms));

test("a wait that ends at once never shows a waiting frame", async () => {
  const view = render(ui(null));
  view.rerender(ui(waiting));
  await advance(WAITING_DELAY_MS - 50);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  // The server answers before the wait proved itself: straight to the error.
  view.rerender(ui(error("Login isn't available")));
  await advance(0);
  expect(screen.getByRole("alert")).toHaveTextContent("Login isn't available");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("a wait that lasts is shown, and an error right after it waits out the minimum", async () => {
  const view = render(ui(waiting));
  await advance(WAITING_DELAY_MS);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for your passkey");

  await advance(100);
  view.rerender(ui(error("Login isn't available")));
  await advance(0);
  // Still waiting: the error would otherwise replace it a moment after it appeared.
  expect(screen.getByRole("status")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  await advance(WAITING_MIN_MS);
  expect(screen.getByRole("alert")).toHaveTextContent("Login isn't available");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("an error after a long wait appears at once", async () => {
  const view = render(ui(waiting));
  await advance(WAITING_MIN_MS + WAITING_DELAY_MS + 100);
  view.rerender(ui(error("Dismissed")));
  await advance(0);
  expect(screen.getByRole("alert")).toHaveTextContent("Dismissed");
});

test("Try again keeps the error up, and a retry that fails at once never flashes waiting", async () => {
  const view = render(ui(error("Login isn't available")));
  await advance(0);
  expect(screen.getByRole("alert")).toBeVisible();

  // Retry starts: the old error stays, with its buttons disabled so it can't be clicked twice.
  view.rerender(ui(waiting));
  await advance(WAITING_DELAY_MS - 50);
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

  // It fails again immediately: the error is replaced in place.
  view.rerender(ui(error("Still not available")));
  await advance(0);
  expect(screen.getByRole("alert")).toHaveTextContent("Still not available");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
});

test("a retry that does take time moves from the error to waiting", async () => {
  const view = render(ui(error("Login isn't available")));
  await advance(0);
  view.rerender(ui(waiting));
  await advance(WAITING_DELAY_MS);
  expect(screen.getByRole("status")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("closing while a retry is pending is ignored", async () => {
  let closed = 0;
  const view = render(
    <PasskeyDialog action="login" state={error("x")} onRetry={() => {}} onClose={() => closed++} />,
  );
  await advance(0);
  view.rerender(
    <PasskeyDialog action="login" state={waiting} onRetry={() => {}} onClose={() => closed++} />,
  );
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(closed).toBe(0);
});

test("clearing the state closes the dialog, and a pending wait is dropped", async () => {
  const view = render(ui(error("x")));
  await advance(0);
  view.rerender(ui(null));
  await advance(0);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  view.rerender(ui(waiting));
  await advance(WAITING_DELAY_MS - 50);
  view.rerender(ui(null));
  await advance(WAITING_DELAY_MS * 2);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("a wait that is already showing is not restarted by a re-render", async () => {
  const view = render(ui(waiting));
  await advance(WAITING_DELAY_MS);
  view.rerender(ui({ status: "waiting" }));
  await advance(0);
  expect(screen.getByRole("status")).toBeVisible();
});
