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
      // A hash names a place on the page (`/today#upcoming`): the page lands and focuses it itself, once it is there.
      if (event.toLocation.hash !== "") return;
      const isDialogRoute = (location: { pathname: string; search: unknown }) =>
        router
          .matchRoutes(location.pathname, location.search as never)
          .some((match) => match.staticData?.dialog);
      if (isDialogRoute(event.toLocation) || isDialogRoute(event.fromLocation))
        return;
      claimed = false;
      // The page's heading may be a lazy screen's (a person, a task): a few frames are allowed for it to appear before <main> stands in.
      let waited = 0;
      const land = () => {
        if (claimed) return;
        const main = document.getElementById("main");
        // A page that has already placed focus inside itself (Appearance on its selected choice) keeps it: nothing to land.
        const active = document.activeElement;
        if (
          active !== null &&
          active !== document.body &&
          active !== main &&
          main?.contains(active)
        )
          return;
        const heading = main?.querySelector<HTMLElement>("[data-page-heading]");
        if (heading === null || heading === undefined) {
          waited += 1;
          if (waited < 12) {
            frame = requestAnimationFrame(land);
            return;
          }
          // <main> stands in, and the heading takes over when a slower lazy screen draws it (within about two seconds), as long as
          // focus has not moved on from <main> meanwhile.
          if (document.activeElement !== main) {
            main?.focus();
            claimed = false;
          }
          if (waited < 120) frame = requestAnimationFrame(land);
          return;
        }
        heading.focus();
      };
      frame = requestAnimationFrame(land);
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", claim);
    };
  }, [router]);
  return null;
}
