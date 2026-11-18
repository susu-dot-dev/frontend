/**
 * Client for authsu's agent management (authsu docs/agents_design.md).
 *
 * An agent is software acting for the signed-in user. Every route acts for the
 * caller on their own agents only: there is no role check, and an agent of
 * another user is answered as one that does not exist.
 *
 * An agent's API key is returned exactly once, by the create call. It is not
 * stored, so a lost key is replaced by revoking the agent and creating another.
 */

import {
  type AdminError,
  type AdminResult,
  adminRequest,
  describeAdminError,
  isRecord,
  malformed,
} from "@/lib/adminApi";

/** Matches authsu's agents.MaxNameChars and MaxAgentsPerUser. */
export const MAX_NAME_CHARS = 256;
export const MAX_AGENTS_PER_USER = 25;

export type AgentStatus = "active" | "revoked";

export type Agent = {
  id: string;
  name: string;
  scopes: string;
  status: AgentStatus;
  /** Unix seconds. */
  revokedAt?: number;
  /** Unix seconds. */
  createdAt: number;
};

/** An agent's first API key, as the create call returns it. */
export type AgentKey = {
  id: string;
  /** The bearer token. Never returned again. */
  token: string;
  scope: string;
  /** Unix seconds. */
  expiresAt: number;
};

export type CreatedAgent = { agent: Agent; key: AgentKey };

/** One page of agents, newest first. */
export type AgentPage = {
  agents: Agent[];
  /** The cursor of the following page; undefined on the last page. */
  next?: string;
};

export function parseAgent(value: unknown): Agent | null {
  if (!isRecord(value)) return null;
  const { id, name, scopes, status, revokedAt, createdAt } = value;
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (typeof createdAt !== "number") return null;
  if (status !== "active" && status !== "revoked") return null;
  const agent: Agent = {
    id,
    name,
    scopes: typeof scopes === "string" ? scopes : "",
    status,
    createdAt,
  };
  if (typeof revokedAt === "number") agent.revokedAt = revokedAt;
  return agent;
}

function parseKey(value: unknown): AgentKey | null {
  if (!isRecord(value)) return null;
  const { id, token, scope, expiresAt } = value;
  if (typeof id !== "string" || typeof token !== "string" || token === "") return null;
  if (typeof expiresAt !== "number") return null;
  return { id, token, scope: typeof scope === "string" ? scope : "", expiresAt };
}

/** GET /api/agent: one page of the caller's agents, revoked ones included. */
export async function listAgents(
  cursor?: string,
  fetchFn: typeof fetch = (...args) => fetch(...args),
  signal?: AbortSignal,
): Promise<AdminResult<AgentPage>> {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  const result = await adminRequest(fetchFn, "GET", `/api/agent${query}`, undefined, signal);
  if (!result.ok) return result;
  const list = isRecord(result.value) ? result.value.agents : undefined;
  if (!Array.isArray(list)) return malformed();
  const agents: Agent[] = [];
  for (const item of list) {
    const agent = parseAgent(item);
    if (agent === null) return malformed();
    agents.push(agent);
  }
  const next = (result.value as { next?: unknown }).next;
  const page: AgentPage = { agents };
  if (typeof next === "string" && next !== "") page.next = next;
  return { ok: true, value: page };
}

/** POST /api/agent. The key in the answer can never be fetched again. */
export async function createAgent(
  name: string,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<AdminResult<CreatedAgent>> {
  const result = await adminRequest(fetchFn, "POST", "/api/agent", { name });
  if (!result.ok) return result;
  const body = isRecord(result.value) ? result.value : {};
  const agent = parseAgent(body.agent);
  const key = parseKey(body.key);
  if (agent === null || key === null) return malformed();
  return { ok: true, value: { agent, key } };
}

/**
 * DELETE /api/agent/{id}: revokes the agent and its keys. Idempotent and final;
 * the agent stays in the list as revoked.
 */
export async function revokeAgent(
  id: string,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<AdminResult<Agent>> {
  const result = await adminRequest(fetchFn, "DELETE", `/api/agent/${encodeURIComponent(id)}`);
  if (!result.ok) return result;
  const agent = parseAgent(result.value);
  return agent === null ? malformed() : { ok: true, value: agent };
}

/** Whether a name is acceptable before the round trip: not blank, within the limit. */
export const isValidAgentName = (name: string) =>
  name.trim() !== "" && [...name].length <= MAX_NAME_CHARS;

/** The wording for a failed agent call. */
export function describeAgentError(error: AdminError): string {
  switch (error.code) {
    case "invalid_agent_name":
    case "missing_agent_name":
      return `The name must be 1 to ${MAX_NAME_CHARS} printable characters.`;
    case "agent_limit_reached":
      return `An account can have at most ${MAX_AGENTS_PER_USER} active agents. Delete one to make room.`;
    case "agent_not_found":
      return "That agent no longer exists.";
    case "agent_revoked":
      return "This agent was already deleted, so it can't be changed.";
    default:
      // Agents are for every user, so the admin-only wording for 403 would mislead.
      if (error.kind === "forbidden") return "You don't have access to agents.";
      return describeAdminError(error);
  }
}
