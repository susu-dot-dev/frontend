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
export function PasskeyDialog({ action, state, onRetry, onClose }: Props) {
  const copy = COPY[action];

  return (
    <Dialog
      open={state !== null}
      // Escape and outside clicks ask to close. While waiting there is nothing to close:
      // the ceremony can't be cancelled from here, so the request is ignored.
      onOpenChange={(open) => {
        if (!open && state?.status === "error") onClose();
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
                <Button type="button" variant="outline" onClick={onClose}>
                  Close
                </Button>
                <Button type="button" onClick={onRetry}>
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
