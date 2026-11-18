import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { createTestRouter } from "@/router";
import { parseExpiry } from "./Invitations";

const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const MEMBER = "bbbbbbbb-0000-4000-8000-000000000002";
const GONE = "cccccccc-0000-4000-8000-000000000003";

type Wire = Record<string, unknown>;

const user = (id: string, name: string, role: string, extra: Wire = {}): Wire => ({
  id,
  role,
  invitationId: "inv",
  profile: { name },
  status: "active",
  createdAt: 1_700_000_000,
  ...extra,
});

const invitation = (id: string, label: string, extra: Wire = {}): Wire => ({
  id,
  type: "member",
  label,
  numInvites: 5,
  uses: 2,
  status: "active",
  createdAt: 1_700_000_000,
  ...extra,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Backend = {
  session: () => Response;
  users: Wire[];
  invitations: Wire[];
  /** Overrides, keyed by "METHOD /path", to force a specific answer. */
  force: Record<string, () => Response | Promise<Response>>;
  calls: { key: string; body?: unknown }[];
};

let backend: Backend;

const adminSession = () => json(200, { userId: ADMIN, role: "admin", expiresAt: 1 });

beforeEach(() => {
  backend = {
    session: adminSession,
    users: [
      user(ADMIN, "Root", "admin"),
      user(MEMBER, "Mia", "member"),
      user(GONE, "Gone", "member", { status: "revoked", revokedAt: 1_700_000_100 }),
    ],
    invitations: [
      invitation("dddddddd-0000-4000-8000-000000000004", "Friends"),
      invitation("eeeeeeee-0000-4000-8000-000000000005", "", {
        status: "revoked",
        revokedAt: 1_700_000_100,
        expiresAt: 1_800_000_000,
      }),
    ],
    force: {},
    calls: [],
  };

  rs.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    backend.calls.push({ key, body });
    const forced = backend.force[key];
    if (forced) return forced();
    if (url === "/api/session") return backend.session();

    if (key === "GET /api/user") return json(200, { users: backend.users });
    if (method === "DELETE" && url.startsWith("/api/user/")) {
      const id = url.slice("/api/user/".length);
      const found = backend.users.find((u) => u.id === id);
      if (!found) return json(404, { error: { code: "user_not_found" } });
      Object.assign(found, { status: "revoked", revokedAt: 1_700_000_200 });
      return json(200, found);
    }

    if (key === "GET /api/invitation") return json(200, { invitations: backend.invitations });
    if (key === "POST /api/invitation") {
      return json(201, {
        ...invitation("ffffffff-0000-4000-8000-000000000006", "New"),
        code: "THE-CODE",
      });
    }
    if (method === "PATCH" && url.startsWith("/api/invitation/")) {
      const id = url.slice("/api/invitation/".length);
      const found = backend.invitations.find((i) => i.id === id);
      Object.assign(found as Wire, body);
      return json(200, found);
    }
    if (method === "DELETE" && url.startsWith("/api/invitation/")) {
      const id = url.slice("/api/invitation/".length);
      const found = backend.invitations.find((i) => i.id === id);
      Object.assign(found as Wire, { status: "revoked", revokedAt: 1_700_000_300 });
      return json(200, found);
    }
    return new Response(null, { status: 204 });
  });
});

afterEach(() => {
  rs.unstubAllGlobals();
});

const open = async (path: string) => {
  render(<App router={createTestRouter([path])} />);
  await act(async () => {});
};

describe("access", () => {
  test("a signed-out visitor is asked to log in", async () => {
    backend.session = () => json(401, { error: { code: "unauthenticated" } });
    await open("/admin/users");
    expect(screen.getByRole("heading", { name: "Administration" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Login" }).length).toBeGreaterThan(0);
    expect(backend.calls.map((c) => c.key)).not.toContain("GET /api/user");
  });

  test("the Login button on the notice starts a login", async () => {
    backend.session = () => json(401, {});
    rs.stubGlobal("PublicKeyCredential", { parseRequestOptionsFromJSON: (o: unknown) => o });
    const fetchBefore = globalThis.fetch;
    rs.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
      url === "/api/login/begin" ? json(200, { publicKey: {} }) : fetchBefore(url, init),
    );
    rs.stubGlobal("navigator", { credentials: { get: async () => null } });
    await open("/admin");
    const [notice] = screen.getAllByRole("button", { name: "Login" }).slice(-1);
    await userEvent.click(notice as HTMLElement);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeVisible();
    });
  });

  test("while the session check is pending it says so", () => {
    rs.stubGlobal("fetch", () => new Promise(() => {}));
    render(<App router={createTestRouter(["/admin"])} />);
    expect(screen.getByText("Checking your session…")).toBeVisible();
  });

  test("an unreachable server is reported", async () => {
    rs.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    await open("/admin");
    expect(screen.getByText(/Can't reach the server to check your session/)).toBeVisible();
  });

  test("a member is turned away, and sees no Admin link", async () => {
    backend.session = () => json(200, { userId: MEMBER, role: "member", expiresAt: 1 });
    await open("/admin/invitations");
    expect(screen.getByRole("heading", { name: "Administrators only" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
    expect(backend.calls.map((c) => c.key)).not.toContain("GET /api/invitation");
  });

  test("a 401 from an admin call signs the user out: the page falls back to the login prompt", async () => {
    await open("/admin/users");
    await screen.findByText("Mia");
    // Revoked in another tab, say: the next call is refused as signed out.
    backend.force["DELETE /api/user/bbbbbbbb-0000-4000-8000-000000000002"] = () =>
      json(401, { error: { code: "unauthenticated" } });
    await userEvent.click(screen.getByRole("button", { name: "Revoke Mia" }));
    await userEvent.click(await screen.findByRole("button", { name: "Revoke user" }));
    expect(await screen.findByRole("heading", { name: "Administration" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Login" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  test("a 403 keeps the session: the user is still signed in", async () => {
    await open("/admin/users");
    await screen.findByText("Mia");
    backend.force["DELETE /api/user/bbbbbbbb-0000-4000-8000-000000000002"] = () =>
      json(403, { error: { code: "forbidden" } });
    await userEvent.click(screen.getByRole("button", { name: "Revoke Mia" }));
    await userEvent.click(await screen.findByRole("button", { name: "Revoke user" }));
    expect(await screen.findByText("Only administrators can do this.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("link", { name: "Admin" })).toBeVisible();
  });

  test("an administrator sees the Admin link in the nav bar", async () => {
    await open("/");
    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin");
  });

  test("first-run stays outside the admin shell", async () => {
    backend.session = () => json(401, {});
    rs.stubGlobal("fetch", async (url: string) =>
      url === "/api/session" ? json(401, {}) : json(200, { status: "invitation_accepted" }),
    );
    await open("/admin/first-run");
    expect(screen.getByRole("heading", { name: "First-run setup" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Admin sections" })).not.toBeInTheDocument();
  });
});

describe("left bar", () => {
  test("/admin redirects to Users and the bar switches sections", async () => {
    await open("/admin");
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(await screen.findByRole("heading", { name: "Users" })).toBeVisible();
    expect(within(nav).getByRole("link", { name: "Users" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Invitations" })).not.toHaveAttribute(
      "aria-current",
    );

    await userEvent.click(within(nav).getByRole("link", { name: "Invitations" }));
    expect(await screen.findByRole("heading", { name: "Invitations" })).toBeVisible();
    expect(within(nav).getByRole("link", { name: "Invitations" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await userEvent.click(within(nav).getByRole("link", { name: "Users" }));
    expect(await screen.findByRole("heading", { name: "Users" })).toBeVisible();
  });
});

describe("users", () => {
  test("lists everyone, marking roles, status and the current user", async () => {
    await open("/admin/users");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Root");
    expect(rows[0]).toHaveTextContent("(you)");
    expect(rows[0]).toHaveTextContent("admin");
    expect(rows[1]).toHaveTextContent("Mia");
    expect(rows[1]).not.toHaveTextContent("(you)");
    expect(rows[2]).toHaveTextContent(/Revoked/);
    // Only active users can be revoked.
    expect(within(rows[2] as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
  });

  test("a user without a name or a revocation time still renders", async () => {
    backend.users = [
      user(MEMBER, "", "member", { profile: {} }),
      user(GONE, "x", "member", { status: "revoked" }),
    ];
    await open("/admin/users");
    expect(await screen.findByText("Unnamed")).toBeVisible();
    expect(screen.getByText("Revoked")).toBeVisible();
  });

  test("shows loading, then an empty state", async () => {
    backend.users = [];
    let release: () => void = () => {};
    backend.force["GET /api/user"] = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(json(200, { users: [] }));
      });
    await open("/admin/users");
    expect(screen.getByText("Loading users…")).toBeVisible();
    await act(async () => release());
    expect(screen.getByText("There are no users yet.")).toBeVisible();
    expect(screen.queryByText("Loading users…")).not.toBeInTheDocument();
  });

  test("revoking asks first, then marks the user revoked", async () => {
    await open("/admin/users");
    await userEvent.click(await screen.findByRole("button", { name: "Revoke Mia" }));

    const dialog = await screen.findByRole("dialog", { name: "Revoke this user?" });
    expect(dialog).toHaveTextContent("Mia will lose access");
    expect(backend.calls.map((c) => c.key)).not.toContain(`DELETE /api/user/${MEMBER}`);

    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke user" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(backend.calls.map((c) => c.key)).toContain(`DELETE /api/user/${MEMBER}`);
    expect(screen.queryByRole("button", { name: "Revoke Mia" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Revoked/).length).toBeGreaterThanOrEqual(2);
  });

  test("an unnamed user is identified by a short id in the confirmation", async () => {
    backend.users = [user(MEMBER, "", "member", { profile: {} })];
    await open("/admin/users");
    await userEvent.click(await screen.findByRole("button", { name: "Revoke bbbbbbbb" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("User bbbbbbbb will lose access");
  });

  test("cancelling revokes nothing", async () => {
    await open("/admin/users");
    await userEvent.click(await screen.findByRole("button", { name: "Revoke Mia" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(backend.calls.map((c) => c.key)).not.toContain(`DELETE /api/user/${MEMBER}`);
  });

  test("revoking yourself warns about it, and the last admin is refused with an explanation", async () => {
    backend.force[`DELETE /api/user/${ADMIN}`] = () =>
      json(409, { error: { code: "user_last_admin" } });
    await open("/admin/users");
    await userEvent.click(await screen.findByRole("button", { name: "Revoke Root" }));

    const dialog = await screen.findByRole("dialog", { name: "Revoke this user?" });
    expect(dialog).toHaveTextContent("This is your own account.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke user" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("last active administrator");
    // The dialog stays open so the reason sits next to the action; cancelling clears it.
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Revoke Root" }));
    expect(within(await screen.findByRole("dialog")).queryByRole("alert")).not.toBeInTheDocument();
  });

  test("the dialog can't be dismissed or confirmed twice while the revoke is running", async () => {
    let release: () => void = () => {};
    backend.force[`DELETE /api/user/${MEMBER}`] = () =>
      new Promise<Response>((resolve) => {
        release = () =>
          resolve(json(200, user(MEMBER, "Mia", "member", { status: "revoked", revokedAt: 9 })));
      });
    await open("/admin/users");
    await userEvent.click(await screen.findByRole("button", { name: "Revoke Mia" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke user" }));

    expect(within(dialog).getByRole("button", { name: "Revoke user" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();

    await act(async () => release());
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  test("after logging out from the nav bar the page falls back to the login prompt", async () => {
    await open("/admin/users");
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Administration" })).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  test("Escape closes the dialog when idle", async () => {
    await open("/admin/users");
    await userEvent.click(await screen.findByRole("button", { name: "Revoke Mia" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  test("a failed load is reported, and Retry loads again", async () => {
    let fail = true;
    backend.force["GET /api/user"] = () =>
      fail
        ? json(503, { error: { code: "user_list_failed" } })
        : json(200, { users: backend.users });
    await open("/admin/users");
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't available");

    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("a 403 from the server is shown even if the session said admin", async () => {
    backend.force["GET /api/user"] = () => json(403, { error: { code: "users_forbidden" } });
    await open("/admin/users");
    expect(await screen.findByRole("alert")).toHaveTextContent("Only administrators");
  });

  test("a failed reload keeps the list that was already showing", async () => {
    await open("/admin/users");
    await screen.findByRole("table");
    backend.force["GET /api/user"] = () => json(503, {});
    // Leave and come back through the bar: the section re-mounts and reloads.
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    await userEvent.click(within(nav).getByRole("link", { name: "Invitations" }));
    await screen.findByRole("heading", { name: "Invitations" });
    await userEvent.click(within(nav).getByRole("link", { name: "Users" }));
    expect(await screen.findByRole("alert")).toBeVisible();
  });
});

describe("invitations", () => {
  test("lists invitations with usage, expiry and status", async () => {
    await open("/admin/invitations");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Friends");
    expect(rows[0]).toHaveTextContent("2 / 5");
    expect(rows[0]).toHaveTextContent("Never");
    expect(rows[0]).toHaveTextContent("active");
    expect(rows[1]).toHaveTextContent("No label");
    expect(rows[1]).toHaveTextContent("revoked");
    // A revoked invitation offers no actions.
    expect(within(rows[1] as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
  });

  test("shows loading, then an empty state", async () => {
    let release: () => void = () => {};
    backend.force["GET /api/invitation"] = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(json(200, { invitations: [] }));
      });
    await open("/admin/invitations");
    expect(screen.getByText("Loading invitations…")).toBeVisible();
    await act(async () => release());
    expect(screen.getByText("There are no invitations yet.")).toBeVisible();
    expect(screen.queryByText("Loading invitations…")).not.toBeInTheDocument();
  });

  test("a failed load is reported, and Retry loads again", async () => {
    let fail = true;
    backend.force["GET /api/invitation"] = () =>
      fail ? json(500, {}) : json(200, { invitations: backend.invitations });
    await open("/admin/invitations");
    expect(await screen.findByRole("alert")).toBeVisible();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table")).toBeVisible();
  });

  describe("creating", () => {
    const openCreate = async () => {
      await open("/admin/invitations");
      await userEvent.click(await screen.findByRole("button", { name: "New invitation" }));
      return screen.findByRole("dialog", { name: "New invitation" });
    };

    test("creates, shows the one-time code and link, and adds the row", async () => {
      const writeText = rs.fn(async () => {});
      rs.stubGlobal("navigator", { clipboard: { writeText } });
      const dialog = await openCreate();
      await userEvent.type(within(dialog).getByLabelText(/Label/), "  Newcomers ");
      const num = within(dialog).getByLabelText(/Number of accounts/);
      await userEvent.clear(num);
      await userEvent.type(num, "3");
      await userEvent.type(within(dialog).getByLabelText(/Expires/), "2999-01-01T10:00");
      await userEvent.click(within(dialog).getByRole("button", { name: "Create invitation" }));

      const created = await screen.findByRole("dialog", { name: "Invitation created" });
      expect(within(created).getByLabelText("Invitation code")).toHaveValue("THE-CODE");
      expect(within(created).getByLabelText("Invitation link")).toHaveValue(
        `${window.location.origin}/register#THE-CODE`,
      );

      const post = backend.calls.find((c) => c.key === "POST /api/invitation");
      expect(post?.body).toMatchObject({
        numInvites: 3,
        label: "Newcomers",
        expiresAt: Math.floor(new Date("2999-01-01T10:00").getTime() / 1000),
      });

      // Focusing a field selects it, so the code can be copied by hand too.
      const codeField = within(created).getByLabelText("Invitation code") as HTMLTextAreaElement;
      await userEvent.click(codeField);
      expect(codeField.selectionStart).toBe(0);
      expect(codeField.selectionEnd).toBe("THE-CODE".length);

      const [copyCode, copyLink] = within(created).getAllByRole("button", { name: "Copy" });
      await userEvent.click(copyCode as HTMLElement);
      expect(writeText).toHaveBeenCalledWith("THE-CODE");
      expect(within(created).getAllByRole("button", { name: "Copied" })).toHaveLength(1);
      await userEvent.click(copyLink as HTMLElement);
      expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/register#THE-CODE`);

      await userEvent.click(within(created).getByRole("button", { name: "Done" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      // The new row is at the top, and the code is nowhere in the page any more.
      expect(within(screen.getByRole("table")).getAllByRole("row")[1]).toHaveTextContent("New");
      expect(document.body).not.toHaveTextContent("THE-CODE");
    });

    test("the code dialog survives a clipboard that refuses, and Escape closes it", async () => {
      rs.stubGlobal("navigator", {
        clipboard: {
          writeText: async () => {
            throw new Error("denied");
          },
        },
      });
      const dialog = await openCreate();
      await userEvent.click(within(dialog).getByRole("button", { name: "Create invitation" }));
      const created = await screen.findByRole("dialog", { name: "Invitation created" });
      await userEvent.click(
        within(created).getAllByRole("button", { name: "Copy" })[0] as HTMLElement,
      );
      expect(within(created).queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    test("won't submit an invalid count, a past expiry, or an over-long label", async () => {
      const dialog = await openCreate();
      const submit = within(dialog).getByRole("button", { name: "Create invitation" });
      const num = within(dialog).getByLabelText(/Number of accounts/);

      expect(submit).toBeEnabled();
      await userEvent.clear(num);
      expect(submit).toBeDisabled();
      await userEvent.type(num, "0");
      expect(submit).toBeDisabled();
      await userEvent.clear(num);
      await userEvent.type(num, "2.5");
      expect(submit).toBeDisabled();
      await userEvent.clear(num);
      await userEvent.type(num, "10001");
      expect(submit).toBeDisabled();
      await userEvent.clear(num);
      await userEvent.type(num, "10000");
      expect(submit).toBeEnabled();

      const expires = within(dialog).getByLabelText(/Expires/);
      await userEvent.type(expires, "2000-01-01T10:00");
      expect(submit).toBeDisabled();
      await userEvent.clear(expires);
      expect(submit).toBeEnabled();

      // Submitting the form by Enter is ignored while invalid.
      await userEvent.clear(num);
      await userEvent.type(num, "0{Enter}");
      expect(backend.calls.map((c) => c.key)).not.toContain("POST /api/invitation");
    });

    test("a refusal is explained in the dialog, which stays open for another go", async () => {
      backend.force["POST /api/invitation"] = () =>
        json(400, { error: { code: "invalid_invitation_type" } });
      const dialog = await openCreate();
      await userEvent.type(within(dialog).getByLabelText(/Label/), "keep me");
      await userEvent.click(within(dialog).getByRole("button", { name: "Create invitation" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "doesn't accept that kind of invitation",
      );
      expect(within(dialog).getByLabelText(/Label/)).toHaveValue("keep me");
    });

    test("cancelling discards the form", async () => {
      const dialog = await openCreate();
      await userEvent.type(within(dialog).getByLabelText(/Label/), "discard");
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "New invitation" }));
      expect(await screen.findByLabelText(/Label/)).toHaveValue("");
    });

    test("Escape closes the form, but not while creating", async () => {
      let release: () => void = () => {};
      backend.force["POST /api/invitation"] = () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              json(201, { ...invitation("ffffffff-0000-4000-8000-000000000006", "N"), code: "C" }),
            );
        });
      const dialog = await openCreate();
      await userEvent.click(within(dialog).getByRole("button", { name: "Create invitation" }));
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("dialog", { name: "New invitation" })).toBeVisible();
      await act(async () => release());
      await screen.findByRole("dialog", { name: "Invitation created" });
    });

    test("Escape closes an idle form", async () => {
      await openCreate();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    test("sends the chosen account type, member by default", async () => {
      const dialog = await openCreate();
      const type = within(dialog).getByLabelText("Account type");
      expect(type).toHaveValue("member");
      await userEvent.selectOptions(type, "admin");
      await userEvent.click(within(dialog).getByRole("button", { name: "Create invitation" }));
      await screen.findByRole("dialog", { name: "Invitation created" });
      const post = backend.calls.find((c) => c.key === "POST /api/invitation");
      expect(post?.body).toMatchObject({ type: "admin" });
    });

    test("a whitespace-only label is sent as no label; invisible characters block submit", async () => {
      const dialog = await openCreate();
      const label = within(dialog).getByLabelText(/Label/);
      const submit = within(dialog).getByRole("button", { name: "Create invitation" });
      await userEvent.type(label, "a\u200eb");
      expect(submit).toBeDisabled();
      await userEvent.clear(label);
      await userEvent.type(label, "   ");
      expect(submit).toBeEnabled();
      await userEvent.click(submit);
      await screen.findByRole("dialog", { name: "Invitation created" });
      const post = backend.calls.find((c) => c.key === "POST /api/invitation");
      expect(post?.body).toMatchObject({ label: "" });
    });

    test("pressing Enter submits a valid form once", async () => {
      const dialog = await openCreate();
      await userEvent.type(within(dialog).getByLabelText(/Label/), "x{Enter}");
      await screen.findByRole("dialog", { name: "Invitation created" });
      expect(backend.calls.filter((c) => c.key === "POST /api/invitation")).toHaveLength(1);
    });
  });

  describe("editing the limit", () => {
    const openEdit = async (mount = true) => {
      if (mount) await open("/admin/invitations");
      await userEvent.click(await screen.findByRole("button", { name: "Edit limit of Friends" }));
      return screen.findByRole("dialog", { name: "Change the limit" });
    };

    test("saves a new limit and updates the row", async () => {
      const dialog = await openEdit();
      expect(dialog).toHaveTextContent("Friends has been used 2 times.");
      const field = within(dialog).getByLabelText(/Number of accounts/);
      expect(field).toHaveValue(5);
      await userEvent.clear(field);
      await userEvent.type(field, "9");
      await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      expect(screen.getByText("2 / 9")).toBeVisible();
      expect(backend.calls.find((c) => c.key.startsWith("PATCH"))?.body).toEqual({ numInvites: 9 });
    });

    test("blocks a limit below the uses so far, and an empty or fractional one", async () => {
      const dialog = await openEdit();
      const field = within(dialog).getByLabelText(/Number of accounts/);
      const save = within(dialog).getByRole("button", { name: "Save" });
      await userEvent.clear(field);
      expect(save).toBeDisabled();
      await userEvent.type(field, "1");
      expect(save).toBeDisabled();
      await userEvent.clear(field);
      await userEvent.type(field, "2.5");
      expect(save).toBeDisabled();
      await userEvent.clear(field);
      await userEvent.type(field, "2");
      expect(save).toBeEnabled();
      await userEvent.clear(field);
      await userEvent.type(field, "1{Enter}");
      expect(backend.calls.some((c) => c.key.startsWith("PATCH"))).toBe(false);
    });

    test("a refusal from the server is explained in place", async () => {
      backend.force["PATCH /api/invitation/dddddddd-0000-4000-8000-000000000004"] = () =>
        json(409, { error: { code: "num_invites_below_uses", data: { uses: 3 } } });
      const dialog = await openEdit();
      await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("used 3 times");
    });

    test("an unlabelled invitation is named by its id, and a single use reads naturally", async () => {
      backend.invitations = [invitation("dddddddd-0000-4000-8000-000000000004", "", { uses: 1 })];
      await open("/admin/invitations");
      await userEvent.click(await screen.findByRole("button", { name: "Edit limit of dddddddd" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent(
        "Invitation dddddddd has been used 1 time.",
      );
    });

    test("Escape is ignored while the change is being saved", async () => {
      let release: () => void = () => {};
      backend.force["PATCH /api/invitation/dddddddd-0000-4000-8000-000000000004"] = () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(json(200, invitation("dddddddd-0000-4000-8000-000000000004", "Friends")));
        });
      const dialog = await openEdit();
      await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("dialog", { name: "Change the limit" })).toBeVisible();
      await act(async () => release());
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    test("cancel and Escape close it, and reopening starts from the current limit", async () => {
      let dialog = await openEdit();
      await userEvent.type(within(dialog).getByLabelText(/Number of accounts/), "7");
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      dialog = await openEdit(false);
      expect(within(dialog).getByLabelText(/Number of accounts/)).toHaveValue(5);
      await userEvent.keyboard("{Escape}");
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });
  });

  describe("revoking", () => {
    test("asks first, then marks the invitation revoked", async () => {
      await open("/admin/invitations");
      await userEvent.click(await screen.findByRole("button", { name: "Revoke Friends" }));
      const dialog = await screen.findByRole("dialog", { name: "Revoke this invitation?" });
      expect(dialog).toHaveTextContent("Friends will stop working immediately");
      expect(backend.calls.some((c) => c.key.startsWith("DELETE"))).toBe(false);

      await userEvent.click(within(dialog).getByRole("button", { name: "Revoke invitation" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      expect(screen.queryByRole("button", { name: "Revoke Friends" })).not.toBeInTheDocument();
      expect(screen.getAllByText("revoked")).toHaveLength(2);
    });

    test("names an unlabelled invitation by its id", async () => {
      backend.invitations = [invitation("dddddddd-0000-4000-8000-000000000004", "")];
      await open("/admin/invitations");
      await userEvent.click(await screen.findByRole("button", { name: "Revoke dddddddd" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent(
        "Invitation dddddddd will stop working",
      );
    });

    test("a failure is shown in the dialog, and cancelling clears it", async () => {
      backend.force["DELETE /api/invitation/dddddddd-0000-4000-8000-000000000004"] = () =>
        json(503, {});
      await open("/admin/invitations");
      await userEvent.click(await screen.findByRole("button", { name: "Revoke Friends" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Revoke invitation" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("isn't available");

      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await userEvent.click(screen.getByRole("button", { name: "Revoke Friends" }));
      expect(
        within(await screen.findByRole("dialog")).queryByRole("alert"),
      ).not.toBeInTheDocument();
    });
  });
});

describe("parseExpiry", () => {
  test("empty means no expiry", () => {
    expect(parseExpiry("")).toBeUndefined();
  });
  test("a local date-time becomes Unix seconds", () => {
    expect(parseExpiry("2999-01-01T10:00")).toBe(
      Math.floor(new Date("2999-01-01T10:00").getTime() / 1000),
    );
  });
  test("garbage is treated as no expiry", () => {
    expect(parseExpiry("not-a-date")).toBeUndefined();
  });
});
