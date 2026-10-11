import { useEffect, useState } from "react";

/** Whether the browser believes it is online. A hint only: the requests themselves are the evidence. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/**
 * The browser's belief at the moment of use. The hook's state can lag the browser by a render (the `offline` event is handled
 * after the click that preceded it was queued), so a handler that must not send while offline asks this as well. A hint, like the
 * hook: a request that does start is judged by its answer.
 */
export const isOnlineNow = (): boolean => navigator.onLine;
