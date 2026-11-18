import { afterEach, beforeEach, describe, expect, rs, test } from "@rstest/core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { createTestRouter } from "@/router";

const USER = "aaaaaaaa-0000-4000-8000-000000000001";

type Wire = Record<string, unknown>;

const agent = (id: string, name: string, extra: Wire = {}): Wire => ({
  id,
  name,
  scopes: "default:agent",
  status: "active",
  createdAt: 1_700_000_000,
  ...extra,
});

const A1 = "01900000-0000-7000-8000-000000000003";
const A2 = "01900000-0000-7000-8000-000000000002";
const A3 = "01900000-0000-7000-8000-000000000001";
const NEW = "01900000-0000-7000-8000-000000000009";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Backend = {
  session: () => Response;
  agents: Wire[];
  /** Overrides, keyed by "METHOD /path", to force a specific answer. */
  force: Record<string, () => Response | Promise<Response>>;
  calls: { key: string; body?: unknown }[];
};

let backend: Backend;

const memberSession = () => json(200, { userId: USER, role: "member", expiresAt: 1 });

beforeEach(() => {
  backend = {
    session: memberSession,
    agents: [
      agent(A1, "Planner"),
      agent(A2, "Old bot", { status: "revoked", revokedAt: 1_700_000_100 }),
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

    if (key === "GET /api/agent") return json(200, { agents: backend.agents });
    if (key === "POST /api/agent") {
      return json(201, {
        agent: agent(NEW, (body as { name: string }).name),
        key: { id: "kid", token: "SECRET-TOKEN", scope: "default:agent", expiresAt: 1_800_000_000 },
      });
    }
    if (method === "DELETE" && url.startsWith("/api/agent/")) {
      const id = url.slice("/api/agent/".length);
      const found = backend.agents.find((a) => a.id === id) as Wire;
      Object.assign(found, { status: "revoked", revokedAt: 1_700_000_300 });
      return json(200, found);
    }
    return new Response(null, { status: 204 });
  });
});

afterEach(() => {
  rs.unstubAllGlobals();
});

const open = async (path = "/agents") => {
  render(<App router={createTestRouter([path])} />);
  await act(async () => {});
};

describe("access", () => {
  test("a signed-out visitor is asked to log in and nothing is fetched", async () => {
    backend.session = () => json(401, { error: { code: "unauthenticated" } });
    await open();
    expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Login" }).length).toBeGreaterThan(0);
    expect(backend.calls.map((c) => c.key)).not.toContain("GET /api/agent");
    expect(screen.queryByRole("link", { name: "Agents" })).not.toBeInTheDocument();
  });

  test("the Login button on the notice starts a login", async () => {
    backend.session = () => json(401, {});
    rs.stubGlobal("PublicKeyCredential", { parseRequestOptionsFromJSON: (o: unknown) => o });
    const fetchBefore = globalThis.fetch;
    rs.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
      url === "/api/login/begin" ? json(200, { publicKey: {} }) : fetchBefore(url, init),
    );
    rs.stubGlobal("navigator", { credentials: { get: async () => null } });
    await open();
    const [notice] = screen.getAllByRole("button", { name: "Login" }).slice(-1);
    await userEvent.click(notice as HTMLElement);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeVisible();
    });
  });

  test("while the session check is pending it says so", () => {
    rs.stubGlobal("fetch", () => new Promise(() => {}));
    render(<App router={createTestRouter(["/agents"])} />);
    expect(screen.getByText("Checking your session…")).toBeVisible();
  });

  test("an unreachable server is reported", async () => {
    rs.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    await open();
    expect(screen.getByText(/Can't reach the server to check your session/)).toBeVisible();
  });

  test("a member (not just an admin) can use the page and sees the nav link", async () => {
    await open();
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/agents");
    expect(await screen.findByText("Planner")).toBeVisible();
  });

  test("the nav link goes to the page", async () => {
    await open("/");
    await userEvent.click(screen.getByRole("link", { name: "Agents" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeVisible();
    expect(await screen.findByText("Planner")).toBeVisible();
  });
});

describe("list", () => {
  test("shows active and deleted agents; only active ones can be deleted", async () => {
    await open();
    expect(await screen.findByText("Planner")).toBeVisible();
    expect(screen.getByText("Old bot")).toBeVisible();
    expect(screen.getByText("active")).toBeVisible();
    expect(screen.getByText("deleted")).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete Planner" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete Old bot" })).not.toBeInTheDocument();
  });

  test("says so when there are none", async () => {
    backend.agents = [];
    await open();
    expect(await screen.findByText("You have no agents yet.")).toBeVisible();
  });

  test("shows a loading line until the list answers", async () => {
    let release: () => void = () => {};
    backend.force["GET /api/agent"] = () =>
      new Promise((resolve) => {
        release = () => resolve(json(200, { agents: [] }));
      });
    await open();
    expect(screen.getByText("Loading agents…")).toBeVisible();
    await act(async () => release());
    expect(screen.queryByText("Loading agents…")).not.toBeInTheDocument();
  });

  test("an answer that arrives after leaving the page is ignored", async () => {
    let release: () => void = () => {};
    backend.force["GET /api/agent"] = () =>
      new Promise((resolve) => {
        release = () => resolve(json(200, { agents: [agent(A1, "Planner")] }));
      });
    const view = render(<App router={createTestRouter(["/agents"])} />);
    await act(async () => {});
    view.unmount();
    await act(async () => release());
    expect(screen.queryByText("Planner")).not.toBeInTheDocument();
  });

  test("a failed load is reported and Retry reloads", async () => {
    backend.force["GET /api/agent"] = () => json(503, { error: { code: "agent_list_failed" } });
    await open();
    expect(await screen.findByRole("alert")).toHaveTextContent(/server isn't available/);
    delete backend.force["GET /api/agent"];
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Planner")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("Load more appends the next page using the cursor", async () => {
    let page = 0;
    backend.force["GET /api/agent"] = () => {
      page += 1;
      return json(200, { agents: [agent(A1, "Planner")], next: A1 });
    };
    backend.force[`GET /api/agent?cursor=${A1}`] = () =>
      json(200, { agents: [agent(A3, "Third")] });
    await open();
    expect(await screen.findByText("Planner")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Third")).toBeVisible();
    expect(screen.getByText("Planner")).toBeVisible();
    expect(page).toBe(1);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});

describe("create", () => {
  test("creates an agent and shows its API key once, with a copy button", async () => {
    const writeText = rs.fn(async () => {});
    rs.stubGlobal("navigator", { clipboard: { writeText } });
    await open();
    await screen.findByText("Planner");

    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    const form = screen.getByRole("dialog");
    const create = within(form).getByRole("button", { name: "Create agent" });
    expect(create).toBeDisabled();
    await userEvent.type(within(form).getByLabelText("Name"), "  Mailer  ");
    await userEvent.click(create);

    const keyDialog = await screen.findByRole("dialog", { name: "Agent created" });
    expect(within(keyDialog).getByLabelText("API key")).toHaveValue("SECRET-TOKEN");
    expect(backend.calls.find((c) => c.key === "POST /api/agent")?.body).toEqual({
      name: "Mailer",
    });
    await userEvent.click(within(keyDialog).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("SECRET-TOKEN");
    expect(await within(keyDialog).findByRole("button", { name: "Copied" })).toBeVisible();

    await userEvent.click(within(keyDialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByText("SECRET-TOKEN")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The new agent is already in the list, on top.
    const rows = screen.getAllByRole("row");
    expect(within(rows[1] as HTMLElement).getByText("Mailer")).toBeVisible();
  });

  test("a failed copy doesn't claim success", async () => {
    rs.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    await open();
    await screen.findByText("Planner");
    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    await userEvent.type(screen.getByLabelText("Name"), "Mailer");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    const keyDialog = await screen.findByRole("dialog", { name: "Agent created" });
    await userEvent.click(within(keyDialog).getByRole("button", { name: "Copy" }));
    expect(within(keyDialog).getByRole("button", { name: "Copy" })).toBeVisible();
  });

  test("creating into an empty list works", async () => {
    backend.agents = [];
    await open();
    await screen.findByText("You have no agents yet.");
    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    await userEvent.type(screen.getByLabelText("Name"), "First");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await screen.findByRole("dialog", { name: "Agent created" });
    expect(screen.getByText("First")).toBeVisible();
  });

  test("Escape closes the key dialog", async () => {
    await open();
    await screen.findByText("Planner");
    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    await userEvent.type(screen.getByLabelText("Name"), "Mailer");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await screen.findByRole("dialog", { name: "Agent created" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("a refused create shows the reason and keeps the form", async () => {
    backend.force["POST /api/agent"] = () => json(409, { error: { code: "agent_limit_reached" } });
    await open();
    await screen.findByText("Planner");
    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    await userEvent.type(screen.getByLabelText("Name"), "Mailer");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at most 25 active agents/);
    expect(screen.getByLabelText("Name")).toHaveValue("Mailer");
    expect(screen.queryByRole("dialog", { name: "Agent created" })).not.toBeInTheDocument();
  });

  test("a blank name can't be submitted", async () => {
    await open();
    await screen.findByText("Planner");
    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    await userEvent.type(screen.getByLabelText("Name"), "   ");
    expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
  });

  test("New agent is disabled until the list has loaded", async () => {
    backend.force["GET /api/agent"] = () => new Promise(() => {});
    await open();
    expect(screen.getByRole("button", { name: "New agent" })).toBeDisabled();
  });

  test("Escape closes the form when nothing is in flight", async () => {
    await open();
    await screen.findByText("Planner");
    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("Cancel closes the form without creating", async () => {
    await open();
    await screen.findByText("Planner");
    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(backend.calls.map((c) => c.key)).not.toContain("POST /api/agent");
  });

  test("the form can't be dismissed while the create is in flight", async () => {
    let release: () => void = () => {};
    backend.force["POST /api/agent"] = () =>
      new Promise((resolve) => {
        release = () => resolve(json(409, { error: { code: "agent_limit_reached" } }));
      });
    await open();
    await screen.findByText("Planner");
    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    await userEvent.type(screen.getByLabelText("Name"), "Mailer");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();
    await act(async () => release());
    expect(await screen.findByRole("alert")).toBeVisible();
  });
});

describe("delete", () => {
  test("confirming revokes the agent and marks it deleted in place", async () => {
    await open();
    await screen.findByText("Planner");
    await userEvent.click(screen.getByRole("button", { name: "Delete Planner" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/Planner and its API key will stop working/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete agent" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(backend.calls.map((c) => c.key)).toContain(`DELETE /api/agent/${A1}`);
    expect(screen.queryByRole("button", { name: "Delete Planner" })).not.toBeInTheDocument();
    expect(screen.getAllByText("deleted")).toHaveLength(2);
  });

  test("Cancel leaves the agent alone", async () => {
    await open();
    await screen.findByText("Planner");
    await userEvent.click(screen.getByRole("button", { name: "Delete Planner" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(backend.calls.map((c) => c.key)).not.toContain(`DELETE /api/agent/${A1}`);
  });

  test("a failed delete shows the reason", async () => {
    backend.force[`DELETE /api/agent/${A1}`] = () =>
      json(404, { error: { code: "agent_not_found" } });
    await open();
    await screen.findByText("Planner");
    await userEvent.click(screen.getByRole("button", { name: "Delete Planner" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer exists/);
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});
