import { useCallback, useEffect, useRef, useState } from "react";
import { useTasksEnv } from "../env";
import { noteIfRefused } from "../memory";
import type { DependencyPreview } from "../model/contract";

/**
 * The dependency preview of the day shown (`GET /occurrences/{id}/dependencies`, online). One read per `(identity, occurrence)` shown,
 * read again on `refresh()` (the row's Refresh, the dialog opening, a conflict being reviewed) and when this device's own dependency or
 * completion drafts of the day are answered (`settled` changes). An answer is used only for the identity and occurrence it was asked
 * under, and only the latest asked is shown (CM-384): a late answer of an earlier identity, day or read is dropped.
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
): { read: PreviewRead; refresh(): Promise<PreviewRead> } {
  const env = useTasksEnv();
  const [state, setState] = useState<{ scope: string; read: PreviewRead }>({
    scope: "",
    read: { kind: "loading" },
  });
  const scope = `${env.identity}\u0000${occurrenceId}`;
  const latest = useRef(0);
  const current = useRef(scope);
  current.current = scope;
  const ask = useCallback(async (): Promise<PreviewRead> => {
    if (!env.online) {
      const read: PreviewRead = { kind: "offline" };
      setState({ scope, read });
      return read;
    }
    latest.current += 1;
    const mine = latest.current;
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
      setState({ scope: asked, read });
    return read;
  }, [env, occurrenceId, scope]);
  const ran = useRef<string | null>(null);
  useEffect(() => {
    const key = `${scope}\u0000${env.online}\u0000${settled}`;
    if (ran.current === key) return;
    ran.current = key;
    void ask();
  }, [scope, env.online, settled, ask]);
  return {
    read: state.scope === scope ? state.read : { kind: "loading" },
    refresh: ask,
  };
}
