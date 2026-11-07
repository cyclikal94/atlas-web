import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * After an in-app navigation (never the initial load) focus moves to the page heading, else to <main>, so keyboard
 * and screen-reader users land where the new content starts and never on <body>. A dialog route manages its own
 * focus, so navigations into or out of one are left alone. This is a fallback (WEB-14a revision 19, R27): focus placed
 * after the navigation resolved (a field, an update prompt's action, the person) is kept, a newer navigation replaces
 * the pending one, and nothing is focused after the shell has gone.
 */
export function RouteFocus() {
  const router = useRouter();
  useEffect(() => {
    let frame = 0;
    let claimed = false;
    const claim = () => {
      claimed = true;
    };
    document.addEventListener("focusin", claim);
    const off = router.subscribe("onResolved", (event) => {
      cancelAnimationFrame(frame);
      if (!event.fromLocation || !event.pathChanged) return;
      const isDialogRoute = (location: { pathname: string; search: unknown }) =>
        router
          .matchRoutes(location.pathname, location.search as never)
          .some((match) => match.staticData?.dialog);
      if (isDialogRoute(event.toLocation) || isDialogRoute(event.fromLocation))
        return;
      claimed = false;
      frame = requestAnimationFrame(() => {
        if (claimed) return;
        const main = document.getElementById("main");
        const heading = main?.querySelector<HTMLElement>("[data-page-heading]");
        (heading ?? main)?.focus();
      });
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", claim);
    };
  }, [router]);
  return null;
}
