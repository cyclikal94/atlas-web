import type { Page } from "@playwright/test";
import {
  ACCOUNT,
  deltaPage,
  displayed,
  fencedWithCursor,
  fencesOf,
  held,
  leaderPage,
} from "./data-leader-helpers";
import { upsert } from "./data-sync-helpers";
import { installDisplayOracle } from "./display-oracle";
import { expect, test } from "./helpers";

/**
 * WEB-08c revision 3 (R5; design assessment Q1): QUALIFICATION of the continuous no-early-display oracle (`display-oracle.ts`) in real
 * engines, before any case relies on it. The PRODUCTION session, boot and leader (`/__session?leader=production`), real IndexedDB and
 * locks; the recovery's `/sync` is scripted and HELD, so the account stays fenced while the test acts. FIXTURE evidence, no backend.
 *
 *   control  a held recovery with nothing injected: after the release the account is displayed and the oracle reports nothing;
 *   each injection below happens during the hold, is undone in the same task (so the final DOM is clean), and must be REPORTED with
 *   its kind: a node mounted into `#protected-root`; `inert` removed (attribute) and re-set; `inert` removed through the property and
 *   re-set; `aria-hidden` removed and re-set; a protected title set and reset; an account marker shown outside the protected root;
 *   enrolment  a page that escaped the oracle (`?oracle=off`) makes `assertClean` fail.
 *
 * The product-level control (a kernel that exposes a fenced account) is an A/B build run outside this spec; see the WEB-08c report.
 */
const MARKERS = ["alice", "kept", "oracle-marker-qualify"];

type Injection =
  | "mount"
  | "lift"
  | "lift-property"
  | "aria-hidden"
  | "title"
  | "marker";
const INJECTIONS: Record<Injection, string> = {
  mount: "mount",
  lift: "lift",
  "lift-property": "lift",
  "aria-hidden": "lift",
  title: "title",
  marker: "marker",
};

/** Test-only: an early exposure made and undone in ONE task, so only a recorder of every change can see it. */
const inject = (page: Page, kind: Injection) =>
  page.evaluate((k) => {
    const root = document.getElementById("protected-root") as HTMLElement & {
      inert: boolean;
    };
    switch (k) {
      case "mount": {
        const node = document.createElement("div");
        root.append(node);
        node.remove();
        break;
      }
      case "lift":
        root.removeAttribute("inert");
        root.setAttribute("inert", "");
        break;
      case "lift-property":
        root.inert = false;
        root.inert = true;
        break;
      case "aria-hidden":
        root.removeAttribute("aria-hidden");
        root.setAttribute("aria-hidden", "true");
        break;
      case "title": {
        const before = document.title;
        document.title = "Today · Atlas";
        document.title = before;
        break;
      }
      case "marker": {
        const node = document.createElement("div");
        node.textContent = "oracle-marker-qualify";
        document.body.append(node);
        node.remove();
        break;
      }
    }
    return {
      inert: root.hasAttribute("inert"),
      ariaHidden: root.getAttribute("aria-hidden"),
      children: root.childNodes.length,
      title: document.title,
    };
  }, kind);

async function heldRecovery(context: Parameters<typeof fencedWithCursor>[0]) {
  const net = await fencedWithCursor(context);
  const hold = held();
  net.answer = async (call) => {
    if (call.cursor === "delta-0") {
      await hold.promise;
      return deltaPage([upsert(7, { n: 7 })], "delta-1");
    }
    return deltaPage([], call.cursor ?? "x");
  };
  const page = await leaderPage(context, net, "one");
  await expect.poll(() => net.calls.length, { timeout: 15_000 }).toBe(1);
  // Precondition: the account is fenced and nothing is exposed while the recovery's read is held.
  expect(await fencesOf(page)).toHaveLength(1);
  expect(
    await page.evaluate(() => {
      const root = document.getElementById("protected-root");
      return {
        inert: root?.hasAttribute("inert"),
        children: root?.childNodes.length,
      };
    }),
  ).toEqual({ inert: true, children: 0 });
  return { net, page, release: hold.release };
}

test.describe("Q1: the continuous display oracle is sensitive to every exposure route and silent on a healthy recovery", () => {
  // Diagnostic only: a failing case attaches every open page's oracle log.
  test.afterEach(async ({ context }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    for (const [index, page] of context.pages().entries()) {
      const log = await page
        .evaluate(
          () =>
            (window as unknown as { __displayOracle?: { log: unknown } })
              .__displayOracle?.log ?? null,
        )
        .catch(() => null);
      if (log)
        await testInfo.attach(`oracle-log-page-${index}.json`, {
          body: JSON.stringify(log, null, 1),
          contentType: "application/json",
        });
    }
  });
  test("Q1 control: a held recovery with nothing injected is displayed after the release and the oracle reports nothing", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, { markers: MARKERS });
    const { page, release } = await heldRecovery(context);
    await oracle.mark(page, "release");
    release();
    await displayed(page);
    expect(await fencesOf(page)).toEqual([]);
    await oracle.assertClean("Q1 control");
    // The authorising boundary is in the log, before the episode opened: a committed record of the page with no fence.
    const log = await oracle.log(page);
    const open = log.findIndex((e) => e.op === "episode.open");
    expect(open).toBeGreaterThan(-1);
    const commits = log
      .slice(0, open)
      .filter((e) => e.op === "auth.commit") as Array<{
      record: { settled: string | null; fences: Record<string, number> };
    }>;
    expect(commits.at(-1)?.record).toMatchObject({ settled: ACCOUNT });
    expect(commits.at(-1)?.record.fences[ACCOUNT] ?? 0).toBe(0);
  });

  for (const kind of Object.keys(INJECTIONS) as Injection[])
    test(`Q1 sensitivity: an early ${kind} undone in the same task is reported`, async ({
      context,
    }) => {
      const oracle = await installDisplayOracle(context, { markers: MARKERS });
      const { page, release } = await heldRecovery(context);
      const after = await inject(page, kind);
      // The final DOM is clean: only a recorder of every change can know.
      expect(after).toMatchObject({
        inert: true,
        ariaHidden: "true",
        children: 0,
      });
      release();
      await displayed(page);
      expect(
        oracle.violations().map((v) => v.kind),
        `the ${kind} injection`,
      ).toEqual([INJECTIONS[kind]]);
    });

  test("Q1 enrolment: a page that escaped the oracle fails the setup check", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, { markers: MARKERS });
    const page = await context.newPage();
    await page.goto("/__session?boot=off&oracle=off");
    await page.waitForFunction(() => window.__atlasData !== undefined);
    expect((await oracle.coverage()).missing).toHaveLength(1);
    let failed = false;
    try {
      await oracle.assertClean("Q1 enrolment");
    } catch {
      failed = true;
    }
    expect(failed, "assertClean must refuse an unenrolled page").toBe(true);
  });
});
