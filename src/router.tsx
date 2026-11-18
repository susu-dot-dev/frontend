import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from "react-router";
import { Agents } from "@/routes/Agents";
import { AdminLayout } from "@/routes/admin/AdminLayout";
import { FirstRun } from "@/routes/admin/FirstRun";
import { Invitations } from "@/routes/admin/Invitations";
import { Users } from "@/routes/admin/Users";
import { Home } from "@/routes/Home";
import { Layout } from "@/routes/Layout";
import { NotFound } from "@/routes/NotFound";
import { Register } from "@/routes/Register";

export const routes: RouteObject[] = [
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: Home },
      { path: "admin/first-run", Component: FirstRun },
      {
        path: "admin",
        Component: AdminLayout,
        children: [
          { index: true, element: <Navigate to="/admin/users" replace /> },
          { path: "users", Component: Users },
          { path: "invitations", Component: Invitations },
        ],
      },
      { path: "agents", Component: Agents },
      { path: "register", Component: Register },
      { path: "*", Component: NotFound },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);

/** For tests: the same route table with no browser history. */
export const createTestRouter = (initialEntries: string[] = ["/"]) =>
  createMemoryRouter(routes, { initialEntries });
