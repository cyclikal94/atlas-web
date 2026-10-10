import { type ReactNode, useLayoutEffect } from "react";
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
export function CacheGate({ children }: { children: ReactNode }) {
  const env = useOptionalDataEnv();
  if (env === null) return children;
  return <Gate>{children}</Gate>;
}

function Gate({ children }: { children: ReactNode }) {
  const gate = useCacheGate();
  // While this gate is on screen it owns the floor message (see gate-presence.ts): the shell does not draw it a second time.
  useLayoutEffect(() => registerGate(), []);
  if (gate === "open") return children;
  if (gate === "floor") return <FloorRefusal variant="b" />;
  return (
    <section
      aria-labelledby="cache-gate-heading"
      aria-busy="true"
      data-cache-gate="refreshing"
      className="flex max-w-[620px] flex-col gap-2 rounded-row border border-hairline-strong bg-panel p-3.5"
    >
      <h2
        id="cache-gate-heading"
        className="text-[14px] font-medium text-ink-1"
      >
        {GATE_TITLE}
      </h2>
      <p className="text-[13px] leading-[1.6] text-ink-2">{GATE_BODY}</p>
    </section>
  );
}
