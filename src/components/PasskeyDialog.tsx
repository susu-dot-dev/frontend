import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

/** What the dialog is showing. `null` means closed. */
export type PasskeyDialogState =
  /** The ceremony is running: the server was asked, and the browser/provider owns the prompt. */
  | { status: "waiting" }
  /** The ceremony failed; `message` says why in the user's terms. */
  | { status: "error"; message: string };

type Props = {
  /** Which ceremony this is: changes the wording. */
  action: "login" | "register" | "logout";
  state: PasskeyDialogState | null;
  /** Retry the whole ceremony. */
  onRetry: () => void;
  /** Dismiss an error. Not offered while waiting: the ceremony can't be cancelled from here. */
  onClose: () => void;
};

/**
 * How long a wait must last before the dialog shows it. A request that fails at once (server
 * down) then goes straight to the error, with no "waiting" frame in front of it.
 */
export const WAITING_DELAY_MS = 250;

/**
 * Once "waiting" is on screen it stays at least this long, so a failure that lands just after
 * it appears doesn't flip the dialog to an error in the same breath.
 */
export const WAITING_MIN_MS = 700;

/**
 * Smooths the state the dialog shows. The real state changes as fast as the network does, which
 * makes a failed request flash "waiting" then "error", and "Try again" flash back to "waiting"
 * and to the error again. This shows a wait only if it lasts, and holds it long enough to read.
 */
export function useSteadyState(
  state: PasskeyDialogState | null,
  delayMs = WAITING_DELAY_MS,
  minMs = WAITING_MIN_MS,
): PasskeyDialogState | null {
  const [shown, setShown] = useState<PasskeyDialogState | null>(
    state?.status === "error" ? state : null,
  );
  // When the shown "waiting" appeared, to know how much of its minimum is left.
  const shownWaitingAt = useRef<number | null>(null);

  useEffect(() => {
    if (state === null) {
      shownWaitingAt.current = null;
      setShown(null);
      return;
    }
    if (state.status === "waiting") {
      if (shown?.status === "waiting") return;
      // Keep showing what is there (nothing, or the previous error after "Try again") until
      // the wait proves it will last. A retry that fails at once then replaces the error with
      // the next one without ever passing through a "waiting" frame.
      const timer = setTimeout(() => {
        shownWaitingAt.current = Date.now();
        setShown(state);
      }, delayMs);
      return () => clearTimeout(timer);
    }
    // An error: if "waiting" is showing, let it finish its minimum first.
    const left =
      shownWaitingAt.current === null ? 0 : minMs - (Date.now() - shownWaitingAt.current);
    const timer = setTimeout(
      () => {
        shownWaitingAt.current = null;
        setShown(state);
      },
      Math.max(left, 0),
    );
    return () => clearTimeout(timer);
  }, [state, shown, delayMs, minMs]);

  return shown;
}

const COPY = {
  login: {
    waitingTitle: "Log in with your passkey",
    waitingBody: "Follow the prompt from your browser or passkey provider to choose your passkey.",
    errorTitle: "Couldn't log you in",
  },
  logout: {
    // Logging out has no passkey step, so it never waits in the dialog.
    waitingTitle: "",
    waitingBody: "",
    errorTitle: "Couldn't log you out",
  },
  register: {
    waitingTitle: "Create your passkey",
    waitingBody: "Follow the prompt from your browser or passkey provider to save a new passkey.",
    errorTitle: "Couldn't create your passkey",
  },
} as const;

/**
 * A modal for the passkey ceremony. While waiting it is an interstitial that
 * can't be dismissed (escape and outside clicks are ignored), so the page
 * behind it can't be used mid-ceremony. On failure it shows the reason where
 * the user is already looking, with a way to retry or close.
 */
export function PasskeyDialog({ action, state: requested, onRetry, onClose }: Props) {
  const copy = COPY[action];
  const state = useSteadyState(requested);
  // The error is still up while a retry proves it will last: don't let it be clicked twice.
  const retrying = requested?.status === "waiting";

  return (
    <Dialog
      open={state !== null}
      // Escape and outside clicks ask to close. While waiting there is nothing to close:
      // the ceremony can't be cancelled from here, so the request is ignored.
      onOpenChange={(open) => {
        if (!open && state?.status === "error" && !retrying) onClose();
      }}
    >
      {state !== null && (
        <DialogContent>
          {state.status === "waiting" ? (
            <>
              <DialogTitle>{copy.waitingTitle}</DialogTitle>
              <DialogDescription>{copy.waitingBody}</DialogDescription>
              <p role="status" className="text-sm text-muted-foreground">
                Waiting for your passkey…
              </p>
            </>
          ) : (
            <>
              <DialogTitle>{copy.errorTitle}</DialogTitle>
              <DialogDescription role="alert" className="text-foreground">
                {state.message}
              </DialogDescription>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={retrying} onClick={onClose}>
                  Close
                </Button>
                <Button type="button" disabled={retrying} onClick={onRetry}>
                  Try again
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
