import type { BrowserContext, Page } from "@playwright/test";
import type { HarnessEnqueue } from "../../src/fixture/data-harness/main";
import { recordEvidence } from "./data-evidence";
import {
  ACCOUNT,
  atlasError,
  bootSession,
  seedSettled,
  startOutbox,
  stubNetwork,
  uuid,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-O7 (revision 25, R45): a supersession leaves the queue in an order every draft can follow, in a real engine.
 *
 * The production outbox facade, plans, dispatcher and Dexie adapter over REAL IndexedDB, through the production session's stamped
 * wrapper, with the network stubbed by `page.route`. FIXTURE evidence for this engine on this machine: the HTTP answers (a conflict, an
 * operation conflict, a defaults review) are scripted inputs, not the released backend's, and the dispatcher is the fixture's test leader
 * (production starts none until WEB-09b). The page goes OFFLINE (`context.setOffline`) while a save is queued, so the dispatcher holds it,
 * as an offline person's queue is held, and the answer to "can both be sent" is only what the rows say once the page is online again.
 *
 * What is asserted is what the review reproduced and what its audit found around it (see tests/data/outbox-supersede-order.test.ts, which
 * asserts the same rules over the double of the store): a replacement that now waits for a NEWER draft goes to the end of the queue;
 * one that cannot be placed is refused with every store byte for byte as it was; a dependant that stays queued keeps the version record
 * at what it stands on; a dropped side effect pauses the dependant that stood on it; a restart (a new page over the same database) reads
 * the same queue and the dispatcher sends what is left.
 */
type Cause = "conflict" | "operation_conflict" | "defaults_changed";
const CAUSES: Cause[] = ["conflict", "operation_conflict", "defaults_changed"];

const OLD = uuid(21);
const LATER = uuid(22);
const DEPENDANT = uuid(23);
const REPLACEMENT = uuid(24);
const NEXT = uuid(25);

/** A version-checked edit of `id` (and side effects), under a fixed key; `$base` is the base the transaction read for `id`. */
const edit = (
  id: string,
  localId: string,
  more: { side?: string[]; dependsOn?: string[] } = {},
): HarnessEnqueue => ({
  endpoint: "/commands",
  localId,
  ...(more.dependsOn === undefined ? {} : { dependsOn: more.dependsOn }),
  targets: [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
    ...(more.side ?? []).map((side) => ({
      resourceId: side,
      role: "side_effect" as const,
      basis: "resource" as const,
      versionChecked: true,
    })),
  ],
  command: { kind: "edit", id, base: { $base: id }, label: localId },
});

const enqueue = (page: Page, spec: HarnessEnqueue) =>
  page.evaluate((s) => window.__atlasData?.enqueue(s), spec);
const supersede = (page: Page, old: string, spec: HarnessEnqueue) =>
  page.evaluate(
    ([o, s]) => window.__atlasData?.supersede(o as string, s as HarnessEnqueue),
    [old, spec] as const,
  );
const discard = (page: Page, localId: string) =>
  page.evaluate((id) => window.__atlasData?.discardDraft(id), localId);
const queue = (page: Page) =>
  page.evaluate((a) => window.__atlasData?.queue(a), ACCOUNT);
const rowsOf = (
  page: Page,
  store: "drafts" | "draft_commands" | "resource_versions",
) =>
  page.evaluate(([a, st]) => window.__atlasData?.rows(a, st as "drafts"), [
    ACCOUNT,
    store,
  ] as const);
const counter = (page: Page): Promise<number> =>
  page.evaluate(async (a) => {
    const rows = (await window.__atlasData?.rows(a, "sync_state")) ?? [];
    return (rows[0] as { draft_seq?: number } | undefined)?.draft_seq ?? -1;
  }, ACCOUNT);
/** The stores a supersession may touch, as they are at rest. */
const everything = async (page: Page) => ({
  drafts: await rowsOf(page, "drafts"),
  bodies: await rowsOf(page, "draft_commands"),
  versions: await rowsOf(page, "resource_versions"),
  counter: await counter(page),
});
const statusOf = async (page: Page, id: string) => {
  const row = (await queue(page))?.find((d) => d.local_id === id);
  return row?.status;
};
const untilStatus = (page: Page, id: string, status: string) =>
  expect.poll(() => statusOf(page, id), { timeout: 20_000 }).toBe(status);

const WANT: Record<Cause, string> = {
  conflict: "version_conflict",
  operation_conflict: "operation_conflict",
  defaults_changed: "in_flight",
};

/** `OLD` (on `r`, with the given side effects) answered with `cause`; the page then goes offline, so nothing queued is sent. */
async function conflicted(
  context: BrowserContext,
  cause: Cause,
  options: { oldSide?: string[] } = {},
) {
  const net = await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  await startOutbox(page);
  await page.evaluate(
    (acct) =>
      window.__atlasData?.put(
        acct,
        "cache",
        ["r", "s", "t"].map((id) => ({
          id,
          kind: "person",
          parent_id: null,
          label: id,
          value: null,
          version: 5,
          can_edit: true,
          archived: false,
          kind_date: null,
        })),
      ),
    ACCOUNT,
  );
  net.commandScript.push(() => ({ status: 409, body: atlasError(cause) }));
  expect(
    (await enqueue(page, edit("r", OLD, { side: options.oldSide })))?.kind,
  ).toBe("queued");
  // A defaults review is `in_flight` from the claim, BEFORE the answer is recorded: the review block is what says it was answered.
  if (cause === "defaults_changed")
    await expect
      .poll(
        async () =>
          (await queue(page))?.find((d) => d.local_id === OLD)?.review_block,
        { timeout: 20_000 },
      )
      .toBe(true);
  await untilStatus(page, OLD, WANT[cause]);
  await context.setOffline(true);
  return { net, page };
}

/** Back online: the dispatcher is woken by the browser's own `online` event. */
const goOnline = (context: BrowserContext) => context.setOffline(false);

/** The sent keys, in order, after the first (the old draft's own conflicted request). */
const sentAfterOld = (net: { commands: Array<{ key: string | null }> }) =>
  net.commands.map((c) => c.key).slice(1);

/** A restart: the page is closed and a new one is booted over the same database; the outbox is started without arranging anything. */
async function restart(context: BrowserContext, page: Page): Promise<Page> {
  await page.close();
  const next = await bootSession(context);
  await next.evaluate(async (acct) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(acct, { start: false });
  }, ACCOUNT);
  return next;
}

test.describe("E-O7 (revision 25, R45): the reviewer's arrangements, in a real engine", () => {
  for (const cause of CAUSES)
    for (const mode of [
      "same-target-control",
      "retarget-empty-control",
      "retarget-occupied",
      "add-side-effect",
    ] as const)
      test(`R45: ${mode} after ${cause}: the replacement and the later save are both sent, in an order that follows their versions; a restart reads the same queue`, async ({
        context,
      }, info) => {
        const { net, page } = await conflicted(context, cause);
        const occupied =
          mode === "retarget-occupied" || mode === "add-side-effect";
        if (mode !== "retarget-empty-control")
          expect(
            (
              await enqueue(
                page,
                edit(mode === "same-target-control" ? "r" : "s", LATER),
              )
            )?.kind,
          ).toBe("queued");
        const next = edit(
          mode === "same-target-control" || mode === "add-side-effect"
            ? "r"
            : "s",
          REPLACEMENT,
          { side: mode === "add-side-effect" ? ["s"] : [] },
        );
        const counterBefore = await counter(page);
        const out = await supersede(page, OLD, next);
        const rows = (await queue(page)) ?? [];
        const replacement = rows.find((d) => d.local_id === REPLACEMENT);
        const later = rows.find((d) => d.local_id === LATER);
        recordEvidence(info, `reviewer-${cause}-${mode}`, {
          out,
          rows,
          counterBefore,
          counterAfter: await counter(page),
        });
        expect(out).toMatchObject({ kind: "superseded", localId: REPLACEMENT });
        expect(rows.some((d) => d.local_id === OLD)).toBe(false);
        // Every unsettled dependency is OLDER than its dependant: the queue can always be followed.
        for (const row of rows)
          for (const id of row.depends_on) {
            const dependency = rows.find((d) => d.local_id === id);
            if (dependency && row.status !== "rejected")
              expect(dependency.created_seq).toBeLessThan(row.created_seq);
          }
        if (occupied) {
          expect(replacement?.depends_on).toContain(LATER);
          expect(replacement?.created_seq).toBeGreaterThan(
            later?.created_seq ?? 0,
          );
          expect(await counter(page)).toBe(counterBefore + 1);
        } else {
          expect(replacement?.created_seq).toBe(1);
          expect(await counter(page)).toBe(counterBefore);
        }

        await goOnline(context);
        await untilStatus(page, REPLACEMENT, "acknowledged");
        if (mode !== "retarget-empty-control")
          await untilStatus(
            page,
            LATER,
            mode === "same-target-control" && cause === "conflict"
              ? "version_conflict"
              : "acknowledged",
          );
        if (occupied) expect(sentAfterOld(net)).toEqual([LATER, REPLACEMENT]);
        // The old draft was sent once, and never again under its key.
        expect(net.commands.filter((c) => c.key === OLD)).toHaveLength(1);

        const written = await everything(page);
        const reloaded = await restart(context, page);
        const after = await everything(reloaded);
        expect(after.drafts).toEqual(written.drafts);
        expect(after.bodies).toEqual(written.bodies);
        expect(after.counter).toBe(written.counter);
      });
});

test.describe("E-O7 (revision 25, R45): a request that cannot be placed is refused and the old draft is not retired, in a real engine", () => {
  for (const cause of CAUSES)
    test(`R45: ${cause}: a newer draft and a dependant behind the replacement: refused, every store as it was`, async ({
      context,
    }, info) => {
      const { net, page } = await conflicted(context, cause);
      expect((await enqueue(page, edit("r", DEPENDANT)))?.kind).toBe("queued");
      expect((await enqueue(page, edit("s", LATER)))?.kind).toBe("queued");
      const before = await everything(page);
      const first = await supersede(page, OLD, edit("s", REPLACEMENT));
      const second = await supersede(
        page,
        OLD,
        edit("r", uuid(26), { side: ["s"] }),
      );
      const after = await everything(page);
      recordEvidence(info, `refused-${cause}`, {
        first,
        second,
        before,
        after,
      });
      expect(first).toEqual({ kind: "refused", reason: "order_conflict" });
      expect(second).toEqual({ kind: "refused", reason: "order_conflict" });
      expect(after).toEqual(before);

      await goOnline(context);
      if (cause === "defaults_changed") {
        // A defaults review holds the queue behind it: nothing newer is sent while it stands (D-19).
        await expect
          .poll(() => net.commands.length, { timeout: 5_000 })
          .toBe(1);
        expect(await statusOf(page, LATER)).toBe("queued");
        expect(await everything(page)).toEqual(before);
        return;
      }
      // The refusal is not permanent: once the later save is settled the same request is admitted, in the old draft's place.
      await untilStatus(page, LATER, "acknowledged");
      const retried = await supersede(page, OLD, edit("s", REPLACEMENT));
      expect(retried).toMatchObject({
        kind: "superseded",
        localId: REPLACEMENT,
      });
      const placed = (await queue(page))?.find(
        (d) => d.local_id === REPLACEMENT,
      );
      expect(placed?.created_seq).toBe(1);
      await untilStatus(page, REPLACEMENT, "acknowledged");
    });

  test("R45: the person's other way forward: discarding the old draft rejects its dependant and frees the later save", async ({
    context,
  }) => {
    const { page } = await conflicted(context, "conflict");
    await enqueue(page, edit("r", DEPENDANT));
    await enqueue(page, edit("s", LATER));
    expect((await supersede(page, OLD, edit("s", REPLACEMENT)))?.kind).toBe(
      "refused",
    );
    expect(await discard(page, OLD)).toMatchObject({
      kind: "discarded",
      affected: 1,
    });
    expect(await statusOf(page, DEPENDANT)).toBe("rejected");
    expect((await enqueue(page, edit("s", REPLACEMENT)))?.kind).toBe("queued");
    await page.context().setOffline(false);
    await untilStatus(page, LATER, "acknowledged");
    await untilStatus(page, REPLACEMENT, "acknowledged");
  });

  test("R45: a target the replacement raises where the old draft did not, which the old draft's dependant touches, is refused; without that dependant it is admitted", async ({
    context,
  }, info) => {
    const { page } = await conflicted(context, "operation_conflict");
    await enqueue(page, edit("r", DEPENDANT, { side: ["s"] }));
    const before = await everything(page);
    const refused = await supersede(
      page,
      OLD,
      edit("r", REPLACEMENT, { side: ["s"] }),
    );
    expect(await everything(page)).toEqual(before);
    expect(refused).toEqual({ kind: "refused", reason: "order_conflict" });
    // The dependant that does not touch `s`: the same side effect is admitted in place.
    await discard(page, DEPENDANT);
    await enqueue(page, edit("r", uuid(27)));
    const admitted = await supersede(
      page,
      OLD,
      edit("r", REPLACEMENT, { side: ["s"] }),
    );
    recordEvidence(info, "raised-target", { refused, admitted });
    expect(admitted).toMatchObject({
      kind: "superseded",
      localId: REPLACEMENT,
    });
    await page.context().setOffline(false);
    await untilStatus(page, REPLACEMENT, "acknowledged");
    await untilStatus(page, uuid(27), "acknowledged");
  });

  test("R45: an explicit dependency on a dependant of the old draft is a cycle and is refused; on a newer draft, with no dependant behind, it goes to the end", async ({
    context,
  }, info) => {
    const { net, page } = await conflicted(context, "operation_conflict");
    await enqueue(page, edit("r", DEPENDANT));
    await enqueue(page, edit("s", LATER));
    const before = await everything(page);
    const cycle = await supersede(
      page,
      OLD,
      edit("r", uuid(28), { dependsOn: [DEPENDANT] }),
    );
    const inverted = await supersede(
      page,
      OLD,
      edit("r", uuid(29), { dependsOn: [LATER] }),
    );
    recordEvidence(info, "explicit-dependencies", { cycle, inverted });
    expect(cycle).toEqual({ kind: "refused", reason: "order_conflict" });
    expect(inverted).toEqual({ kind: "refused", reason: "order_conflict" });
    expect(await everything(page)).toEqual(before);
    // With nothing standing behind it, the explicit dependency on the newer draft is honoured by going behind it.
    expect((await discard(page, DEPENDANT))?.kind).toBe("discarded");
    const behind = await supersede(
      page,
      OLD,
      edit("r", REPLACEMENT, { dependsOn: [LATER] }),
    );
    expect(behind).toMatchObject({ kind: "superseded", localId: REPLACEMENT });
    await goOnline(page.context());
    await untilStatus(page, REPLACEMENT, "acknowledged");
    expect(sentAfterOld(net)).toEqual([LATER, REPLACEMENT]);
  });
});

test.describe("E-O7 (revision 25, R45): the version bases after a supersession that has dependants, in a real engine", () => {
  test("R45: a dependant that stays queued keeps the record at what it stands on: the next save is based on the version the dependant leaves, and the bodies sent carry 5, 6, 7", async ({
    context,
  }, info) => {
    const { net, page } = await conflicted(context, "operation_conflict");
    await enqueue(page, edit("r", DEPENDANT));
    const recordOf = async () =>
      (
        (await rowsOf(page, "resource_versions")) as Array<{
          resource_id: string;
          locally_assumed_version: number;
        }>
      ).find((row) => row.resource_id === "r")?.locally_assumed_version;
    expect(await recordOf()).toBe(7);
    expect((await supersede(page, OLD, edit("r", REPLACEMENT)))?.kind).toBe(
      "superseded",
    );
    const record = await recordOf();
    expect((await enqueue(page, edit("r", NEXT)))?.kind).toBe("queued");
    const queued = (await queue(page))?.find((d) => d.local_id === NEXT);
    recordEvidence(info, "dependant-record", { record, next: queued });
    expect(record).toBe(7);
    await goOnline(context);
    await untilStatus(page, NEXT, "acknowledged");
    const bases = net.commands.slice(1).map((c) => JSON.parse(c.body).base);
    expect(bases).toEqual([5, 6, 7]);
  });

  test("R45: a dropped side effect pauses the dependant that stands on it, which is then not sent", async ({
    context,
  }, info) => {
    const { net, page } = await conflicted(context, "operation_conflict", {
      oldSide: ["s"],
    });
    await enqueue(page, edit("s", DEPENDANT));
    const out = await supersede(page, OLD, edit("r", REPLACEMENT));
    recordEvidence(info, "dropped-side-effect", { out });
    expect(out).toMatchObject({ kind: "superseded", paused: [DEPENDANT] });
    expect(await statusOf(page, DEPENDANT)).toBe("version_conflict");
    await goOnline(context);
    await untilStatus(page, REPLACEMENT, "acknowledged");
    expect(net.commands.some((c) => c.key === DEPENDANT)).toBe(false);
  });
});
