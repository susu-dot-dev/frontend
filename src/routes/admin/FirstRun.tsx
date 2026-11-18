import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  AUTH_HMAC_SECRET_NAME,
  clearStoredSecret,
  FIRST_RUN_SECRET_NAME,
  type FirstRunStatus,
  fetchFirstRunStatus,
  generateSecret,
  isPlausibleSecret,
  loadStoredSecret,
  MAX_SECRET_LEN,
  registerUrl,
  storeSecret,
} from "@/lib/firstRun";

/** How often the page re-asks the server where setup stands. */
export const POLL_INTERVAL_MS = 3000;

/**
 * Admin first-run setup. The page is a view of server state: it polls
 * GET /api/first-run and renders whichever step the server reports, so
 * reloading or switching machines resumes at the right place. The only
 * browser-side state is the generated secret.
 */
export function FirstRun() {
  const [status, setStatus] = useState<FirstRunStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const result = await fetchFirstRunStatus(fetch, controller.signal);
      if (controller.signal.aborted) return;
      // The status can bounce during a rollout; always take the latest answer,
      // and keep the last known one across a failed poll.
      if (result.ok) setStatus(result.status);
      // A blocked deployment cannot recover by itself: say so and stop asking.
      if (!result.ok && result.blocked) {
        setBlocked(true);
        setUnavailable(false);
        return;
      }
      setBlocked(false);
      setUnavailable(!result.ok);
      // Setup is over for good once an account exists.
      if (result.ok && result.status === "invitation_accepted") return;
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    void poll();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">First-run setup</h1>
        <p className="text-muted-foreground">
          Create the first administrator for this deployment. This page follows the server's state,
          so you can close it and come back at any point.
        </p>
      </header>

      {blocked && <BlockedStep />}

      {unavailable && (
        <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm">
          Can't reach the server for its setup status. Retrying automatically.
        </p>
      )}

      {status === null && !unavailable && !blocked && (
        <p className="text-muted-foreground">Checking status…</p>
      )}
      {!blocked && status === "missing_secret" && <MissingSecretStep />}
      {!blocked && status === "invitation_pending" && <PendingStep />}
      {!blocked && status === "invitation_accepted" && <AcceptedStep />}
    </section>
  );
}

function BlockedStep() {
  return (
    <div role="alert" className="space-y-2 rounded-md border border-destructive/50 p-4">
      <h2 className="text-xl font-semibold">Setup can't finish with this database</h2>
      <p className="text-sm">
        The database holds an invitation that isn't the first-run one, but no account exists, so a
        first-run invitation can never be created and no secret will fix that. Wipe the database and
        redeploy to start over.
      </p>
    </div>
  );
}

function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <textarea
        readOnly
        aria-label={label}
        value={value}
        rows={2}
        onFocus={(event) => event.currentTarget.select()}
        className="block w-full resize-none rounded-md border bg-muted p-3 font-mono text-sm"
      />
    </div>
  );
}

/** Returns the stored secret, generating and persisting one on first use. */
function useGeneratedSecret() {
  const [secret, setSecret] = useState(() => {
    const stored = loadStoredSecret();
    if (stored && isPlausibleSecret(stored)) return stored;
    const fresh = generateSecret();
    storeSecret(fresh);
    return fresh;
  });
  const regenerate = useCallback(() => {
    const fresh = generateSecret();
    storeSecret(fresh);
    setSecret(fresh);
  }, []);
  return { secret, regenerate };
}

function MissingSecretStep() {
  const { secret, regenerate } = useGeneratedSecret();
  const [hmacSecret, setHmacSecret] = useState(generateSecret);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">Step 1: set the deployment secrets</h2>
        <p className="text-muted-foreground">
          Setting <code>{FIRST_RUN_SECRET_NAME}</code> proves you own this deployment: only someone
          who can configure the Worker can do it. The value below was generated in your browser and
          is never sent to the server. Keep this tab's browser, or save the value somewhere safe: it
          can't be shown again once it is set.
        </p>
        <p className="text-sm text-muted-foreground">
          If you generate your own, use 32 to {MAX_SECRET_LEN} letters, digits, <code>-</code> and{" "}
          <code>_</code> only. Output from <code>openssl rand -base64</code> has <code>+</code>,{" "}
          <code>/</code> and <code>=</code> and is silently ignored by the server, which keeps
          reporting this step.
        </p>
      </div>

      <div className="space-y-4">
        <CopyBlock label={`${FIRST_RUN_SECRET_NAME} value`} value={secret} />
        <CopyBlock
          label={`Set ${FIRST_RUN_SECRET_NAME}`}
          value={`npx wrangler secret put ${FIRST_RUN_SECRET_NAME}`}
        />
        <Button type="button" variant="ghost" size="sm" onClick={regenerate}>
          Generate a different value
        </Button>
      </div>

      <div className="space-y-2">
        <h3 className="font-medium">Also needed: {AUTH_HMAC_SECRET_NAME}</h3>
        <p className="text-sm text-muted-foreground">
          Registration needs a permanent signing key, separate from the temporary first-run secret.
          Skip this if it is already set.
        </p>
        <CopyBlock label={`${AUTH_HMAC_SECRET_NAME} value`} value={hmacSecret} />
        <CopyBlock
          label={`Set ${AUTH_HMAC_SECRET_NAME}`}
          value={`npx wrangler secret put ${AUTH_HMAC_SECRET_NAME}`}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setHmacSecret(generateSecret())}
        >
          Generate a different value
        </Button>
      </div>

      <div className="space-y-1 text-sm text-muted-foreground">
        <h3 className="font-medium text-foreground">Without a local checkout</h3>
        <p>
          In the Cloudflare dashboard open Workers &amp; Pages, choose this Worker, then Settings,
          Variables and Secrets, add each secret as type Secret, and deploy.
        </p>
        <h3 className="pt-2 font-medium text-foreground">Local development</h3>
        <p>
          Add <code>{FIRST_RUN_SECRET_NAME}=&lt;value&gt;</code> and{" "}
          <code>{AUTH_HMAC_SECRET_NAME}=&lt;value&gt;</code> to <code>.dev.vars</code> and restart{" "}
          <code>make dev</code>.
        </p>
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        Setting a secret redeploys the Worker. This page checks again every few seconds and moves on
        by itself.
      </p>
    </div>
  );
}

function PendingStep() {
  const navigate = useNavigate();
  const [stored] = useState(() => {
    const value = loadStoredSecret();
    return value && isPlausibleSecret(value) ? value : null;
  });
  const [pasted, setPasted] = useState("");

  // The code travels in the fragment: never sent to a server, not in Referer.
  // The registration page reads it and strips it from the address bar.
  const proceed = (code: string) => void navigate(registerUrl(code.trim()));

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Step 2: create the administrator account</h2>
      <p className="text-muted-foreground">
        The deployment is configured and the first-run invitation is waiting.
      </p>
      {stored ? (
        <Button type="button" onClick={() => proceed(stored)}>
          Create the administrator account
        </Button>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            proceed(pasted);
          }}
        >
          <p className="text-sm text-muted-foreground">
            This browser doesn't have the secret you deployed. Paste the{" "}
            <code>{FIRST_RUN_SECRET_NAME}</code> value to continue.
          </p>
          <label className="block space-y-1 text-sm font-medium">
            {FIRST_RUN_SECRET_NAME} value
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            />
          </label>
          {pasted.trim() !== "" && !isPlausibleSecret(pasted) && (
            <p className="text-sm text-muted-foreground">
              A secret is 32 to {MAX_SECRET_LEN} letters, digits, <code>-</code> or <code>_</code>.
            </p>
          )}
          <Button type="submit" disabled={!isPlausibleSecret(pasted)}>
            Continue
          </Button>
        </form>
      )}
      <p className="text-sm text-muted-foreground">
        If registration says the code doesn't match, the secret can't be recovered or changed: wipe
        the database and redeploy to start over.
      </p>
    </div>
  );
}

function AcceptedStep() {
  useEffect(() => {
    // The secret is inert now; don't leave it lying around in the browser.
    clearStoredSecret();
  }, []);
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">Setup complete</h2>
      <p className="text-muted-foreground">
        The administrator account exists, so first-run setup is closed. Sign in to continue.
      </p>
      <p className="text-sm text-muted-foreground">
        You can now delete <code>{FIRST_RUN_SECRET_NAME}</code> from the deployment. Nothing depends
        on it, but a tidy configuration is easier to reason about.
      </p>
    </div>
  );
}
