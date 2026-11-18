/**
 * Client for authsu's user administration (authsu docs/users_design.md).
 * Admin-only. Revoking is final: there is no un-revoke.
 */

import {
  type AdminError,
  type AdminResult,
  adminRequest,
  describeAdminError,
  isRecord,
  malformed,
} from "@/lib/adminApi";

export type User = {
  id: string;
  /** "admin" or "member". */
  role: string;
  invitationId: string;
  /** The free-form profile; registration stores `{ name }`. */
  profile: Record<string, unknown>;
  status: "active" | "revoked";
  /** Unix seconds; present once revoked. */
  revokedAt?: number;
  /** Unix seconds. */
  createdAt: number;
};

/** The name given at registration, or null if the profile has none. */
export function userName(user: Pick<User, "profile">): string | null {
  const { name } = user.profile;
  return typeof name === "string" && name !== "" ? name : null;
}

export function parseUser(value: unknown): User | null {
  if (!isRecord(value)) return null;
  const { id, role, invitationId, profile, status, revokedAt, createdAt } = value;
  if (typeof id !== "string" || typeof role !== "string") return null;
  if (typeof invitationId !== "string" || typeof createdAt !== "number") return null;
  if (status !== "active" && status !== "revoked") return null;
  const user: User = {
    id,
    role,
    invitationId,
    profile: isRecord(profile) ? profile : {},
    status,
    createdAt,
  };
  if (typeof revokedAt === "number") user.revokedAt = revokedAt;
  return user;
}

/** GET /api/user: every user, newest first, revoked ones included. */
export async function listUsers(
  fetchFn: typeof fetch = (...args) => fetch(...args),
  signal?: AbortSignal,
): Promise<AdminResult<User[]>> {
  const result = await adminRequest(fetchFn, "GET", "/api/user", undefined, signal);
  if (!result.ok) return result;
  const list = isRecord(result.value) ? result.value.users : undefined;
  if (!Array.isArray(list)) return malformed();
  const users: User[] = [];
  for (const item of list) {
    const user = parseUser(item);
    if (user === null) return malformed();
    users.push(user);
  }
  return { ok: true, value: users };
}

/** DELETE /api/user/{id}: idempotent, so revoking twice is not an error. */
export async function revokeUser(
  id: string,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<AdminResult<User>> {
  const result = await adminRequest(fetchFn, "DELETE", `/api/user/${encodeURIComponent(id)}`);
  if (!result.ok) return result;
  const user = parseUser(result.value);
  return user === null ? malformed() : { ok: true, value: user };
}

/** The wording for a failed user call. */
export function describeUserError(error: AdminError): string {
  if (error.kind === "conflict" && error.code === "user_last_admin") {
    return "This is the last active administrator. Revoking it would lock everyone out.";
  }
  return describeAdminError(error);
}
