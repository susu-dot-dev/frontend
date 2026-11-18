import { Mail, Users } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { NavLink, Outlet } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

type Section = { to: string; label: string; icon: ComponentType<{ className?: string }> };

/** The admin sub-sections, in the order the left bar lists them. */
export const ADMIN_SECTIONS: readonly Section[] = [
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/invitations", label: "Invitations", icon: Mail },
];

/**
 * Shell for /admin/*: a left bar to pick a sub-section and the section itself
 * beside it (stacked above it on narrow screens).
 *
 * The gate here is a courtesy, not security: the role comes from the session
 * check, and the server re-checks it on every /api/user and /api/invitation
 * call, answering 401/403 to anyone else. The pages handle those answers too.
 */
export function AdminLayout() {
  const { session, login, busy } = useAuth();

  if (session.state === "loading") {
    return <p className="text-muted-foreground">Checking your session…</p>;
  }
  if (session.state === "signed_out") {
    return (
      <Notice title="Administration" body="Log in with an administrator account to continue.">
        <Button type="button" disabled={busy} onClick={() => void login()}>
          Login
        </Button>
      </Notice>
    );
  }
  if (session.state === "unknown") {
    return (
      <Notice
        title="Administration"
        body="Can't reach the server to check your session. Reload the page to try again."
      />
    );
  }
  if (session.role !== "admin") {
    return (
      <Notice
        title="Administrators only"
        body="Your account doesn't have access to this section."
      />
    );
  }

  return (
    <div className="flex flex-col gap-8 md:flex-row">
      <nav aria-label="Admin sections" className="md:w-52 md:shrink-0">
        <p className="px-3 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Administration
        </p>
        <ul className="flex gap-1 md:flex-col">
          {ADMIN_SECTIONS.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )
                }
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

function Notice({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground">{body}</p>
      {children}
    </section>
  );
}
