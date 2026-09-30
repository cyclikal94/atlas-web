import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * After an in-app navigation (never the initial load) focus moves to the page heading, else to <main>, so keyboard
 * and screen-reader users land where the new content starts and never on <body>. A dialog route manages its own
 * focus, so navigations into or out of one are left alone.
 */
export function RouteFocus() {
  const router = useRouter();
  useEffect(() => {
    return router.subscribe("onResolved", (event) => {
      if (!event.fromLocation || !event.pathChanged) return;
      const isDialogRoute = (location: { pathname: string; search: unknown }) =>
        router
          .matchRoutes(location.pathname, location.search as never)
          .some((match) => match.staticData?.dialog);
      if (isDialogRoute(event.toLocation) || isDialogRoute(event.fromLocation))
        return;
      window.requestAnimationFrame(() => {
        const main = document.getElementById("main");
        const heading = main?.querySelector<HTMLElement>("[data-page-heading]");
        (heading ?? main)?.focus();
      });
    });
  }, [router]);
  return null;
}
