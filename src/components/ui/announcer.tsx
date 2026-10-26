import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

/**
 * The single home of polite and assertive live regions (lint rule R6). Messages are written by changing
 * text content, so a repeated message is cleared first and re-set on the next frame to be read again.
 * clearAll removes any text at the level-0 gate (matrix section 3.7.2 step 1c).
 *
 * Each announcement is OWNED by its caller (Kieran's decision of 15 October 2026, WEB-10a revision 7): `retract`
 * withdraws it, cancelling its frame if it has not been written yet and clearing its text if it is still the region's
 * latest message. A later announcement owns the region from then on, so retracting an earlier one never erases it.
 * A notice that is dismissed retracts what it announced (`SessionNotices`).
 */
export type Politeness = "polite" | "assertive";
export interface Announcement {
  retract(): void;
}
export interface Announcer {
  announce(message: string, politeness?: Politeness): Announcement;
  clearAll(): void;
}
const NOTHING: Announcement = { retract: () => undefined };

const AnnouncerContext = createContext<Announcer | null>(null);

/**
 * The page has one protected tree and so one announcer. The session's protected-surface adapter, which is not a React
 * component, reaches it through this bridge: it clears the live regions when the level-0 gate closes, and it announces
 * that the window now shows a different account (matrix 3.7.2). Both are no-ops when no tree is mounted.
 */
let active: Announcer | null = null;
export const liveRegions: Announcer = {
  announce: (message, politeness) =>
    active?.announce(message, politeness) ?? NOTHING,
  clearAll: () => active?.clearAll(),
};

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const polite = useRef<HTMLDivElement>(null);
  const assertive = useRef<HTMLDivElement>(null);
  const frames = useRef(new Map<HTMLElement, number>());
  /** The announcement each region's text (or pending frame) belongs to: only that one may retract it. */
  const owners = useRef(new Map<HTMLElement, Announcement>());

  const cancel = useCallback((region: HTMLElement) => {
    const frame = frames.current.get(region);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frames.current.delete(region);
  }, []);

  const announce = useCallback(
    (message: string, politeness: Politeness = "polite") => {
      const region = (politeness === "assertive" ? assertive : polite).current;
      if (!region) return NOTHING;
      cancel(region);
      region.textContent = "";
      const frame = window.requestAnimationFrame(() => {
        frames.current.delete(region);
        region.textContent = message;
      });
      frames.current.set(region, frame);
      const announcement: Announcement = {
        retract: () => {
          if (owners.current.get(region) !== announcement) return;
          owners.current.delete(region);
          cancel(region);
          region.textContent = "";
        },
      };
      owners.current.set(region, announcement);
      return announcement;
    },
    [cancel],
  );

  const clearAll = useCallback(() => {
    for (const region of [polite.current, assertive.current]) {
      if (!region) continue;
      cancel(region);
      owners.current.delete(region);
      region.textContent = "";
    }
  }, [cancel]);

  const value = useMemo<Announcer>(
    () => ({ announce, clearAll }),
    [announce, clearAll],
  );

  useEffect(() => {
    const pending = frames.current;
    active = value;
    return () => {
      if (active === value) active = null;
      for (const frame of pending.values()) window.cancelAnimationFrame(frame);
      pending.clear();
    };
  }, [value]);
  return (
    <AnnouncerContext.Provider value={value}>
      {children}
      <div
        ref={polite}
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
      <div
        ref={assertive}
        className="sr-only"
        role="alert"
        aria-live="assertive"
      />
    </AnnouncerContext.Provider>
  );
}

export function useAnnouncer(): Announcer {
  const value = useContext(AnnouncerContext);
  if (!value)
    throw new Error("useAnnouncer must be used inside AnnouncerProvider");
  return value;
}
