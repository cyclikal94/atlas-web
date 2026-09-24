import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
export function Welcome() {
  return (
    <main>
      <h1>Atlas</h1>
      <p>Welcome to Atlas.</p>
    </main>
  );
}
const rootRoute = createRootRoute({ component: Outlet });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Welcome,
});
export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  defaultNotFoundComponent: Welcome,
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
