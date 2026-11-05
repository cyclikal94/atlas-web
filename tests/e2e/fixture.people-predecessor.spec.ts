import type { Page } from "@playwright/test";
import type { HarnessEnqueue } from "../../src/fixture/data-harness/main";
import { recordEvidence } from "./data-evidence";
import { ACCOUNT, dataPage } from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-P38 (WEB-11a review 12, R12.1 and its reverse schedule; DA12-10): TWO real pages over ONE real IndexedDB database. Each page has its
 * own memory and its own connection; their writes are ordered only by their own transactions (straight to the production plans, as E-O1
 * does: no dispatcher, no quota). A save that FOLLOWS a reviewed save names it (`expectPredecessor`: its id and the digest of the body
 * read); an edit in place asks to be the newest save (`expectLatest`). The schedules: the other page edits the predecessor first (the
 * follower is refused, nothing written), the follower is written first (the older edit is refused, the body kept), each with its control,
 * and rounds in which both pages race at once (never both). FIXTURE evidence: real engines and real IndexedDB, the production plans; not
 * the facade's quota wait (component and production-facade tests cover it), a dispatcher's claim and rollback, or a backend.
 */
const RESOURCE = (n: number) => `r${n}`;
const cached = (id: string, version: number) => ({
  id,
  kind: "person",
  parent_id: null,
  label: id,
  value: null,
  version,
  can_edit: true,
  archived: false,
  kind_date: null,
});
const save = (
  id: string,
  localId: string,
  label: string,
  extra: Partial<HarnessEnqueue> = {},
): HarnessEnqueue => ({
  endpoint: "/commands",
  localId,
  targets: [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ],
  command: { kind: "edit", id, base: { $base: id }, label },
  ...extra,
});

interface Draft {
  local_id: string;
  command_digest: string;
  depends_on: string[];
  bases: Record<string, number>;
}
const drafts = async (page: Page): Promise<Draft[]> =>
  ((await page.evaluate(
    (acct) => window.__atlasData?.rows(acct, "drafts"),
    ACCOUNT,
  )) ?? []) as Draft[];
const digestOf = async (page: Page, localId: string) =>
  (await drafts(page)).find((d) => d.local_id === localId)?.command_digest;
const enqueue = (page: Page, spec: HarnessEnqueue) =>
  page.evaluate((x) => window.__atlasData?.enqueueDirect(x.acct, x.spec), {
    acct: ACCOUNT,
    spec,
  });
const editQueued = (page: Page, localId: string, spec: HarnessEnqueue) =>
  page.evaluate(
    (x) => window.__atlasData?.editQueuedDirect(x.acct, x.localId, x.spec),
    { acct: ACCOUNT, localId, spec },
  );

async function twoPages(context: import("@playwright/test").BrowserContext) {
  const a = await dataPage(context);
  const b = await dataPage(context);
  for (const page of [a, b])
    await page.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      data.setRuntimeIdentity({ account: acct, epoch: 1 });
      await data.openService(acct, { create: true });
    }, ACCOUNT);
  await a.evaluate(
    ({ acct, rows }) => window.__atlasData?.put(acct, "cache", rows),
    {
      acct: ACCOUNT,
      rows: Array.from({ length: 12 }, (_, i) => cached(RESOURCE(i), 4)),
    },
  );
  return { a, b };
}

test.describe("E-P38: a reviewed predecessor and the newest save, across two real pages", () => {
  for (const peer of [true, false])
    test(`E-P38a: page A ${peer ? "edits L to B first; page B's save that follows L as it read it (A) is refused predecessor_changed and writes nothing" : "changes nothing (control): page B's save follows L at base 5"}`, async ({
      context,
    }, info) => {
      const { a, b } = await twoPages(context);
      const r = RESOURCE(0);
      expect((await enqueue(a, save(r, "L", "A")))?.kind).toBe("queued");
      // Page B reads L as it is stored (its own read, its own memory).
      const read = await digestOf(b, "L");
      expect(read).toBeTruthy();
      if (peer)
        expect((await editQueued(a, "L", save(r, "L", "B")))?.kind).toBe(
          "edited",
        );
      const after = await digestOf(b, "L");
      expect(after === read).toBe(!peer);
      const outcome = await enqueue(
        b,
        save(r, "S", "C", {
          expectPredecessor: {
            resourceId: r,
            localId: "L",
            digest: read as string,
          },
        }),
      );
      const rows = await drafts(a);
      await recordEvidence(info, "e-p38a", {
        peer,
        read,
        after,
        outcome,
        rows,
      });
      if (peer) {
        expect(outcome).toEqual({
          kind: "refused",
          reason: "predecessor_changed",
        });
        expect(rows.map((d) => d.local_id)).toEqual(["L"]);
      } else {
        expect(outcome?.kind).toBe("queued");
        const s = rows.find((d) => d.local_id === "S");
        expect(s?.depends_on).toEqual(["L"]);
        expect(s?.bases[r]).toBe(5);
      }
    });

  for (const later of [true, false])
    test(`E-P38b: page B ${later ? "queues a save after L first; page A's older edit of L (newest-save rule) is refused not_latest and L keeps A" : "queues nothing (control): page A's edit of L is written"}`, async ({
      context,
    }, info) => {
      const { a, b } = await twoPages(context);
      const r = RESOURCE(1);
      expect((await enqueue(a, save(r, "L", "A")))?.kind).toBe("queued");
      const read = (await digestOf(a, "L")) as string;
      if (later)
        expect(
          (
            await enqueue(
              b,
              save(r, "S", "C", {
                expectPredecessor: {
                  resourceId: r,
                  localId: "L",
                  digest: read,
                },
              }),
            )
          )?.kind,
        ).toBe("queued");
      const outcome = await editQueued(
        a,
        "L",
        save(r, "L", "B", { expectLatest: true }),
      );
      const now = await digestOf(b, "L");
      await recordEvidence(info, "e-p38b", { later, read, now, outcome });
      if (later) {
        expect(outcome).toEqual({ kind: "refused", reason: "not_latest" });
        expect(now).toBe(read);
      } else {
        expect(outcome?.kind).toBe("edited");
        expect(now).not.toBe(read);
      }
    });

  test("E-P38c: the two pages race on L in each of 8 rounds: the edit and the save that follows the older body are never both written", async ({
    context,
  }, info) => {
    const { a, b } = await twoPages(context);
    const rounds: unknown[] = [];
    for (let i = 0; i < 8; i += 1) {
      const r = RESOURCE(2 + i);
      const L = `L${i}`;
      expect((await enqueue(a, save(r, L, "A")))?.kind).toBe("queued");
      const read = (await digestOf(b, L)) as string;
      const [edited, followed] = await Promise.all([
        editQueued(a, L, save(r, L, "B", { expectLatest: true })),
        enqueue(
          b,
          save(r, `S${i}`, "C", {
            expectPredecessor: { resourceId: r, localId: L, digest: read },
          }),
        ),
      ]);
      rounds.push({ i, edited, followed });
      // Exactly one is written, whichever transaction came first; the other is refused with its own reason.
      expect(
        [edited?.kind === "edited", followed?.kind === "queued"].filter(
          Boolean,
        ),
      ).toHaveLength(1);
      if (edited?.kind === "edited")
        expect(followed).toEqual({
          kind: "refused",
          reason: "predecessor_changed",
        });
      else expect(edited).toEqual({ kind: "refused", reason: "not_latest" });
    }
    await recordEvidence(info, "e-p38c", { rounds });
  });
});
