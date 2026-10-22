import { useEffect, useRef } from "react";
import type { CalendarApi, Live } from "./api";

/** A form's view of its own lifetime, read when asked (so it is the CURRENT answer, never the one at the press). */
export interface FormLifetime {
  /**
   * The admission check of the form's direct requests (`CalendarApi`'s `live`): mounted, under the same client, online, and still
   * permitted by the form's own current rule (`admit`, revision 2: a source that gained waiting changes, became view-only or left the
   * screen while a request waited to be sent is not sent to).
   */
  live: Live;
  /** Whether the page is online now (a request the client did not admit while offline says "Needs a connection"). */
  online(): boolean;
  /**
   * Whether the form is still on screen. A request already sent may finish after the form has gone: its answer is then recorded where
   * it must be (a connection change's version), but it closes and changes nothing on screen, which may by then show another form.
   */
  mounted(): boolean;
}

export function useLive(
  api: CalendarApi,
  online: boolean,
  admit: () => boolean = () => true,
): FormLifetime {
  const mounted = useRef(false);
  const latest = useRef({ api, online, admit });
  latest.current = { api, online, admit };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useRef<FormLifetime>({
    live: () =>
      mounted.current &&
      latest.current.api === api &&
      latest.current.online &&
      latest.current.admit(),
    online: () => latest.current.online,
    mounted: () => mounted.current,
  }).current;
}
