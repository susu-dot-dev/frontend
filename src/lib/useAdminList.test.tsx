import { describe, expect, test } from "@rstest/core";
import { act, render } from "@testing-library/react";
import type { AdminResult } from "./adminApi";
import { type AdminListState, useAdminList } from "./useAdminList";

const ref: { current: AdminListState<number> | null } = { current: null };

const Probe = ({ load }: { load: (signal: AbortSignal) => Promise<AdminResult<number[]>> }) => {
  ref.current = useAdminList(load);
  return null;
};

const ok = (value: number[]): AdminResult<number[]> => ({ ok: true, value });
const fail = (): AdminResult<number[]> => ({
  ok: false,
  error: { kind: "network", code: undefined, data: undefined },
});

describe("useAdminList", () => {
  test("loads, exposes the items, and replaces them in place", async () => {
    const load = async () => ok([1, 2]);
    render(<Probe load={load} />);
    expect(ref.current?.loading).toBe(true);
    expect(ref.current?.items).toBeNull();
    await act(async () => {});
    expect(ref.current).toMatchObject({ items: [1, 2], error: null, loading: false });

    await act(async () => ref.current?.replace((items) => items.map((n) => n * 10)));
    expect(ref.current?.items).toEqual([10, 20]);
  });

  test("replace before the first load leaves the list unset", async () => {
    render(<Probe load={() => new Promise(() => {})} />);
    await act(async () => ref.current?.replace((items) => [...items, 1]));
    expect(ref.current?.items).toBeNull();
  });

  test("a failed reload reports the error and keeps the last good list", async () => {
    let answer = ok([1]);
    const load = async () => answer;
    render(<Probe load={load} />);
    await act(async () => {});

    answer = fail();
    await act(async () => ref.current?.reload());
    expect(ref.current?.error?.kind).toBe("network");
    expect(ref.current?.items).toEqual([1]);

    answer = ok([2]);
    await act(async () => ref.current?.reload());
    expect(ref.current).toMatchObject({ items: [2], error: null });
  });

  test("an answer that arrives after unmount is ignored", async () => {
    let finish: (r: AdminResult<number[]>) => void = () => {};
    const load = () =>
      new Promise<AdminResult<number[]>>((resolve) => {
        finish = resolve;
      });
    const { unmount } = render(<Probe load={load} />);
    unmount();
    await act(async () => finish(ok([9])));
    expect(ref.current?.items).toBeNull();
  });
});
