import { useEffect, useRef } from "react";
import type { CalendarApi, Live } from "./api";

/** A form's view of its own lifetime, read when asked (so it is the CURRENT answer, never the one at the press). */
export interface FormLifetime {
  /** The admission check of the form's direct requests (`CalendarApi`'s `live`): mounted, under the same client, and online. */
  live: Live;
  /** Whether the page is online now (a request the client did not admit while offline says "Needs a connection"). */
  online(): boolean;
}

export function useLive(api: CalendarApi, online: boolean): FormLifetime {
  const mounted = useRef(false);
  const latest = useRef({ api, online });
  latest.current = { api, online };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useRef<FormLifetime>({
    live: () =>
      mounted.current && latest.current.api === api && latest.current.online,
    online: () => latest.current.online,
  }).current;
}
