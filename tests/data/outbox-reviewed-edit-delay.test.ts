// @vitest-environment node
import { describe, expect, test } from "vitest";
import { captureDefaults } from "../../src/data";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import type { EnqueueRequest, TargetSpec } from "../../src/data/model/outbox";
import { reviewedOf } from "../../src/data/model/review-confirmation";
import type { DraftRow } from "../../src/data/model/types";
import { createOutbox, type Outbox } from "../../src/data/outbox/outbox";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";
import { record, revision, snapshot } from "../support/data/sharing";

/**
 * WEB-11a review 3 (the design assessment's B1, its earlier Q1/Q2 schedules): an edit in place that was DELAYED before its transaction
 * (here held exactly where the quota admission waits, before the store transaction begins) while another caller changed the same queued
 * draft. The people editors send `expectDraft` (the body they read); it is judged inside the writing transaction, so the delayed edit
 * writes nothing and is refused `draft_changed`, and the other caller's newer state (its body, or a defaults confirmation and its cleared
 * review block) survives. Over the public outbox, the production plans and the IndexedDB double. FIXTURE evidence: a controlled delay,
 * not a real quota wait.
 */
const target = (id: string): TargetSpec => ({
  resourceId: id,
  role: "primary",
  basis: "resource",
  versionChecked: false,
  seedIfUntracked: 1,
});
const field = (text: string): EnqueueRequest => ({
  localId: "L",
  endpoint: "/task-commands",
  targets: [target("f")],
  build: () => ({ command: { command: { kind: "put_field", id: "f", text } } }),
});
const createWith = (
  name: string,
  capture: ReturnType<typeof captureDefaults>,
): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [target("p")],
  build: () => ({
    command: {
      commands: [{ kind: "create_person", id: "p", name }],
      ...(capture.defaultsRevision === null
        ? {}
        : { defaults_revision: capture.defaultsRevision }),
    },
    defaultsRevision: capture.defaultsRevision,
    defaultsContext: capture.defaultsContext,
    defaultsReview: capture.defaultsReview,
  }),
});

type World = Awaited<ReturnType<typeof outboxWorld>>;
const draftOf = (w: World, localId: string): DraftRow => {
  const found = w.drafts().find((d) => d.local_id === localId);
  if (found === undefined) throw new Error(`no draft ${localId}`);
  return found;
};

/** A second page's outbox whose edit is held immediately before its store transaction begins, until `release`. */
function delayedPage(w: World) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const service = new Proxy(w.service, {
    get(target, key) {
      if (key !== "store") return Reflect.get(target, key, target);
      return new Proxy(target.store, {
        get(store, member) {
          if (member !== "run") return Reflect.get(store, member, store);
          return async (plan: { name: string }, ...rest: unknown[]) => {
            if (plan.name === "data.editQueuedDraft") {
              entered = true;
              await gate;
            }
            return (store.run as (...a: unknown[]) => unknown)(plan, ...rest);
          };
        },
      });
    },
  });
  const outbox: Outbox = createOutbox({
    service,
    quota: createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: 1e9 }) },
      now: () => 0,
    }),
    ids: { uuid: () => crypto.randomUUID() },
    clock: { now: () => 0, iso: () => new Date(0).toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
  });
  return { outbox, release, entered: () => entered };
}

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 1000 && !condition(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  if (!condition()) throw new Error("the delayed edit never began");
};

describe("B1 (Q1): a delayed edit in place never overwrites a newer edit of the same queued draft", () => {
  for (const peer of [true, false])
    test(`${peer ? "another caller edits the draft while this edit waits: refused draft_changed, the newer body kept" : "control: nobody else edits it: the delayed edit is written"}`, async () => {
      const w = await outboxWorld();
      expect((await w.outbox.enqueue(field("A"))).kind).toBe("queued");
      const reviewed = draftOf(w, "L").command_digest;
      const page = delayedPage(w);
      const editing = page.outbox.editQueued("L", {
        ...field("B"),
        expectDraft: (stored) => stored.command_digest === reviewed,
      });
      await until(page.entered);
      if (peer)
        expect((await w.outbox.editQueued("L", field("C"))).kind).toBe(
          "edited",
        );
      page.release();
      const outcome = await editing;
      if (peer) {
        expect(outcome).toEqual({ kind: "refused", reason: "draft_changed" });
        expect(w.commandOf("L")).toMatchObject({
          command: { text: "C" },
        });
      } else {
        expect(outcome.kind).toBe("edited");
        expect(w.commandOf("L")).toMatchObject({
          command: { text: "B" },
        });
      }
      expect(w.drafts()).toHaveLength(1);
    });
});

describe("B1 (Q2): a delayed edit of an unsent create never undoes a defaults confirmation made meanwhile", () => {
  for (const peer of [true, false])
    test(`${peer ? "the defaults are confirmed while the edit waits: refused draft_changed, the confirmed revision and cleared review kept" : "control: no confirmation: the edit is written and the review block is kept"}`, async () => {
      const w = await outboxWorld();
      w.put("cache", [cacheRow({ id: "r", version: 5 })]);
      const out = await w.outbox.enqueue(
        createWith("Ada", captureDefaults(null, ["person"])),
      );
      if (out.kind !== "queued") throw new Error("setup");
      const reviewed = draftOf(w, out.localId).command_digest;
      const page = delayedPage(w);
      const editing = page.outbox.editQueued(out.localId, {
        ...createWith("Ada Lovelace", captureDefaults(null, ["person"])),
        expectDraft: (stored) => stored.command_digest === reviewed,
      });
      await until(page.entered);
      if (peer) {
        const now = captureDefaults(
          record(snapshot({ revision: revision(7) })),
          ["person"],
        );
        expect(
          (
            await w.outbox.confirmDefaultsReview(out.localId, {
              reviewed: reviewedOf(draftOf(w, out.localId)),
              defaultsRevision: now.defaultsRevision as string,
              defaultsContext: now.defaultsContext,
            })
          ).kind,
        ).toBe("confirmed");
      }
      page.release();
      const outcome = await editing;
      const stored = draftOf(w, out.localId);
      if (peer) {
        expect(outcome).toEqual({ kind: "refused", reason: "draft_changed" });
        expect(stored.review_block).toBeNull();
        expect(w.commandOf(out.localId)).toMatchObject({
          commands: [{ name: "Ada" }],
          defaults_revision: revision(7),
        });
      } else {
        expect(outcome.kind).toBe("edited");
        expect(stored.review_block).not.toBeNull();
        expect(w.commandOf(out.localId)).toMatchObject({
          commands: [{ name: "Ada Lovelace" }],
        });
      }
    });
});
