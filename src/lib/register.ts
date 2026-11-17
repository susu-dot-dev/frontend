/**
 * Client for authsu's passkey registration (see authsu docs/registration_design.md
 * and docs/invitations_design.md).
 *
 * Accounts are usernameless and passwordless: an account is a passkey, and the
 * only way to get one is an invitation code. The code travels in the URL
 * fragment so it never reaches a server or a Referer header; the page reads it
 * once and strips it from the address bar.
 */

/** Matches authsu's server-side caps. */
export const MAX_NAME_BYTES = 128;
export const MAX_CODE_BYTES = 256;

const encoder = new TextEncoder();

/** Control (Cc) and format (Cf) characters, which the server rejects in names. */
const DISALLOWED_NAME_CHARS = /[\p{Cc}\p{Cf}]/u;

/** The name the server will see: NFC-normalized and trimmed. */
export const normalizeName = (name: string) => name.normalize("NFC").trim();

/** Client-side mirror of the server's name rules, so most mistakes never cost a round trip. */
export function isValidName(name: string): boolean {
  const normalized = normalizeName(name);
  if (normalized === "") return false;
  if (encoder.encode(normalized).length > MAX_NAME_BYTES) return false;
  return !DISALLOWED_NAME_CHARS.test(normalized);
}

export const normalizeCode = (code: string) => code.trim();

export const isValidCode = (code: string) => {
  const normalized = normalizeCode(code);
  return normalized !== "" && encoder.encode(normalized).length <= MAX_CODE_BYTES;
};

/** What the page learned from its URL. */
export type RegisterLocation = {
  /** The invitation code from the fragment, or "" if there was none. */
  code: string;
  /** Cosmetic only: the server ignores it. Lets the page say "administrator". */
  firstRun: boolean;
};

/** Parses the invitation code and first-run flag out of a router location. */
export function readRegisterLocation(location: { search: string; hash: string }): RegisterLocation {
  let code = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  try {
    code = decodeURIComponent(code);
  } catch {
    // Not percent-encoded text: use it as written.
  }
  return {
    code: normalizeCode(code),
    firstRun: new URLSearchParams(location.search).get("first-run") === "true",
  };
}

/**
 * Removes the fragment from the address bar and from the current history entry,
 * so the code is not left in history, bookmarks, or screenshots.
 */
export function clearFragment(
  loc: Pick<Location, "pathname" | "search"> = window.location,
  history: Pick<History, "replaceState" | "state"> = window.history,
) {
  // Keep the router's own history state: dropping it would confuse navigation.
  history.replaceState(history.state, "", loc.pathname + loc.search);
}

export type RegisterErrorCode =
  /** The code is unknown, revoked, expired, or used up (403). Deliberately not more specific. */
  | "invitation_rejected"
  /** The server found the code malformed (400). */
  | "invalid_invitation"
  | "invalid_name"
  /** The challenge expired or was minted for other input: starting again fixes it. */
  | "invalid_challenge"
  /** The authenticator's answer was refused. */
  | "invalid_credential"
  /** Lost a race, or this invitation was just used (409). */
  | "conflict"
  /** Server or database unavailable (5xx): retry later. */
  | "unavailable"
  /** The browser has no WebAuthn support. */
  | "unsupported"
  /** The user dismissed the passkey prompt. */
  | "cancelled"
  /** The passkey for this account already exists on this authenticator. */
  | "already_registered"
  /** The authenticator or platform could not create a passkey. */
  | "authenticator_failed"
  /** Network failure or an unreadable response. */
  | "network"
  | "unknown";

export type RegisterResult =
  | { ok: true; userId: string; role: string }
  | { ok: false; code: RegisterErrorCode };

type ServerError = { status: number; code: string | undefined };

/** Maps an authsu error response (status + stable code) to what the UI branches on. */
export function classifyServerError({ status, code }: ServerError): RegisterErrorCode {
  // invalid_invitation is used at both 400 (malformed) and 403 (not redeemable).
  if (status === 403 && code === "invalid_invitation") return "invitation_rejected";
  if (status === 400) {
    switch (code) {
      case "invalid_invitation":
      case "invalid_name":
      case "invalid_challenge":
      case "invalid_credential":
        return code;
    }
  }
  if (status === 409) return "conflict";
  if (status >= 500) return "unavailable";
  return "unknown";
}

type JsonResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "error"; code: RegisterErrorCode };

/** POSTs JSON to the API. Never throws. */
async function postJson(
  fetchFn: typeof fetch,
  path: string,
  payload: unknown,
): Promise<JsonResult> {
  let response: Response;
  try {
    response = await fetchFn(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: "error", code: "network" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (response.ok) return { kind: "ok", status: response.status, body };

  const error = (body as { error?: { code?: unknown } } | null | undefined)?.error;
  const code = typeof error?.code === "string" ? error.code : undefined;
  return { kind: "error", code: classifyServerError({ status: response.status, code }) };
}

/** The WebAuthn surface registration needs; injectable so tests need no browser. */
export type CredentialsApi = {
  create(options: { publicKey: PublicKeyCredentialCreationOptions }): Promise<Credential | null>;
};

type CreationOptionsJSON = Parameters<typeof PublicKeyCredential.parseCreationOptionsFromJSON>[0];

/** The slice of the PublicKeyCredential statics registration relies on. */
export type WebAuthnStatics = {
  parseCreationOptionsFromJSON(options: CreationOptionsJSON): PublicKeyCredentialCreationOptions;
};

function defaultCredentials(): CredentialsApi | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.credentials;
}

function defaultStatics(): WebAuthnStatics | undefined {
  return typeof PublicKeyCredential === "undefined" ? undefined : PublicKeyCredential;
}

/** Whether the given WebAuthn pieces can run the ceremony at all. */
export function isWebAuthnSupported(
  credentials: CredentialsApi | undefined,
  statics: WebAuthnStatics | undefined,
): credentials is CredentialsApi {
  return (
    credentials !== undefined &&
    statics !== undefined &&
    typeof statics.parseCreationOptionsFromJSON === "function"
  );
}

/** Maps a failure from navigator.credentials.create to a UI category. */
export function classifyCredentialError(error: unknown): RegisterErrorCode {
  const name = (error as { name?: unknown } | null)?.name;
  // NotAllowedError covers cancel, timeout and "no user gesture"; browsers do not tell them apart.
  if (name === "NotAllowedError" || name === "AbortError") return "cancelled";
  if (name === "InvalidStateError") return "already_registered";
  return "authenticator_failed";
}

export type RegisterDeps = {
  fetchFn?: typeof fetch;
  credentials?: CredentialsApi;
  statics?: WebAuthnStatics;
};

const isCreationOptions = (body: unknown): body is { publicKey: CreationOptionsJSON } => {
  const publicKey = (body as { publicKey?: unknown } | null | undefined)?.publicKey;
  return typeof publicKey === "object" && publicKey !== null;
};

const isPublicKeyCredential = (
  credential: Credential | null,
): credential is PublicKeyCredential & { toJSON(): unknown } =>
  credential !== null &&
  credential.type === "public-key" &&
  typeof (credential as { toJSON?: unknown }).toJSON === "function";

const isFinishBody = (body: unknown): body is { userId: string; role: string } => {
  const value = body as { userId?: unknown; role?: unknown } | null | undefined;
  return typeof value?.userId === "string" && typeof value?.role === "string";
};

/**
 * Runs the whole registration ceremony: begin, create a passkey, finish.
 * Never throws; every failure is a RegisterErrorCode.
 *
 * `begin` writes nothing, so a wrong code fails before any biometric prompt.
 * `finish` issues no session: the caller sends the user on to log in.
 */
export async function register(
  input: { code: string; name: string },
  deps: RegisterDeps = {},
): Promise<RegisterResult> {
  const fetchFn = deps.fetchFn ?? ((...args) => fetch(...args));
  const credentials = deps.credentials ?? defaultCredentials();
  const statics = deps.statics ?? defaultStatics();
  if (!credentials || !statics || !isWebAuthnSupported(credentials, statics)) {
    return { ok: false, code: "unsupported" };
  }

  // The challenge is bound to the code and name, so both are sent again on finish.
  const invitationCode = normalizeCode(input.code);
  const name = normalizeName(input.name);

  const begin = await postJson(fetchFn, "/api/register/begin", { invitationCode, name });
  if (begin.kind === "error") return { ok: false, code: begin.code };
  if (!isCreationOptions(begin.body)) return { ok: false, code: "unknown" };

  let credential: Credential | null;
  try {
    const publicKey = statics.parseCreationOptionsFromJSON(begin.body.publicKey);
    credential = await credentials.create({ publicKey });
  } catch (error) {
    return { ok: false, code: classifyCredentialError(error) };
  }
  if (!isPublicKeyCredential(credential)) return { ok: false, code: "authenticator_failed" };

  const finish = await postJson(fetchFn, "/api/register/finish", {
    invitationCode,
    name,
    // Posted unmodified: the server accepts toJSON() output as-is.
    credential: credential.toJSON(),
  });
  if (finish.kind === "error") return { ok: false, code: finish.code };
  if (!isFinishBody(finish.body)) return { ok: false, code: "unknown" };
  return { ok: true, userId: finish.body.userId, role: finish.body.role };
}

export type SessionResult =
  /** A valid session cookie exists. */
  | { state: "signed_in" }
  /** The server answered 401: nobody is signed in. */
  | { state: "signed_out" }
  /** Network failure or unexpected answer: we can't tell. */
  | { state: "unknown" };

/**
 * GET /api/session. Registration is for people without an account session,
 * so the page asks first. Never throws.
 */
export async function fetchSession(
  fetchFn: typeof fetch = (...args) => fetch(...args),
  signal?: AbortSignal,
): Promise<SessionResult> {
  try {
    const response = await fetchFn("/api/session", {
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      signal,
    });
    if (response.status === 401) return { state: "signed_out" };
    if (!response.ok) return { state: "unknown" };
    const body = (await response.json()) as { userId?: unknown } | null;
    return typeof body?.userId === "string" ? { state: "signed_in" } : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}
