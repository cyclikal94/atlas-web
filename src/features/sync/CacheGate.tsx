import { type ReactNode, useLayoutEffect } from "react";
import { Skeleton } from "../../components/ui/skeleton";
import { useCacheGate, useOptionalDataEnv } from "../../data";
import { GATE_BODY, GATE_TITLE } from "./copy";
import { registerGate } from "./gate-presence";
import { FloorRefusal } from "./NoticeBanners";

/**
 * Wraps a view that reads from the CACHE (plan 5.7, WEB-04 wireframe 12). While the cache is being brought up to date its content is
 * hidden behind "Refreshing your data"; when nothing will refresh it on this device the floor state replaces that message (the
 * copy never says "Refreshing…" or shows a spinner alone for it). The shell, navigation, drafts and the queue are NOT cache-sourced
 * and are never wrapped: they stay interactive throughout.
 *
 * With no data layer mounted it shows its content (there is nothing to gate it on).
 */
export function CacheGate({
  children,
  heading = null,
}: {
  children: ReactNode;
  /**
   * The page's heading while the content is hidden (WEB-10a revision 2): a destination whose own heading is part of the hidden content
   * passes it, so a gated page still has its one level-one heading. Not shown once the content is.
   */
  heading?: ReactNode;
}) {
  const env = useOptionalDataEnv();
  if (env === null) return children;
  return <Gate heading={heading}>{children}</Gate>;
}

function Gate({
  children,
  heading,
}: {
  children: ReactNode;
  heading: ReactNode;
}) {
  const gate = useCacheGate();
  // While this gate is on screen it owns the floor message (see gate-presence.ts): the shell does not draw it a second time.
  useLayoutEffect(() => registerGate(), []);
  if (gate === "open") return children;
  if (gate === "floor")
    return (
      <>
        {heading}
        <FloorRefusal variant="b" />
      </>
    );
  return (
    <>
      {heading}
      <section
        aria-labelledby="cache-gate-heading"
        aria-busy="true"
        data-cache-gate="refreshing"
        className="flex max-w-[620px] flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm"
      >
        <h2
          id="cache-gate-heading"
          className="flex items-center gap-2 text-sm font-semibold text-foreground"
        >
          <span
            aria-hidden="true"
            className="size-[7px] animate-pulse rounded-full bg-primary"
          />
          {GATE_TITLE}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {GATE_BODY}
        </p>
        <div aria-hidden="true" className="mt-1 flex flex-col gap-2">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
      </section>
    </>
  );
}
