import { Link, Outlet, useLocation } from "react-router";
import { PasskeyDialog, type PasskeyDialogState } from "@/components/PasskeyDialog";
import { Button } from "@/components/ui/button";
import { AuthProvider, useAuth } from "@/lib/auth";
import { LOGIN_ERROR_MESSAGES } from "@/lib/passkeyMessages";

export function Layout() {
  return (
    <AuthProvider>
      <div className="min-h-screen">
        <NavBar />
        <main className="mx-auto max-w-3xl px-6 py-12">
          <Outlet />
        </main>
      </div>
    </AuthProvider>
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
      <PasskeyDialog
        action={action}
        state={dialog}
        onRetry={() => void (action === "logout" ? logout() : login())}
        onClose={clearError}
      />
    </header>
  );
}
