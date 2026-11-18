/**
 * Shared transport for authsu's admin endpoints (/api/user, /api/invitation).
 *
 * Every call needs the session cookie and, for anything but GET/HEAD, a JSON
 * Content-Type, even with an empty body (the server answers 415 otherwise).
 * Never throws: failures are values the UI can branch on.
 */

/** Why an admin call failed, in terms the UI branches on. */
export type AdminErrorKind =
  /** 401: no session, or it expired. */
  | "unauthenticated"
  /** 403: signed in, but not an administrator (the role is re-read on every request). */
  | "forbidden"
  /** 404: the user or invitation doesn't exist. */
  | "not_found"
  /** 409: the request conflicts with current state; `code` says how. */
  | "conflict"
  /** 400: the server rejected the input; `code` says which field. */
  | "invalid"
  /** 5xx: server or database unavailable. */
  | "unavailable"
  /** Network failure. */
  | "network"
  | "unknown";

export type AdminError = {
  kind: AdminErrorKind;
  /** The server's stable error code, e.g. "user_last_admin". */
  code: string | undefined;
  /** The server's `error.data`, e.g. `{ uses }` for num_invites_below_uses. */
  data: unknown;
};

export type AdminResult<T> = { ok: true; value: T } | { ok: false; error: AdminError };

/** Maps an HTTP status to what the UI branches on. */
export function classifyAdminStatus(status: number): AdminErrorKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400) return "invalid";
  if (status >= 500) return "unavailable";
  return "unknown";
}

/** Sends one request and returns the parsed body, or a classified failure. */
export async function adminRequest(
  fetchFn: typeof fetch,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  payload?: unknown,
  signal?: AbortSignal,
): Promise<AdminResult<unknown>> {
  let response: Response;
  try {
    response = await fetchFn(path, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal,
    });
  } catch {
    return { ok: false, error: { kind: "network", code: undefined, data: undefined } };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (response.ok) return { ok: true, value: body };

  const error = (body as { error?: { code?: unknown; data?: unknown } } | null | undefined)?.error;
  return {
    ok: false,
    error: {
      kind: classifyAdminStatus(response.status),
      code: typeof error?.code === "string" ? error.code : undefined,
      data: error?.data,
    },
  };
}

/** A response we couldn't make sense of, reported like any other failure. */
export const malformed = (): AdminResult<never> => ({
  ok: false,
  error: { kind: "unknown", code: undefined, data: undefined },
});

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Text for an error that has no more specific wording. */
export function describeAdminError(error: AdminError): string {
  switch (error.kind) {
    case "unauthenticated":
      return "Your session has ended. Log in again to continue.";
    case "forbidden":
      return "Only administrators can do this.";
    case "unavailable":
      return "The server isn't available right now. Try again in a moment.";
    case "network":
      return "Can't reach the server. Check your connection and try again.";
    case "not_found":
      return "That item no longer exists.";
    default:
      return "Something went wrong. Try again.";
  }
}
