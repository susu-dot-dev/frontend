import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type LoginErrorCode, login as runLogin, logout as runLogout } from "@/lib/login";
import { fetchSession, type SessionResult } from "@/lib/register";

/**
 * Whether the user is signed in. The session cookie is HttpOnly, so script
 * cannot see it, not even whether it exists (document.cookie omits it). The
 * only way to know is to ask the server: GET /api/session answers 200 or 401.
 */
export type AuthState = {
  /** "loading" until the first /api/session answer arrives. */
  session: SessionResult | { state: "loading" };
  /** True while a login or logout is in flight. */
  busy: boolean;
  /** True only while the login passkey ceremony is in flight. */
  loggingIn: boolean;
  /** The last login or logout failure, cleared when the next attempt starts or it is dismissed. */
  error: { action: "login" | "logout"; code: LoginErrorCode } | null;
  /** Dismisses `error`. */
  clearError(): void;
  login(): Promise<boolean>;
  logout(): Promise<boolean>;
  /** Re-asks the server. */
  refresh(): Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthState["session"]>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<AuthState["error"]>(null);
  // `busy` state lags a render, so guard re-entrancy synchronously.
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    setSession(await fetchSession());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSession(undefined, controller.signal).then((result) => {
      if (!controller.signal.aborted) setSession(result);
    });
    return () => controller.abort();
  }, []);

  const login = useCallback(async () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setLoggingIn(true);
    setError(null);
    const result = await runLogin();
    if (result.ok) {
      // Ask the server rather than assume: it is the only one who can see the cookie.
      await refresh();
    } else {
      setError({ action: "login", code: result.code });
    }
    setLoggingIn(false);
    setBusy(false);
    inFlight.current = false;
    return result.ok;
  }, [refresh]);

  const logout = useCallback(async () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await runLogout();
    if (result.ok) {
      setSession({ state: "signed_out" });
    } else {
      setError({ action: "logout", code: result.code });
    }
    setBusy(false);
    inFlight.current = false;
    return result.ok;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo(
    () => ({ session, busy, loggingIn, error, clearError, login, logout, refresh }),
    [session, busy, loggingIn, error, clearError, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
