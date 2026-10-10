import type { Page } from "@playwright/test";
import {
  classify,
  describe as described,
  type Fault,
  type Report,
  report,
  runLoop,
  type Verdict,
} from "./d5-collector";
import { recordEvidence } from "./data-evidence";
import { dataPage } from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * D5-Q15 (revision 38): the controls of the D5 collector (`d5-collector.ts`, Q15 of the design assessment of review 37). D5's locked
 * half once did not finish in WebKit and nothing then said why; the collector now classifies each page of a half that stops progressing.
 * Before its verdicts are relied on, each is produced here by a fault the spec installs on purpose, in a real engine:
 *
 *  - normal: every page finishes, and the collector says so;
 *  - a lock another client holds: the three pages are WAITING, queued, behind a holder that is none of them (and the holder is the
 *    client that holds it);
 *  - a callback that never returns: that page is IN ITS CALLBACK, and the others wait behind IT;
 *  - a responsive, slow page: the counts PROGRESS between two reports, and the half finishes;
 *  - a page whose main thread is busy: it gives NO ANSWER within the bound, and the others wait.
 *
 * The workload is D5's (three `/__data` pages, 400 read-modify-write steps each under one Web Lock); the faults are named injections in
 * the pages' own loop. Every report is bounded (`ANSWER_MS`). FIXTURE diagnostics of the engine, not of the product.
 */
const ANSWER_MS = 2_000;
/** How long a loop is given to reach the state a control installs (a condition polled, not a duration requirement). */
const REACH_MS = 15_000;

async function threePages(context: Parameters<typeof dataPage>[0]) {
  const pages: Page[] = [];
  for (let n = 0; n < 3; n += 1) pages.push(await dataPage(context));
  return pages;
}

const reports = (pages: readonly Page[], key: string, manager = true) =>
  Promise.all(
    pages.map((page, index) =>
      report(page, key, index, { answerMs: ANSWER_MS, manager }),
    ),
  );

/** Starts the three loops (not awaited) and remembers which answers reached the test. */
function start(pages: readonly Page[], key: string, faults: Fault[]) {
  const answered = pages.map(() => false);
  const work = pages.map((page, index) =>
    runLoop(page, {
      id: `p${index}`,
      key,
      locked: true,
      fault: faults[index] ?? { kind: "none" },
    })
      .then((count) => {
        answered[index] = true;
        return count;
      })
      .catch(() => -1),
  );
  return { answered, work };
}

/** Reports until two successive reports show no progress of any page (the state the fault installs has been reached). */
async function settled(pages: readonly Page[], key: string): Promise<Report[]> {
  let last = "";
  const deadline = Date.now() + REACH_MS;
  for (;;) {
    const now = await reports(pages, key, false);
    const sum = JSON.stringify(
      now.map((r) => (r.answered && r.state ? r.state : null)),
    );
    if (sum === last && now.some((r) => r.answered && r.state !== null))
      return reports(pages, key, true);
    last = sum;
    if (Date.now() > deadline)
      throw new Error(`the controls' state was not reached: ${sum}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test.describe("D5-Q15 (revision 38): the D5 collector's verdicts, each produced by a fault installed on purpose, in a real engine", () => {
  test("D5-Q15 normal control: every page finishes, and the collector says so", async ({
    context,
  }, info) => {
    const pages = await threePages(context);
    const { answered, work } = start(pages, "q15-normal", []);
    expect(await Promise.all(work)).toEqual([400, 400, 400]);
    const now = await reports(pages, "q15-normal");
    const verdicts = classify(now, answered);
    recordEvidence(info, "d5-q15-normal", { now, verdicts });
    expect(verdicts).toEqual(
      pages.map(() => ({ kind: "finished", unanswered: false })),
    );
  });

  test("D5-Q15 a lock another client holds: the three pages wait, queued, behind a holder that is none of them", async ({
    context,
  }, info) => {
    const holder = await dataPage(context);
    const key = "q15-held";
    // Another client of the origin takes the measured lock and keeps it.
    void holder
      .evaluate(
        (k) =>
          navigator.locks.request(
            `rmw:${k}`,
            () => new Promise<never>(() => undefined),
          ),
        key,
      )
      .catch(() => undefined);
    await expect
      .poll(
        () =>
          holder.evaluate(
            async (k) =>
              (await navigator.locks.query()).held?.some(
                (lock) => lock.name === `rmw:${k}`,
              ) ?? false,
            key,
          ),
        { timeout: REACH_MS },
      )
      .toBe(true);
    const holderId = await report(holder, key, 9, {
      answerMs: ANSWER_MS,
      manager: true,
    });
    const pages = await threePages(context);
    const { answered } = start(pages, key, []);
    const now = await settled(pages, key);
    const verdicts = classify(now, answered);
    recordEvidence(info, "d5-q15-held", { now, verdicts, holderId });
    expect(verdicts).toEqual(
      pages.map(() => ({ kind: "waiting", holder: "other", queued: true })),
    );
    // The holder the lock manager names is the client that took the lock.
    const view = now.find((r) => r.answered && r.manager !== null);
    expect(holderId.answered && holderId.clientId).toBeTruthy();
    expect(
      view?.answered ? view.manager?.held.map((lock) => lock.clientId) : null,
    ).toEqual([holderId.answered ? holderId.clientId : null]);
    expect(described(now, verdicts)).toContain("waiting, held by other");
  });

  test("D5-Q15 a callback that never returns: that page is in its callback, and the other two wait behind it", async ({
    context,
  }, info) => {
    const pages = await threePages(context);
    const key = "q15-blocked";
    const { answered } = start(pages, key, [
      { kind: "none" },
      { kind: "block", at: 10 },
      { kind: "none" },
    ]);
    const now = await settled(pages, key);
    const verdicts = classify(now, answered);
    recordEvidence(info, "d5-q15-blocked", { now, verdicts });
    const expected: Verdict[] = [
      { kind: "waiting", holder: "p1", queued: true },
      { kind: "in_callback" },
      { kind: "waiting", holder: "p1", queued: true },
    ];
    expect(verdicts).toEqual(expected);
  });

  test("D5-Q15 a responsive, slow page: the counts progress between two reports, and the half finishes", async ({
    context,
  }, info) => {
    const pages = await threePages(context);
    const key = "q15-slow";
    const { answered, work } = start(pages, key, [
      { kind: "slow", ms: 5 },
      { kind: "none" },
      { kind: "none" },
    ]);
    const counted = (rs: Report[]) =>
      rs.reduce((n, r) => n + (r.answered && r.state ? r.state.count : 0), 0);
    const first = await reports(pages, key, false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = await reports(pages, key, false);
    recordEvidence(info, "d5-q15-slow", {
      first: counted(first),
      second: counted(second),
    });
    expect(first.every((r) => r.answered)).toBe(true);
    expect(counted(second)).toBeGreaterThan(counted(first));
    expect(await Promise.all(work)).toEqual([400, 400, 400]);
    expect(classify(await reports(pages, key), answered)).toEqual(
      pages.map(() => ({ kind: "finished", unanswered: false })),
    );
  });

  test("D5-Q15 a page whose main thread is busy: it gives no answer within the bound, and the others wait", async ({
    context,
  }, info) => {
    const pages = await threePages(context);
    const key = "q15-busy";
    const busyMs = ANSWER_MS * 4;
    const { answered, work } = start(pages, key, [
      { kind: "none" },
      { kind: "none" },
      { kind: "busy", at: 5, ms: busyMs },
    ]);
    // The busy page has entered its fault: it stops answering. The round in which it first stops answering may have begun before the
    // fault did (driver-r38c, Chromium: one page's view of the lock manager was read while another page still held the lock, and that
    // page's own state was read after the busy page had taken it). The verdicts are therefore read from the NEXT round, which begins after
    // the onset and ends within `ANSWER_MS`, well inside the busy period (`busyMs` is four times as long); the busy page must still be
    // silent in it (the premise).
    let onset: Report[] = [];
    const deadline = Date.now() + REACH_MS;
    do {
      onset = await reports(pages, key);
    } while (!(onset[2]?.answered === false) && Date.now() < deadline);
    expect(onset[2]?.answered).toBe(false);
    const now = await reports(pages, key);
    const verdicts = classify(now, answered);
    recordEvidence(info, "d5-q15-busy", { onset, now, verdicts });
    expect(verdicts[2]).toEqual({ kind: "no_answer" });
    // The holder is the page that cannot say who it is: it is named `other`.
    for (const index of [0, 1])
      expect(verdicts[index]).toEqual({
        kind: "waiting",
        holder: "other",
        queued: true,
      });
    expect(await Promise.all(work)).toEqual([400, 400, 400]);
  });
});
