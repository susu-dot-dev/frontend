import { type FormEvent, useEffect, useId, useState } from "react";
import { useLocation } from "react-router";
import { PasskeyDialog, type PasskeyDialogState } from "@/components/PasskeyDialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { REGISTER_ERROR_MESSAGES } from "@/lib/passkeyMessages";
import {
  clearFragment,
  isValidCode,
  isValidName,
  MAX_CODE_BYTES,
  MAX_NAME_BYTES,
  type RegisterErrorCode,
  readRegisterLocation,
  register,
} from "@/lib/register";

/**
 * Registration by invitation. The invitation code arrives in the URL fragment
 * (never sent to a server or in Referer); it is read once, kept only in
 * component state, and stripped from the address bar immediately.
 */
export function Register() {
  const location = useLocation();
  // Read once: after the fragment is cleared the router location no longer has it.
  const [initial] = useState(() => readRegisterLocation(location));
  const { session } = useAuth();

  useEffect(() => {
    if (location.hash !== "") clearFragment();
  }, [location.hash]);

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          {initial.firstRun ? "Create the administrator account" : "Create your account"}
        </h1>
        <p className="text-muted-foreground">
          Accounts use a passkey, so there is no password to remember. You'll need an invitation.
        </p>
      </header>

      {session.state === "loading" && (
        <p className="text-muted-foreground">Checking your session…</p>
      )}
      {session.state === "signed_in" && <AlreadySignedIn />}
      {session.state !== "loading" && session.state !== "signed_in" && (
        <RegisterForm initialCode={initial.code} />
      )}
    </section>
  );
}

function AlreadySignedIn() {
  const { busy, logout } = useAuth();
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">You're already logged in</h2>
      <p className="text-muted-foreground">
        You can't create another account while signed in. Log out first if you want to register a
        different one.
      </p>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void logout()}>
        Log out
      </Button>
    </div>
  );
}

/** Failures the user fixes by editing the form, so they are shown beside it. */
const FIELD_ERRORS = new Set<RegisterErrorCode>([
  "invitation_rejected",
  "invalid_invitation",
  "invalid_name",
  "conflict",
]);

function RegisterForm({ initialCode }: { initialCode: string }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RegisterErrorCode | null>(null);
  const [done, setDone] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const codeId = useId();

  const canSubmit = isValidName(name) && isValidCode(code) && !busy;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await register({ code, name });
    setBusy(false);
    if (result.ok) {
      // The code is spent: don't keep it around.
      setCode("");
      setDone(true);
    } else {
      setError(result.code);
    }
  };

  // Problems with what the user typed stay next to the form. Everything else is about the
  // passkey or the server, which the user can only retry, so it gets the modal.
  const fieldError = error !== null && FIELD_ERRORS.has(error);
  let dialog: PasskeyDialogState | null = null;
  if (busy) dialog = { status: "waiting" };
  else if (error !== null && !fieldError) {
    dialog = { status: "error", message: REGISTER_ERROR_MESSAGES[error] };
  }

  if (done) {
    return (
      <div className="space-y-3">
        <h2 className="text-xl font-semibold">Account created</h2>
        <p className="text-muted-foreground">
          Your passkey is saved. Registering doesn't sign you in: log in with your passkey to
          continue.
        </p>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <label className="block space-y-1 text-sm font-medium">
        Full name
        <input
          type="text"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </label>
      <div className="space-y-1">
        <label htmlFor={codeId} className="block text-sm font-medium">
          Invitation code
        </label>
        <div className="flex gap-2">
          <input
            id={codeId}
            type={showCode ? "text" : "password"}
            autoComplete="one-time-code"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
          />
          <Button
            type="button"
            variant="outline"
            aria-pressed={showCode}
            onClick={() => setShowCode((shown) => !shown)}
          >
            {showCode ? "Hide" : "Show"}
          </Button>
        </div>
      </div>
      {code.trim() !== "" && !isValidCode(code) && (
        <p className="text-sm text-muted-foreground">
          An invitation code is up to {MAX_CODE_BYTES} letters, digits, <code>-</code> and{" "}
          <code>_</code>. Check that nothing else was copied with it.
        </p>
      )}
      {name !== "" && !isValidName(name) && (
        <p className="text-sm text-muted-foreground">
          Names can be up to {MAX_NAME_BYTES} bytes and can't contain control or invisible
          characters.
        </p>
      )}
      {error !== null && fieldError && (
        <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm">
          {REGISTER_ERROR_MESSAGES[error]}
        </p>
      )}
      <Button type="submit" disabled={!canSubmit}>
        Create account
      </Button>
      <PasskeyDialog
        action="register"
        state={dialog}
        onRetry={() => void submit()}
        onClose={() => setError(null)}
      />
    </form>
  );
}
