import { Link, Outlet, useLocation } from "react-router";
import { PasskeyDialog, type PasskeyDialogState } from "@/components/PasskeyDialog";
import { Button } from "@/components/ui/button";
import { AuthProvider, useAuth } from "@/lib/auth";
import { LOGIN_ERROR_MESSAGES } from "@/lib/passkeyMessages";
import { cn } from "@/lib/utils";

export function Layout() {
  return (
    <AuthProvider>
      <div className="min-h-screen">
        <NavBar />
        <Main />
      </div>
    </AuthProvider>
  );
}

/** Admin and agent screens hold tables, so they get more room than the prose pages. */
function Main() {
  const { pathname } = useLocation();
  // First-run is a prose page that shares the /admin prefix, so it keeps the narrow column.
  const wide =
    (pathname.startsWith("/admin") && pathname !== "/admin/first-run") ||
    pathname.startsWith("/agents");
  return (
    <main className={cn("mx-auto px-6 py-12", wide ? "max-w-6xl" : "max-w-3xl")}>
      <Outlet />
    </main>
  );
}

function NavBar() {
  const { pathname } = useLocation();
  const { session, busy, loggingIn, error, clearError, login, logout } = useAuth();
  const action = error?.action ?? "login";
  // Registering is for people without an account, so the register view has no login control.
  const showAuth = pathname !== "/register";

  // The interstitial covers the passkey ceremony only. A logout has no passkey step, so
  // it never waits in the dialog, but a failed one is reported there.
  // The error dialog is not gated on `showAuth`: the register page has its own Log out
  // button (when already signed in) whose failure would otherwise go unreported.
  let dialog: PasskeyDialogState | null = null;
  if (showAuth && loggingIn) dialog = { status: "waiting" };
  else if (error !== null) {
    dialog = { status: "error", message: LOGIN_ERROR_MESSAGES[error.code] };
  }

  return (
    <header className="border-b px-6 py-4">
      <div className="flex items-center justify-between gap-4">
        <Link to="/" className="font-medium tracking-tight">
          susu
        </Link>
        <div className="flex items-center gap-3">
          {session.state === "signed_in" && (
            <Link
              to="/agents"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Agents
            </Link>
          )}
          {session.state === "signed_in" && session.role === "admin" && (
            <Link
              to="/admin"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Admin
            </Link>
          )}
          {showAuth && session.state === "signed_in" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void logout()}
            >
              Log out
            </Button>
          )}
          {showAuth && session.state !== "signed_in" && session.state !== "loading" && (
            <Button type="button" size="sm" disabled={busy} onClick={() => void login()}>
              Login
            </Button>
          )}
        </div>
      </div>
      <PasskeyDialog
        action={action}
        state={dialog}
        onRetry={() => void (action === "logout" ? logout() : login())}
        onClose={clearError}
      />
    </header>
  );
}
