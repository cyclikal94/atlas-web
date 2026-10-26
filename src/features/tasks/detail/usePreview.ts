import { useCallback, useEffect, useRef, useState } from "react";
import { useTasksEnv } from "../env";
import { noteIfRefused } from "../memory";
import type { DependencyPreview } from "../model/contract";

/**
 * The dependency preview of the day shown (`GET /occurrences/{id}/dependencies`, online). One read per `(identity, occurrence)` shown,
 * read again on `refresh()` (the row's Refresh, the dialog opening, a conflict being reviewed) and when this device's own dependency or
 * completion drafts of the day are answered (`settled` changes). An answer is used only for the identity and occurrence it was asked
 * under, and only the latest asked is shown (CM-384): a late answer of an earlier identity, day or read is dropped.
 *
 * `seq` is the number of the read shown and `asked()` that of the latest read asked (an offline read is one too): a screen that needs an
 * answer asked no earlier than a moment of its own (the dependency dialog's opening read, review R12) compares them; a resolved
 * `refresh()` alone does not say its answer is the one shown.
 */
export type PreviewRead =
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "ready"; preview: DependencyPreview; requestId?: string }
  | { kind: "refused" }
  | { kind: "error"; requestId?: string };

export const PREVIEW_READ = (occurrenceId: string) =>
  `dependencies:${occurrenceId}`;

export function usePreview(
  occurrenceId: string,
  settled: string,
): {
  read: PreviewRead;
  seq: number;
  asked(): number;
  refresh(): Promise<PreviewRead>;
} {
  const env = useTasksEnv();
  const [state, setState] = useState<{
    scope: string;
    read: PreviewRead;
    seq: number;
  }>({
    scope: "",
    read: { kind: "loading" },
    seq: 0,
  });
  const scope = `${env.identity}\u0000${occurrenceId}`;
  const latest = useRef(0);
  const current = useRef(scope);
  current.current = scope;
  const ask = useCallback(async (): Promise<PreviewRead> => {
    latest.current += 1;
    const mine = latest.current;
    if (!env.online) {
      const read: PreviewRead = { kind: "offline" };
      setState({ scope, read, seq: mine });
      return read;
    }
    const asked = scope;
    const result = await env.api.readDependencies(occurrenceId);
    // A refusal is noted when it arrives (WEB-10a's consumer obligation), whatever the screen does with it.
    noteIfRefused(env.identity, PREVIEW_READ(occurrenceId), result);
    const read: PreviewRead = result.ok
      ? {
          kind: "ready",
          preview: result.value,
          ...(result.requestId ? { requestId: result.requestId } : {}),
        }
      : result.kind === "forbidden" || result.kind === "not_found"
        ? { kind: "refused" }
        : result.kind === "offline"
          ? { kind: "offline" }
          : {
              kind: "error",
              ...("requestId" in result && result.requestId
                ? { requestId: result.requestId }
                : {}),
            };
    if (latest.current === mine && current.current === asked)
      setState({ scope: asked, read, seq: mine });
    return read;
  }, [env, occurrenceId, scope]);
  const ran = useRef<string | null>(null);
  useEffect(() => {
    const key = `${scope}\u0000${env.online}\u0000${settled}`;
    if (ran.current === key) return;
    ran.current = key;
    void ask();
  }, [scope, env.online, settled, ask]);
  const asked = useCallback(() => latest.current, []);
  return {
    read: state.scope === scope ? state.read : { kind: "loading" },
    seq: state.scope === scope ? state.seq : 0,
    asked,
    refresh: ask,
  };
}
