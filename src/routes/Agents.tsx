import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CopyField } from "@/components/CopyField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AdminError } from "@/lib/adminApi";
import {
  type Agent,
  type CreatedAgent,
  createAgent,
  describeAgentError,
  isValidAgentName,
  listAgents,
  MAX_NAME_CHARS,
  revokeAgent,
} from "@/lib/agents";
import { useAuth } from "@/lib/auth";
import { formatTimestamp, shortId } from "@/lib/format";

const INPUT_CLASS = "block w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

/**
 * Agents: software that acts for you with its own API key. Every user has them,
 * so unlike /admin there is no role gate, only a signed-in one. The server
 * re-checks the session on every call and answers 401 to anyone else.
 */
export function Agents() {
  const { session, login, busy } = useAuth();

  if (session.state === "loading") {
    return <p className="text-muted-foreground">Checking your session…</p>;
  }
  if (session.state === "signed_out") {
    return (
      <Notice title="Agents" body="Log in to create and manage your agents.">
        <Button type="button" disabled={busy} onClick={() => void login()}>
          Login
        </Button>
      </Notice>
    );
  }
  if (session.state === "unknown") {
    return (
      <Notice
        title="Agents"
        body="Can't reach the server to check your session. Reload the page to try again."
      />
    );
  }
  return <AgentList />;
}

function Notice({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground">{body}</p>
      {children}
    </section>
  );
}

/** Only mounted for a signed-in user, so it can load on mount. */
function AgentList() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [error, setError] = useState<AdminError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // The cursor being fetched, if this load is a "load more" rather than a fresh list.
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const [deleting, setDeleting] = useState<Agent | null>(null);

  // `tick` re-runs the load; it isn't read inside.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the reload trigger
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void listAgents(cursor, undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        // A later page is appended to the list already on screen; a fresh load replaces it.
        const { agents: page } = result.value;
        setAgents((current) => (cursor === undefined ? page : [...(current as Agent[]), ...page]));
        setNext(result.value.next);
        setError(null);
      } else {
        setError(result.error);
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [cursor, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  // The dialogs that edit the list are only reachable once it has loaded.
  const edit = (update: (list: Agent[]) => Agent[]) =>
    setAgents((current) => update(current as Agent[]));
  const loadMore = () => setCursor(next);

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Agents</h1>
          <p className="text-muted-foreground">
            An agent is software that acts for you, with its own API key. The key is shown once,
            when you create the agent.
          </p>
        </div>
        <Button type="button" disabled={agents === null} onClick={() => setCreating(true)}>
          New agent
        </Button>
      </header>

      {error !== null && (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 rounded-md border border-destructive/50 p-3 text-sm"
        >
          <span>{describeAgentError(error)}</span>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            Retry
          </Button>
        </div>
      )}

      {agents === null && error === null && loading && (
        <p className="text-muted-foreground">Loading agents…</p>
      )}

      {agents !== null && agents.length === 0 && (
        <p className="text-muted-foreground">You have no agents yet.</p>
      )}

      {agents !== null && agents.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/50 text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Agent
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Created
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {agents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} onDelete={() => setDeleting(agent)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {next !== undefined && (
        <Button type="button" variant="outline" disabled={loading} onClick={loadMore}>
          Load more
        </Button>
      )}

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(result) => {
            setCreating(false);
            setCreated(result);
            // Newest first, so the new agent goes on top.
            edit((list) => [result.agent, ...list]);
          }}
        />
      )}
      {created !== null && <KeyDialog created={created} onClose={() => setCreated(null)} />}
      {deleting !== null && (
        <DeleteDialog
          agent={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(revoked) => {
            setDeleting(null);
            edit((list) => list.map((item) => (item.id === revoked.id ? revoked : item)));
          }}
        />
      )}
    </section>
  );
}

function AgentRow({ agent, onDelete }: { agent: Agent; onDelete: () => void }) {
  const revoked = agent.status === "revoked";
  return (
    <tr>
      <td className="px-4 py-3">
        <div className="font-medium break-all">{agent.name}</div>
        <div className="font-mono text-xs text-muted-foreground" title={agent.id}>
          {shortId(agent.id)}
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={revoked ? "destructive" : "outline"}>
          {revoked ? "deleted" : agent.status}
        </Badge>
      </td>
      <td className="px-4 py-3 text-muted-foreground">{formatTimestamp(agent.createdAt)}</td>
      <td className="px-4 py-3 text-right">
        {!revoked && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Delete ${agent.name}`}
            onClick={onDelete}
          >
            Delete
          </Button>
        )}
      </td>
    </tr>
  );
}

/** Mounted only while creating, so the form starts empty each time. */
function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: CreatedAgent) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await createAgent(name.trim());
    setBusy(false);
    if (result.ok) onCreated(result.value);
    else setError(describeAgentError(result.error));
  };

  return (
    <Dialog
      open
      onOpenChange={() => {
        if (!busy) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>New agent</DialogTitle>
        <DialogDescription>
          You'll see the agent's API key once after creating it. Anything the agent does, it does as
          you.
        </DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="block space-y-1 text-sm font-medium">
            Name
            <input
              type="text"
              value={name}
              maxLength={MAX_NAME_CHARS}
              placeholder="What is this agent for?"
              onChange={(event) => setName(event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          {error !== null && (
            <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!isValidAgentName(name) || busy}>
              Create agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shows a new agent's API key. This is the only time the server ever returns it.
 * Mounted only while there is a key to show, so the "Copied" state resets each time.
 */
function KeyDialog({ created, onClose }: { created: CreatedAgent; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const { agent, key } = created;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(key.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  // Radix only ever asks to close (Escape, overlay): there is no trigger to open it.
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogTitle>Agent created</DialogTitle>
        <DialogDescription>
          Copy {agent.name}'s API key now: it can't be shown again. If you lose it, delete the agent
          and create a new one. The key expires on {formatTimestamp(key.expiresAt)}.
        </DialogDescription>
        <CopyField label="API key" value={key.token} copied={copied} onCopy={() => void copy()} />
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while an agent is being deleted, so its state starts fresh each time. */
function DeleteDialog({
  agent,
  onClose,
  onDeleted,
}: {
  agent: Agent;
  onClose: () => void;
  onDeleted: (agent: Agent) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const result = await revokeAgent(agent.id);
    setBusy(false);
    if (result.ok) onDeleted(result.value);
    else setError(describeAgentError(result.error));
  };

  return (
    <ConfirmDialog
      open
      title="Delete this agent?"
      description={`${agent.name} and its API key will stop working immediately. This can't be undone.`}
      confirmLabel="Delete agent"
      error={error}
      busy={busy}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    />
  );
}
