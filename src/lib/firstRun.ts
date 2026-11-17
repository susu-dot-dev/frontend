/**
 * Client for authsu's first-run bootstrap (see authsu docs/first_run_design.md).
 *
 * The server owns the state; the only thing that lives in the browser is the
 * generated FIRST_RUN_SECRET, because Worker secrets are write-only and the
 * server never returns the invitation code.
 */

export const FIRST_RUN_SECRET_NAME = "FIRST_RUN_SECRET";
export const AUTH_HMAC_SECRET_NAME = "AUTH_HMAC_SECRET";
export const FIRST_RUN_STORAGE_KEY = "susu-first-run-secret";

/** Matches authsu's firstrun.MinSecretLen. */
export const MIN_SECRET_LEN = 32;

export type FirstRunStatus = "missing_secret" | "invitation_pending" | "invitation_accepted";

const STATUSES: readonly string[] = [
  "missing_secret",
  "invitation_pending",
  "invitation_accepted",
] satisfies FirstRunStatus[];

export const isFirstRunStatus = (value: unknown): value is FirstRunStatus =>
  typeof value === "string" && STATUSES.includes(value);

/**
 * A fresh secret: 32 random bytes from the CSPRNG as base64url, 43 characters.
 * The server never generates or shows it.
 */
export function generateSecret(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export type StatusResult =
  | { ok: true; status: FirstRunStatus }
  /** Transient failure (503, network, bad body): the caller should retry. */
  | { ok: false };

/** GET /api/first-run. Never throws; any failure is reported as retryable. */
export async function fetchFirstRunStatus(
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<StatusResult> {
  try {
    const response = await fetchFn("/api/first-run", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (!response.ok) return { ok: false };
    const body: unknown = await response.json();
    const status = (body as { status?: unknown } | null)?.status;
    return isFirstRunStatus(status) ? { ok: true, status } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** The page the owner is sent to once the first-run invitation is pending. */
export const registerUrl = (code: string) => `/register?first-run=true#${code}`;

type SecretStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Reads the generated secret, tolerating unavailable storage. */
export function loadStoredSecret(storage: Pick<Storage, "getItem"> = localStorage): string | null {
  try {
    return storage.getItem(FIRST_RUN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeSecret(secret: string, storage: Pick<Storage, "setItem"> = localStorage) {
  try {
    storage.setItem(FIRST_RUN_STORAGE_KEY, secret);
  } catch {
    // Without storage the owner falls back to pasting the value they deployed.
  }
}

export function clearStoredSecret(storage: Pick<SecretStorage, "removeItem"> = localStorage) {
  try {
    storage.removeItem(FIRST_RUN_STORAGE_KEY);
  } catch {
    // Nothing to clean up.
  }
}

/** Whether a pasted value could be a deployed secret (the server enforces the same floor). */
export const isPlausibleSecret = (value: string) => value.trim().length >= MIN_SECRET_LEN;
