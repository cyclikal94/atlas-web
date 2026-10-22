import type { ConditionalFormPort, FormRecoveryRow } from "../../../src/data";
import { digestOf } from "../../../src/data/model/canonical";

/**
 * A double of the CONDITIONAL form port (`createConditionalFormPort`) for the held-change runner's tests: the same compare-and-set
 * semantics over an in-memory map (the real digest), with each write recorded and hooks to force schedules (another page ending or
 * changing the hold between steps, a write the store refuses or fails). The real port is tested over the IndexedDB double in
 * `tests/data/conditional-form.test.ts`.
 */
export interface HeldPortDouble {
  port: ConditionalFormPort;
  rows: Map<string, FormRecoveryRow>;
  /** Every committed put, in order (the decoded `held` text of each). */
  writes: Array<Record<string, unknown>>;
  /** The next puts answer this instead of writing. */
  failPuts: Array<"failed" | "refused">;
  /** The next ends answer this instead of ending. */
  failEnds: Array<"failed" | "refused">;
  /** Called before each put is judged (a place to let another page act first). */
  beforePut(hook: () => void): void;
  /** Another page ends the hold now (a terminal write from whatever is stored). */
  endElsewhere(context: string, tab: string): void;
  /** Another page writes another state of the hold now. */
  changeElsewhere(context: string, tab: string): void;
}

const keyOf = (context: string, tab: string) => `${context}\u0000${tab}`;

export function heldPortDouble(): HeldPortDouble {
  const rows = new Map<string, FormRecoveryRow>();
  const writes: Array<Record<string, unknown>> = [];
  const failPuts: Array<"failed" | "refused"> = [];
  const failEnds: Array<"failed" | "refused"> = [];
  let hook = () => {};
  const state = (row: FormRecoveryRow | undefined) =>
    row === undefined ? "absent" : row.terminal ? "ended" : "live";
  const port: ConditionalFormPort = {
    async put(snapshot, expect) {
      hook();
      const failure = failPuts.shift();
      if (failure !== undefined) return { kind: failure };
      const key = keyOf(snapshot.formContext, snapshot.tabInstanceId);
      const stored = rows.get(key);
      const now = state(stored);
      if (
        expect === null
          ? now !== "absent"
          : now !== "live" || stored?.content_digest !== expect
      )
        return { kind: "changed", stored: now };
      const fields = { ...snapshot.values };
      const digest = digestOf(fields);
      rows.set(key, {
        form_context: snapshot.formContext,
        tab_instance_id: snapshot.tabInstanceId,
        fields,
        redacted: [],
        saved_at: snapshot.savedAt,
        capture_seq: 0,
        writer_gen: Number.MAX_SAFE_INTEGER,
        terminal: false,
        content_digest: digest,
      });
      writes.push(JSON.parse(fields.held ?? "{}") as Record<string, unknown>);
      return { kind: "saved", digest };
    },
    async end(context, tab, expect) {
      const failure = failEnds.shift();
      if (failure !== undefined) return { kind: failure };
      const key = keyOf(context, tab);
      const stored = rows.get(key);
      const now = state(stored);
      if (now !== "live" || stored?.content_digest !== expect)
        return { kind: "changed", stored: now };
      rows.set(key, {
        ...(stored as FormRecoveryRow),
        fields: {},
        terminal: true,
        content_digest: digestOf({}),
      });
      return { kind: "ended" };
    },
    async read(context, tab) {
      const stored = rows.get(keyOf(context, tab));
      return stored === undefined
        ? { kind: "absent" }
        : stored.terminal
          ? { kind: "ended" }
          : { kind: "live", row: structuredClone(stored) };
    },
    async list() {
      return null;
    },
  };
  return {
    port,
    rows,
    writes,
    failPuts,
    failEnds,
    beforePut: (next) => {
      hook = next;
    },
    endElsewhere(context, tab) {
      const key = keyOf(context, tab);
      const stored = rows.get(key);
      if (stored !== undefined)
        rows.set(key, {
          ...stored,
          fields: {},
          terminal: true,
          content_digest: digestOf({}),
        });
    },
    changeElsewhere(context, tab) {
      const key = keyOf(context, tab);
      const stored = rows.get(key);
      if (stored !== undefined)
        rows.set(key, {
          ...stored,
          content_digest: `${stored.content_digest}:elsewhere`,
        });
    },
  };
}
