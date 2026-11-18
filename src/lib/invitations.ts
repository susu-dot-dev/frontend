/**
 * Client for authsu's invitation administration (authsu docs/invitations_design.md).
 * Admin-only.
 *
 * An invitation's code is returned exactly once, by the create call. It is not
 * stored, so a lost code is revoked and replaced.
 */

import {
  type AdminError,
  type AdminResult,
  adminRequest,
  describeAdminError,
  isRecord,
  malformed,
} from "@/lib/adminApi";

/** Matches authsu's invitations.MaxNumInvites and MaxLabelChars. */
export const MAX_NUM_INVITES = 10_000;
export const MAX_LABEL_CHARS = 256;

/**
 * The type new invitations are created with. The server decides which types
 * are creatable (and the role each grants); at the time of writing it has none,
 * so creating is refused with `invalid_invitation_type` until it adds one.
 */
export const CREATE_INVITATION_TYPE = "member";

export type InvitationStatus = "active" | "revoked" | "expired" | "exhausted";

export type Invitation = {
  id: string;
  type: string;
  label: string;
  numInvites: number;
  uses: number;
  status: InvitationStatus;
  /** Unix seconds. */
  expiresAt?: number;
  /** Unix seconds. */
  revokedAt?: number;
  createdBy?: string;
  /** Unix seconds. */
  createdAt: number;
};

/** A just-created invitation, with the one-time code. */
export type CreatedInvitation = Invitation & { code: string };

const STATUSES: readonly string[] = [
  "active",
  "revoked",
  "expired",
  "exhausted",
] satisfies InvitationStatus[];

export function parseInvitation(value: unknown): Invitation | null {
  if (!isRecord(value)) return null;
  const { id, type, label, numInvites, uses, status, expiresAt, revokedAt, createdBy, createdAt } =
    value;
  if (typeof id !== "string" || typeof type !== "string") return null;
  if (typeof numInvites !== "number" || typeof uses !== "number") return null;
  if (typeof createdAt !== "number") return null;
  if (typeof status !== "string" || !STATUSES.includes(status)) return null;
  const invitation: Invitation = {
    id,
    type,
    label: typeof label === "string" ? label : "",
    numInvites,
    uses,
    status: status as InvitationStatus,
    createdAt,
  };
  if (typeof expiresAt === "number") invitation.expiresAt = expiresAt;
  if (typeof revokedAt === "number") invitation.revokedAt = revokedAt;
  if (typeof createdBy === "string") invitation.createdBy = createdBy;
  return invitation;
}

const parseOne = (result: AdminResult<unknown>): AdminResult<Invitation> => {
  if (!result.ok) return result;
  const invitation = parseInvitation(result.value);
  return invitation === null ? malformed() : { ok: true, value: invitation };
};

/** GET /api/invitation: every invitation, newest first, revoked ones included. */
export async function listInvitations(
  fetchFn: typeof fetch = (...args) => fetch(...args),
  signal?: AbortSignal,
): Promise<AdminResult<Invitation[]>> {
  const result = await adminRequest(fetchFn, "GET", "/api/invitation", undefined, signal);
  if (!result.ok) return result;
  const list = isRecord(result.value) ? result.value.invitations : undefined;
  if (!Array.isArray(list)) return malformed();
  const invitations: Invitation[] = [];
  for (const item of list) {
    const invitation = parseInvitation(item);
    if (invitation === null) return malformed();
    invitations.push(invitation);
  }
  return { ok: true, value: invitations };
}

export type CreateInput = {
  numInvites: number;
  label: string;
  /** Unix seconds, or undefined for an invitation that doesn't expire. */
  expiresAt?: number;
};

/** POST /api/invitation. The code in the answer can never be fetched again. */
export async function createInvitation(
  input: CreateInput,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<AdminResult<CreatedInvitation>> {
  const result = await adminRequest(fetchFn, "POST", "/api/invitation", {
    type: CREATE_INVITATION_TYPE,
    numInvites: input.numInvites,
    label: input.label,
    expiresAt: input.expiresAt,
  });
  if (!result.ok) return result;
  const invitation = parseInvitation(result.value);
  const code = (result.value as { code?: unknown }).code;
  if (invitation === null || typeof code !== "string" || code === "") return malformed();
  return { ok: true, value: { ...invitation, code } };
}

/** PATCH /api/invitation/{id}: change how many accounts it may create. */
export async function updateNumInvites(
  id: string,
  numInvites: number,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<AdminResult<Invitation>> {
  return parseOne(
    await adminRequest(fetchFn, "PATCH", `/api/invitation/${encodeURIComponent(id)}`, {
      numInvites,
    }),
  );
}

/** DELETE /api/invitation/{id}: idempotent, final. */
export async function revokeInvitation(
  id: string,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<AdminResult<Invitation>> {
  return parseOne(
    await adminRequest(fetchFn, "DELETE", `/api/invitation/${encodeURIComponent(id)}`),
  );
}

/** What the invitee opens. The code rides in the fragment so it never reaches a server log. */
export const inviteLink = (code: string, origin: string = window.location.origin) =>
  `${origin}/register#${code}`;

/** Whether a whole-number invitation count is within the server's limits. */
export const isValidNumInvites = (n: number) =>
  Number.isInteger(n) && n >= 1 && n <= MAX_NUM_INVITES;

/** The wording for a failed invitation call. */
export function describeInvitationError(error: AdminError): string {
  switch (error.code) {
    case "invalid_invitation_type":
      return "The server isn't accepting new invitations yet: it has no invitation type enabled for creation.";
    case "invalid_num_invites":
    case "missing_num_invites":
      return `The number of invites must be a whole number from 1 to ${MAX_NUM_INVITES}.`;
    case "invalid_label":
      return `The label can be at most ${MAX_LABEL_CHARS} characters.`;
    case "invalid_expires_at":
      return "The expiry must be in the future.";
    case "invitation_revoked":
      return "This invitation was revoked, so it can't be changed.";
    case "num_invites_below_uses": {
      const uses = (error.data as { uses?: unknown } | null | undefined)?.uses;
      return typeof uses === "number"
        ? `It has already been used ${uses} ${uses === 1 ? "time" : "times"}, so the limit can't go below that.`
        : "The limit can't go below the number of times it has been used.";
    }
    default:
      return describeAdminError(error);
  }
}
