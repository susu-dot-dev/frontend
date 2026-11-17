import { createBrowserRouter, createMemoryRouter, type RouteObject } from "react-router";
import { FirstRun } from "@/routes/admin/FirstRun";
import { Home } from "@/routes/Home";
import { Layout } from "@/routes/Layout";
import { NotFound } from "@/routes/NotFound";

export const routes: RouteObject[] = [
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: Home },
      { path: "admin/first-run", Component: FirstRun },
      { path: "*", Component: NotFound },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);

/** For tests: the same route table with no browser history. */
export const createTestRouter = (initialEntries: string[] = ["/"]) =>
  createMemoryRouter(routes, { initialEntries });
