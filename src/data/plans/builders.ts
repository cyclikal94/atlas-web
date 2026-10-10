import {
  checkGuards,
  type DropReason,
  type GuardInput,
  type GuardName,
  incarnationMismatch,
  publishEpoch,
} from "../model/guards";
import type { StoreName } from "../model/schema";
import type { SyncStateRow } from "../model/types";
import {
  type Decision,
  type Plan,
  PlanRejected,
  type Reader,
  type Write,
  type WriteSink,
  w,
} from "../store/port";
import { type PlanMeta, registerPlan, registerReadPlan } from "./registry";

/**
 * Builders for the plans that read the `sync_state` singleton and may write it (plan 5.2.2). A GUARDED plan applies the guard set
 * in its `decide`, from the singleton it read in the SAME transaction, and on a pass publishes the epoch mirror (monotone `max`)
 * in that same transaction. A drop returns `{ kind: "dropped", reason }` and writes NOTHING.
 */
export type Guarded<O> =
  | { kind: "applied"; value: O }
  | { kind: "dropped"; reason: DropReason };

export interface GuardedReads<R> {
  sync: SyncStateRow | undefined;
  reads: R | undefined;
}

export interface GuardedSpec<I extends { captured: GuardInput }, R, O> {
  name: string;
  meta: PlanMeta;
  /** Stores read or written besides `sync_state` (which is always in scope). */
  scope: readonly StoreName[];
  durability: "strict" | "default";
  /** Plan-specific reads, after the singleton. Runs only when the singleton exists. */
  read(reader: Reader, input: I, sync: SyncStateRow): Promise<R>;
  /** PURE. Returns the plan's own writes, a replacement singleton (merged with the epoch publication), and the result. */
  decide(context: { sync: SyncStateRow; reads: R; input: I }): {
    writes?: readonly Write[];
    sync?: SyncStateRow;
    result: O;
  };
  /**
   * Streaming writes (bounded processing, plan 5.4.4): runs in the SAME transaction, after `decide`'s writes, and ONLY when the
   * guards passed. It may refine the result. Throwing `PlanRejected` aborts the transaction, so every write of `decide` and of
   * earlier chunks rolls back with it.
   */
  apply?(
    sink: WriteSink,
    context: {
      sync: SyncStateRow;
      reads: R;
      input: I;
      result: O;
      /** The transaction's reader: for lookups made while streaming (it sees the transaction's own writes). */
      reader: Reader;
    },
  ): Promise<O>;
}

export function guardedPlan<I extends { captured: GuardInput }, R, O>(
  spec: GuardedSpec<I, R, O>,
): Plan<I, GuardedReads<R>, Guarded<O>> {
  const scope: StoreName[] = [
    ...new Set<StoreName>([...spec.scope, "sync_state"]),
  ];
  const plan: Plan<I, GuardedReads<R>, Guarded<O>> = {
    name: spec.name,
    scope,
    mode: "readwrite",
    durability: spec.durability,
    async read(reader, input) {
      const sync = await reader.get("sync_state", "singleton");
      if (sync === undefined) return { sync, reads: undefined };
      return { sync, reads: await spec.read(reader, input, sync) };
    },
    decide({ sync, reads }, input): Decision<Guarded<O>> {
      const drop = checkGuards(sync, input.captured, spec.meta.guards);
      if (drop !== null || sync === undefined || reads === undefined)
        return {
          writes: [],
          result: { kind: "dropped", reason: drop ?? "incarnation" },
        };
      const out = spec.decide({ sync, reads, input });
      const writes: Write[] = [...(out.writes ?? [])];
      let next = out.sync ?? sync;
      if (spec.meta.guards.includes("EPO")) {
        const stamp = publishEpoch(next, input.captured.epoch);
        if (stamp !== null) next = { ...next, stamp };
      }
      if (next !== sync) writes.push(w.put("sync_state", next));
      return { writes, result: { kind: "applied", value: out.result } };
    },
    ...(spec.apply
      ? {
          async apply(
            sink,
            decision,
            reads,
            input,
            reader,
          ): Promise<Guarded<O>> {
            if (decision.result.kind === "dropped" || reads.sync === undefined)
              return decision.result;
            const value = await (spec.apply as NonNullable<typeof spec.apply>)(
              sink,
              {
                sync: reads.sync,
                reads: reads.reads as R,
                input,
                result: decision.result.value,
                reader,
              },
            );
            return { kind: "applied", value };
          },
        }
      : {}),
  };
  return registerPlan(
    plan as unknown as Plan<never, never, unknown>,
    spec.meta,
  ) as unknown as Plan<I, GuardedReads<R>, Guarded<O>>;
}

/**
 * A plan with no guard beyond the incarnation of the handle it holds, over the singleton and any other stores. The decision is
 * pure: `update` returns the replacement singleton (or `null` for no change), the other writes and the result.
 */
export interface SingletonSpec<I extends { incarnationId: string }, R, O> {
  name: string;
  meta: PlanMeta;
  scope: readonly StoreName[];
  mode?: "readonly" | "readwrite";
  durability: "strict" | "default";
  read(reader: Reader, input: I, sync: SyncStateRow | undefined): Promise<R>;
  decide(context: { sync: SyncStateRow | undefined; reads: R; input: I }): {
    writes?: readonly Write[];
    sync?: SyncStateRow | null;
    result: O;
  };
  /**
   * Streaming writes in the SAME transaction, after `decide`'s (R21): a population that is rewritten as a whole (every retrying
   * draft) is walked a window at a time and written through the sink, so what is in hand never grows with it. The incarnation guard
   * of `decide` has already passed. Throwing `PlanRejected` aborts the transaction, so every earlier write rolls back.
   */
  apply?(
    sink: WriteSink,
    context: {
      sync: SyncStateRow | undefined;
      reads: R;
      input: I;
      result: O;
      reader: Reader;
    },
  ): Promise<O>;
}

export function singletonPlan<I extends { incarnationId: string }, R, O>(
  spec: SingletonSpec<I, R, O>,
): Plan<I, { sync: SyncStateRow | undefined; reads: R }, O> {
  const scope: StoreName[] = [
    ...new Set<StoreName>([...spec.scope, "sync_state"]),
  ];
  const mode = spec.mode ?? "readwrite";
  const plan: Plan<I, { sync: SyncStateRow | undefined; reads: R }, O> = {
    name: spec.name,
    scope,
    mode,
    durability: spec.durability,
    async read(reader, input) {
      const sync = await reader.get("sync_state", "singleton");
      return { sync, reads: await spec.read(reader, input, sync) };
    },
    decide({ sync, reads }, input) {
      // INC is enforced here, from the singleton read in this transaction: a handle opened on an earlier incarnation of the
      // database (it was deleted and re-created since) is refused, and the transaction aborts with nothing written.
      if (
        spec.meta.guards.includes("INC") &&
        sync !== undefined &&
        incarnationMismatch(sync, input.incarnationId)
      )
        throw new PlanRejected("guard", "incarnation");
      const out = spec.decide({ sync, reads, input });
      const writes: Write[] = [...(out.writes ?? [])];
      if (out.sync) writes.push(w.put("sync_state", out.sync));
      return { writes: mode === "readonly" ? [] : writes, result: out.result };
    },
    ...(spec.apply
      ? {
          async apply(sink, decision, reads, input, reader): Promise<O> {
            return (spec.apply as NonNullable<typeof spec.apply>)(sink, {
              sync: reads.sync,
              reads: reads.reads,
              input,
              result: decision.result,
              reader,
            });
          },
        }
      : {}),
  };
  return registerPlan(
    plan as unknown as Plan<never, never, unknown>,
    spec.meta,
  ) as unknown as Plan<I, { sync: SyncStateRow | undefined; reads: R }, O>;
}

/**
 * A plan that only reads, over the singleton and any other stores. It writes nothing by construction (it has no `writes` to
 * return), so it needs no writer number; it is registered separately so a test can assert it stays read-only.
 */
export interface ReadSpec<I extends { incarnationId: string }, R, O> {
  name: string;
  scope: readonly StoreName[];
  read(reader: Reader, input: I, sync: SyncStateRow | undefined): Promise<R>;
  decide(context: { sync: SyncStateRow | undefined; reads: R; input: I }): O;
}

export function readPlan<I extends { incarnationId: string }, R, O>(
  spec: ReadSpec<I, R, O>,
): Plan<I, { sync: SyncStateRow | undefined; reads: R }, O> {
  const scope: StoreName[] = [
    ...new Set<StoreName>([...spec.scope, "sync_state"]),
  ];
  const plan: Plan<I, { sync: SyncStateRow | undefined; reads: R }, O> = {
    name: spec.name,
    scope,
    mode: "readonly",
    durability: "default",
    async read(reader, input) {
      const sync = await reader.get("sync_state", "singleton");
      return { sync, reads: await spec.read(reader, input, sync) };
    },
    decide({ sync, reads }, input) {
      if (sync !== undefined && incarnationMismatch(sync, input.incarnationId))
        throw new PlanRejected("guard", "incarnation");
      return { writes: [], result: spec.decide({ sync, reads, input }) };
    },
  };
  return registerReadPlan(
    plan as unknown as Plan<never, never, unknown>,
  ) as unknown as Plan<I, { sync: SyncStateRow | undefined; reads: R }, O>;
}

export type { GuardName };
