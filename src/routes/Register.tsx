import { type FormEvent, useEffect, useId, useState } from "react";
import { useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import {
  clearFragment,
  fetchSession,
  isValidCode,
  isValidName,
  MAX_NAME_BYTES,
  type RegisterErrorCode,
  readRegisterLocation,
  register,
  type SessionResult,
} from "@/lib/register";

const ERROR_MESSAGES: Record<RegisterErrorCode, string> = {
  invitation_rejected:
    "That invitation code isn't valid. It may be wrong, already used, expired, or revoked.",
  invalid_invitation: "That invitation code isn't in the right format. Check it and try again.",
  invalid_name: "That name can't be used. Use a plain name without special characters.",
  invalid_challenge: "The sign-up attempt expired. Please try again.",
  invalid_credential: "Your passkey was refused. Please try again.",
  conflict: "This invitation was just used. If that wasn't you, ask for a new one.",
  unavailable: "The server can't take sign-ups right now. Try again in a moment.",
  unsupported:
    "This browser can't create passkeys. Try a current browser on a device with a screen lock.",
  cancelled: "The passkey prompt was dismissed. Try again when you're ready.",
  already_registered: "A passkey for this account already exists on this device.",
  authenticator_failed: "Your device couldn't create a passkey. Please try again.",
  network: "Can't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
};

/**
 * Registration by invitation. The invitation code arrives in the URL fragment
 * (never sent to a server or in Referer); it is read once, kept only in
 * component state, and stripped from the address bar immediately.
 */
export function Register() {
  const location = useLocation();
  // Read once: after the fragment is cleared the router location no longer has it.
  const [initial] = useState(() => readRegisterLocation(location));
  const [session, setSession] = useState<SessionResult | null>(null);

  useEffect(() => {
    if (location.hash !== "") clearFragment();
  }, [location.hash]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSession(undefined, controller.signal).then((result) => {
      if (!controller.signal.aborted) setSession(result);
    });
    return () => controller.abort();
  }, []);

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

      {session === null && <p className="text-muted-foreground">Checking your session…</p>}
      {session?.state === "signed_in" && <AlreadySignedIn />}
      {session !== null && session.state !== "signed_in" && (
        <RegisterForm initialCode={initial.code} />
      )}
    </section>
  );
}

function AlreadySignedIn() {
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">You're already logged in</h2>
      <p className="text-muted-foreground">
        You can't create another account while signed in. Log out first if you want to register a
        different one.
      </p>
      {/* Logout isn't implemented yet, so this intentionally does nothing. */}
      <Button type="button" variant="outline" onClick={() => {}}>
        Log out
      </Button>
    </div>
  );
}

function RegisterForm({ initialCode }: { initialCode: string }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RegisterErrorCode | null>(null);
  const [done, setDone] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const codeId = useId();

  const canSubmit = isValidName(name) && isValidCode(code) && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
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
      {name !== "" && !isValidName(name) && (
        <p className="text-sm text-muted-foreground">
          Names can be up to {MAX_NAME_BYTES} bytes and can't contain control or invisible
          characters.
        </p>
      )}
      {error !== null && (
        <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm">
          {ERROR_MESSAGES[error]}
        </p>
      )}
      <Button type="submit" disabled={!canSubmit}>
        {busy ? "Waiting for your passkey…" : "Create account"}
      </Button>
    </form>
  );
}
