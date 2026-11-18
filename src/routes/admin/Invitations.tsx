import { useCallback, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CopyField } from "@/components/CopyField";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { describeAdminError } from "@/lib/adminApi";
import { formatTimestamp, shortId } from "@/lib/format";
import {
  type CreatableInvitationType,
  type CreatedInvitation,
  createInvitation,
  describeInvitationError,
  type Invitation,
  type InvitationStatus,
  inviteLink,
  isValidLabel,
  isValidNumInvites,
  listInvitations,
  MAX_LABEL_CHARS,
  MAX_NUM_INVITES,
  normalizeLabel,
  revokeInvitation,
  updateNumInvites,
} from "@/lib/invitations";
import { useAdminList } from "@/lib/useAdminList";

const STATUS_VARIANT: Record<InvitationStatus, BadgeProps["variant"]> = {
  active: "outline",
  revoked: "destructive",
  expired: "secondary",
  exhausted: "secondary",
};

const INPUT_CLASS = "block w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

/** Invitations: who can still join, how to invite someone new, and how to stop an invite. */
export function Invitations() {
  const load = useCallback((signal: AbortSignal) => listInvitations(undefined, signal), []);
  const { items, error, loading, replace, reload } = useAdminList(load);

  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [editing, setEditing] = useState<Invitation | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Invitations</h1>
          <p className="text-muted-foreground">
            An invitation code lets someone create an account. Codes are shown once, when you create
            them.
          </p>
        </div>
        <Button type="button" onClick={() => setCreating(true)}>
          New invitation
        </Button>
      </header>

      {error !== null && (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 rounded-md border border-destructive/50 p-3 text-sm"
        >
          <span>{describeAdminError(error)}</span>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            Retry
          </Button>
        </div>
      )}

      {items === null && error === null && loading && (
        <p className="text-muted-foreground">Loading invitations…</p>
      )}

      {items !== null && items.length === 0 && (
        <p className="text-muted-foreground">There are no invitations yet.</p>
      )}

      {items !== null && items.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/50 text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Invitation
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Used
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Expires
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
              {items.map((invitation) => (
                <InvitationRow
                  key={invitation.id}
                  invitation={invitation}
                  onEdit={() => setEditing(invitation)}
                  onRevoke={() => setRevoking(invitation)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(invitation) => {
            setCreating(false);
            setCreated(invitation);
            // The list shows everything but the code; the created row is just the newest.
            const { code: _code, ...row } = invitation;
            replace((list) => [row, ...list]);
          }}
        />
      )}
      {created !== null && <CodeDialog invitation={created} onClose={() => setCreated(null)} />}
      {editing !== null && (
        <EditDialog
          invitation={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            replace((list) => list.map((item) => (item.id === saved.id ? saved : item)));
          }}
        />
      )}
      {revoking !== null && (
        <RevokeDialog
          invitation={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={(revoked) => {
            setRevoking(null);
            replace((list) => list.map((item) => (item.id === revoked.id ? revoked : item)));
          }}
        />
      )}
    </section>
  );
}

function InvitationRow({
  invitation,
  onEdit,
  onRevoke,
}: {
  invitation: Invitation;
  onEdit: () => void;
  onRevoke: () => void;
}) {
  const name = invitation.label === "" ? shortId(invitation.id) : invitation.label;
  const revoked = invitation.status === "revoked";
  return (
    <tr>
      <td className="px-4 py-3">
        <div className="font-medium">
          {invitation.label === "" ? (
            <span className="text-muted-foreground">No label</span>
          ) : (
            invitation.label
          )}
        </div>
        <div className="font-mono text-xs text-muted-foreground" title={invitation.id}>
          {shortId(invitation.id)}
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={STATUS_VARIANT[invitation.status]}>{invitation.status}</Badge>
      </td>
      <td className="px-4 py-3 tabular-nums">
        {invitation.uses} / {invitation.numInvites}
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        {invitation.expiresAt === undefined ? "Never" : formatTimestamp(invitation.expiresAt)}
      </td>
      <td className="px-4 py-3 text-muted-foreground">{formatTimestamp(invitation.createdAt)}</td>
      <td className="px-4 py-3 text-right">
        {!revoked && (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Edit limit of ${name}`}
              onClick={onEdit}
            >
              Edit
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Revoke ${name}`}
              onClick={onRevoke}
            >
              Revoke
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

/** Converts a `datetime-local` value (local time) to Unix seconds, or undefined if empty/invalid. */
export function parseExpiry(value: string): number | undefined {
  if (value === "") return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** Mounted only while creating, so the form starts empty each time. */
function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (invitation: CreatedInvitation) => void;
}) {
  const [type, setType] = useState<CreatableInvitationType>("member");
  const [label, setLabel] = useState("");
  const [numInvites, setNumInvites] = useState("1");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = Number(numInvites);
  const expiresAt = parseExpiry(expires);
  const valid =
    numInvites.trim() !== "" &&
    isValidNumInvites(count) &&
    isValidLabel(label) &&
    (expires === "" || (expiresAt !== undefined && expiresAt * 1000 > Date.now()));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await createInvitation({
      type,
      numInvites: count,
      label: normalizeLabel(label),
      expiresAt,
    });
    setBusy(false);
    if (result.ok) {
      onCreated(result.value);
    } else {
      setError(describeInvitationError(result.error));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={() => {
        if (!busy) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>New invitation</DialogTitle>
        <DialogDescription>
          You'll see the code once after creating it. Share it with the person you're inviting.
        </DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="block space-y-1 text-sm font-medium">
            Account type
            <select
              value={type}
              onChange={(event) => setType(event.target.value as CreatableInvitationType)}
              className={INPUT_CLASS}
            >
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm font-medium">
            Label (optional)
            <input
              type="text"
              value={label}
              maxLength={MAX_LABEL_CHARS}
              placeholder="Who or what is this for?"
              onChange={(event) => setLabel(event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="block space-y-1 text-sm font-medium">
            Number of accounts it can create
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_NUM_INVITES}
              step={1}
              value={numInvites}
              onChange={(event) => setNumInvites(event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="block space-y-1 text-sm font-medium">
            Expires (optional)
            <input
              type="datetime-local"
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
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
            <Button type="submit" disabled={!valid || busy}>
              Create invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shows a new invitation's code. This is the only time the server ever returns it.
 * Mounted only while there is a code to show, so the "Copied" state resets each time.
 */
function CodeDialog({
  invitation,
  onClose,
}: {
  invitation: CreatedInvitation;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const link = inviteLink(invitation.code);

  const copy = async (kind: "code" | "link", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      setCopied(null);
    }
  };

  // Radix only ever asks to close (Escape, overlay): there is no trigger to open it.
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogTitle>Invitation created</DialogTitle>
        <DialogDescription>
          Copy this now: it can't be shown again. If you lose it, revoke the invitation and make a
          new one.
        </DialogDescription>
        <CopyField
          label="Invitation code"
          value={invitation.code}
          copied={copied === "code"}
          onCopy={() => void copy("code", invitation.code)}
        />
        <CopyField
          label="Invitation link"
          value={link}
          copied={copied === "link"}
          onCopy={() => void copy("link", link)}
        />
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while editing, so the field starts from the current limit each time. */
function EditDialog({
  invitation,
  onClose,
  onSaved,
}: {
  invitation: Invitation;
  onClose: () => void;
  onSaved: (invitation: Invitation) => void;
}) {
  const [value, setValue] = useState(String(invitation.numInvites));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = Number(value);
  // The server refuses a limit below the uses so far, so say so before the round trip.
  const valid = value.trim() !== "" && isValidNumInvites(count) && count >= invitation.uses;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await updateNumInvites(invitation.id, count);
    setBusy(false);
    if (result.ok) onSaved(result.value);
    else setError(describeInvitationError(result.error));
  };

  return (
    <Dialog
      open
      onOpenChange={() => {
        if (!busy) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Change the limit</DialogTitle>
        <DialogDescription>
          {invitation.label === "" ? `Invitation ${shortId(invitation.id)}` : invitation.label} has
          been used {invitation.uses} {invitation.uses === 1 ? "time" : "times"}.
        </DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="block space-y-1 text-sm font-medium">
            Number of accounts it can create
            <input
              type="number"
              inputMode="numeric"
              min={Math.max(1, invitation.uses)}
              max={MAX_NUM_INVITES}
              step={1}
              value={value}
              onChange={(event) => setValue(event.target.value)}
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
            <Button type="submit" disabled={!valid || busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while an invitation is being revoked, so its state starts fresh each time. */
function RevokeDialog({
  invitation,
  onClose,
  onRevoked,
}: {
  invitation: Invitation;
  onClose: () => void;
  onRevoked: (invitation: Invitation) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const result = await revokeInvitation(invitation.id);
    setBusy(false);
    if (result.ok) onRevoked(result.value);
    else setError(describeInvitationError(result.error));
  };

  const name = invitation.label === "" ? `Invitation ${shortId(invitation.id)}` : invitation.label;
  return (
    <ConfirmDialog
      open
      title="Revoke this invitation?"
      description={`${name} will stop working immediately. Accounts already created from it are not affected. This can't be undone.`}
      confirmLabel="Revoke invitation"
      error={error}
      busy={busy}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    />
  );
}
