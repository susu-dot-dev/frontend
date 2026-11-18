import { useCallback, useEffect, useState } from "react";
import type { AdminError, AdminResult } from "@/lib/adminApi";

export type AdminListState<T> = {
  /** null until the first load answers. The last good list is kept across a failed reload. */
  items: T[] | null;
  /** The last load's failure, or null if it succeeded. */
  error: AdminError | null;
  /** True while a load is in flight. */
  loading: boolean;
  /** Replaces one row in place, e.g. with what the server returned after a revoke. */
  replace(update: (items: T[]) => T[]): void;
  reload(): void;
};

/** Loads a list on mount and on `reload()`, ignoring answers that arrive after unmount. */
export function useAdminList<T>(
  load: (signal: AbortSignal) => Promise<AdminResult<T[]>>,
): AdminListState<T> {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<AdminError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // `tick` re-runs the load; it isn't read inside.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the reload trigger
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setItems(result.value);
        setError(null);
      } else {
        setError(result.error);
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [load, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const replace = useCallback(
    // Before the first load there is nothing to replace in.
    (update: (items: T[]) => T[]) => setItems((current) => (current && update(current)) ?? null),
    [],
  );

  return { items, error, loading, replace, reload };
}
