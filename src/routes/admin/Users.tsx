import { useCallback, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { describeAdminError } from "@/lib/adminApi";
import { useAuth } from "@/lib/auth";
import { formatTimestamp, shortId } from "@/lib/format";
import { useAdminList } from "@/lib/useAdminList";
import { describeUserError, listUsers, revokeUser, type User, userName } from "@/lib/users";

/** Everyone with an account, and the ability to revoke one. */
export function Users() {
  const { session } = useAuth();
  // AdminLayout only renders this page for a signed-in administrator. If the session lapses
  // while it is open the layout swaps this page out, so `userId` is read only while present.
  const selfId = (session as { userId?: string }).userId;
  const load = useCallback((signal: AbortSignal) => listUsers(undefined, signal), []);
  const { items, error, loading, replace, reload } = useAdminList(load);

  const [target, setTarget] = useState<User | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const close = () => {
    setTarget(null);
    setRevokeError(null);
  };

  const confirm = async (user: User) => {
    setRevoking(true);
    setRevokeError(null);
    const result = await revokeUser(user.id);
    setRevoking(false);
    if (result.ok) {
      const revoked = result.value;
      replace((users) => users.map((row) => (row.id === revoked.id ? revoked : row)));
      setTarget(null);
    } else {
      setRevokeError(describeUserError(result.error));
    }
  };

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
        <p className="text-muted-foreground">
          Everyone with an account. Revoking a user ends their access for good: it can't be undone.
        </p>
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
        <p className="text-muted-foreground">Loading users…</p>
      )}

      {items !== null && items.length === 0 && (
        <p className="text-muted-foreground">There are no users yet.</p>
      )}

      {items !== null && items.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/50 text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Role
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Joined
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  isSelf={user.id === selfId}
                  onRevoke={() => setTarget(user)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {target !== null && (
        <ConfirmDialog
          open
          title="Revoke this user?"
          description={
            <>
              <strong>{userName(target) ?? `User ${shortId(target.id)}`}</strong> will lose access
              immediately. This can't be undone.
              {target.id === selfId && " This is your own account."}
            </>
          }
          confirmLabel="Revoke user"
          error={revokeError}
          busy={revoking}
          onConfirm={() => void confirm(target)}
          onCancel={close}
        />
      )}
    </section>
  );
}

function UserRow({
  user,
  isSelf,
  onRevoke,
}: {
  user: User;
  isSelf: boolean;
  onRevoke: () => void;
}) {
  const name = userName(user);
  const revoked = user.status === "revoked";
  return (
    <tr>
      <td className="px-4 py-3">
        <div className="font-medium">
          {name ?? <span className="text-muted-foreground">Unnamed</span>}
          {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
        </div>
        <div className="font-mono text-xs text-muted-foreground" title={user.id}>
          {shortId(user.id)}
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={user.role === "admin" ? "default" : "secondary"}>{user.role}</Badge>
      </td>
      <td className="px-4 py-3">
        {revoked ? (
          <Badge variant="destructive">
            Revoked{user.revokedAt !== undefined && ` ${formatTimestamp(user.revokedAt)}`}
          </Badge>
        ) : (
          <Badge variant="outline">Active</Badge>
        )}
      </td>
      <td className="px-4 py-3 text-muted-foreground">{formatTimestamp(user.createdAt)}</td>
      <td className="px-4 py-3 text-right">
        {!revoked && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Revoke ${name ?? shortId(user.id)}`}
            onClick={onRevoke}
          >
            Revoke
          </Button>
        )}
      </td>
    </tr>
  );
}
