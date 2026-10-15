import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { noteNavigation } from "../../lib/pwa/navigation";

/**
 * Raises the page's navigation signal (`lib/pwa/navigation.ts`, revision 17, R24) when the router has RENDERED a destination with a
 * different href from the one before: a link, a programmatic navigation or a history step, dialog routes and search changes included.
 * Never the first load (no previous location), a reload of the same location, or a navigation another one replaced before it rendered.
 * RouteFocus's rules are for focus and are not these.
 */
export function NavigationSignal() {
  const router = useRouter();
  useEffect(
    () =>
      router.subscribe("onRendered", (event) => {
        if (event.fromLocation && event.hrefChanged) noteNavigation();
      }),
    [router],
  );
  return null;
}
