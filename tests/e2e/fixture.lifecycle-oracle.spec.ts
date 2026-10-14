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
import {
  FIXTURE_ACCOUNT_MARKERS,
  installDisplayOracle,
} from "./display-oracle";
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

/**
 * WEB-08c revision 4 (R5 of the review of 14 October 2026; design assessment P1, Q1, S13-S16): the routes the revision-3 observer could
 * not see. Each injection is made while the recovery read is HELD (the account fenced, the protected root inert and empty), the violation
 * is asserted BEFORE the release with its kind and the page's fenced record, and, where the injection is undone, the final DOM is safe.
 * The review's own probes are R4-1 (a persistent accessible name, also found by Playwright's accessible-name locator) and R4-3 (a text
 * node set and reset in one task). Healthy writes of safe values stay quiet.
 */
const R4_MARKER = "oracle-marker-qualify";
type R4Injection =
  | "accessible-name-persistent"
  | "accessible-name-transient"
  | "text-node-transient"
  | "text-content-replaced"
  | "nested-attribute-only"
  | "insert-change-remove"
  | "per-target-attribute"
  | "per-target-text"
  | "title-text-node"
  | "aria-hidden-false"
  | "safe-writes";
const R4_EXPECTED: Record<R4Injection, string[]> = {
  "accessible-name-persistent": ["marker"],
  "accessible-name-transient": ["marker"],
  "text-node-transient": ["marker"],
  "text-content-replaced": ["marker"],
  "nested-attribute-only": ["marker"],
  "insert-change-remove": ["marker"],
  "per-target-attribute": ["marker"],
  "per-target-text": ["marker"],
  "title-text-node": ["title"],
  "aria-hidden-false": ["lift"],
  "safe-writes": [],
};
/** Installs two harmless, existing controls outside the root (drained before the injection, so they are not the injection). */
const installExisting = (page: Page) =>
  page.evaluate(() => {
    for (const id of ["r4-a", "r4-b"]) {
      const node = document.createElement("button");
      node.id = id;
      node.textContent = "Safe";
      document.body.append(node);
    }
  });
const injectR4 = (page: Page, kind: R4Injection, marker: string) =>
  page.evaluate(
    ({ k, m }) => {
      const a = document.getElementById("r4-a") as HTMLElement;
      const b = document.getElementById("r4-b") as HTMLElement;
      const root = document.getElementById("protected-root") as HTMLElement;
      switch (k) {
        case "accessible-name-persistent":
          a.setAttribute("aria-label", m);
          break;
        case "accessible-name-transient":
          a.setAttribute("aria-label", m);
          a.removeAttribute("aria-label");
          break;
        case "text-node-transient": {
          const text = a.firstChild as Text;
          text.data = m;
          text.data = "Safe";
          break;
        }
        case "text-content-replaced":
          a.textContent = m;
          a.textContent = "Safe";
          break;
        case "nested-attribute-only": {
          const outer = document.createElement("div");
          const inner = document.createElement("span");
          inner.setAttribute("aria-label", m);
          outer.append(inner);
          document.body.append(outer);
          outer.remove();
          break;
        }
        case "insert-change-remove": {
          const node = document.createElement("div");
          node.textContent = m;
          document.body.append(node);
          (node.firstChild as Text).data = "safe";
          node.remove();
          break;
        }
        case "per-target-attribute":
          // A's name stays the marker; B changes after it in the same task (a history keyed by attribute name alone reads B's).
          a.setAttribute("aria-label", m);
          b.setAttribute("aria-label", "Other");
          break;
        case "per-target-text":
          (a.firstChild as Text).data = m;
          (b.firstChild as Text).data = "Other";
          break;
        case "title-text-node": {
          let title = document.querySelector("title");
          if (!title) {
            title = document.createElement("title");
            document.head.append(title);
          }
          if (!title.firstChild) title.append(document.createTextNode(""));
          const text = title.firstChild as Text;
          const before = text.data;
          text.data = "Today · Atlas";
          text.data = before;
          break;
        }
        case "aria-hidden-false":
          root.setAttribute("aria-hidden", "false");
          root.setAttribute("aria-hidden", "true");
          break;
        case "safe-writes": {
          a.setAttribute("aria-label", "Safe name");
          (b.firstChild as Text).data = "Still safe";
          const node = document.createElement("div");
          node.setAttribute("title", "Nothing about an account");
          node.textContent = "Neutral";
          document.body.append(node);
          node.remove();
          document.title = "Atlas";
          break;
        }
      }
      return {
        inert: root.hasAttribute("inert"),
        ariaHidden: root.getAttribute("aria-hidden"),
        children: root.childNodes.length,
        name: a.getAttribute("aria-label"),
        text: a.textContent,
      };
    },
    { k: kind, m: marker },
  );

test.describe("Q1 (revision 4): accessible names, transient text, removed and nested nodes, title text and coverage", () => {
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

  for (const kind of Object.keys(R4_EXPECTED) as R4Injection[])
    test(`Q1 R4 ${kind}: ${R4_EXPECTED[kind].length ? `reported as ${R4_EXPECTED[kind].join(",")} while fenced` : "healthy control, nothing reported"}`, async ({
      context,
    }) => {
      const oracle = await installDisplayOracle(context, {
        markers: [R4_MARKER],
      });
      const { page, release } = await heldRecovery(context);
      await installExisting(page);
      await oracle.mark(page, "existing controls installed");
      expect(oracle.violations(), "precondition: nothing yet").toEqual([]);
      const after = await injectR4(page, kind, R4_MARKER);
      // The account is still fenced and nothing protected is mounted or lifted.
      expect(after).toMatchObject({
        inert: true,
        ariaHidden: "true",
        children: 0,
      });
      expect(await fencesOf(page)).toHaveLength(1);
      if (kind === "accessible-name-persistent")
        await expect(
          page.getByRole("button", { name: R4_MARKER, exact: true }),
        ).toBeVisible();
      if (kind === "accessible-name-transient") expect(after.name).toBeNull();
      if (kind === "text-node-transient" || kind === "text-content-replaced")
        expect(after.text).toBe("Safe");
      await oracle.mark(page, "after the injection");
      // Reported BEFORE the release, with the page's fenced record.
      await expect
        .poll(() => oracle.violations().map((v) => v.kind), {
          timeout: 5_000,
        })
        .toEqual(R4_EXPECTED[kind]);
      for (const v of oracle.violations()) {
        expect(v.record?.settled).toBe(ACCOUNT);
        expect(v.record?.fences[ACCOUNT] ?? 0).toBeGreaterThan(0);
      }
      if (kind === "accessible-name-persistent")
        await page.evaluate(() =>
          document.getElementById("r4-a")?.removeAttribute("aria-label"),
        );
      release();
      await displayed(page);
      expect(await fencesOf(page)).toEqual([]);
      expect(oracle.violations().map((v) => v.kind)).toEqual(R4_EXPECTED[kind]);
      if (kind === "safe-writes") await oracle.assertClean("R4 safe writes");
    });

  test("Q1 R4 aborted write: an atlas-auth write that clears the fence and is ABORTED authorises nothing (a later lift is still reported)", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, {
      markers: [R4_MARKER],
    });
    const { page, release } = await heldRecovery(context);
    // Test-only: this page's own transaction writes an auth_state with no fence for the account, then aborts it.
    const aborted = await page.evaluate(
      (account) =>
        new Promise<string>((done) => {
          const open = indexedDB.open("atlas-auth");
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(["records"], "readwrite");
            const store = tx.objectStore("records");
            const get = store.get("auth_state");
            get.onsuccess = () => {
              const state = structuredClone(get.result) as {
                fences: Record<string, unknown[]>;
              };
              state.fences = { ...state.fences, [account]: [] };
              store.put(state, "auth_state");
              tx.abort();
            };
            tx.onabort = () => {
              // At once, in the task that learns of the abort (no other atlas-auth transaction commits in between): a lift.
              const root = document.getElementById(
                "protected-root",
              ) as HTMLElement;
              root.removeAttribute("inert");
              root.setAttribute("inert", "");
              db.close();
              done("aborted");
            };
            tx.oncomplete = () => {
              db.close();
              done("committed");
            };
          };
          open.onerror = () => done("open failed");
        }),
      ACCOUNT,
    );
    expect(aborted).toBe("aborted");
    expect(await fencesOf(page)).toHaveLength(1);
    await expect
      .poll(() => oracle.violations().map((v) => v.kind), { timeout: 5_000 })
      .toEqual(["lift"]);
    expect(
      oracle.violations()[0]?.record?.fences[ACCOUNT] ?? 0,
    ).toBeGreaterThan(0);
    release();
    await displayed(page);
  });

  for (const how of ["typed", "prefilled"] as const)
    test(`Q1 R4 field value ${how}: ${how === "typed" ? "the person's own entry, mirrored into the value attribute as React does, is NOT reported (HF-14 control)" : "a value the page writes with no input from the person IS reported"}`, async ({
      context,
    }) => {
      const oracle = await installDisplayOracle(context, {
        markers: [R4_MARKER],
      });
      const { page, release } = await heldRecovery(context);
      // An existing text field that mirrors its value into the `value` attribute on every input event, as a React controlled input does.
      await page.evaluate(() => {
        const field = document.createElement("input");
        field.id = "r4-field";
        field.setAttribute("aria-label", "Username");
        field.addEventListener("input", () =>
          field.setAttribute("value", field.value),
        );
        document.body.append(field);
      });
      await oracle.mark(page, "field installed");
      expect(oracle.violations()).toEqual([]);
      if (how === "typed")
        await page.getByLabel("Username", { exact: true }).fill(R4_MARKER);
      else
        await page.evaluate(
          (m) => document.getElementById("r4-field")?.setAttribute("value", m),
          R4_MARKER,
        );
      expect(
        await page.evaluate(() =>
          document.getElementById("r4-field")?.getAttribute("value"),
        ),
      ).toBe(R4_MARKER);
      await oracle.mark(page, "after the value");
      if (how === "typed") {
        expect(await fencesOf(page)).toHaveLength(1);
        expect(oracle.violations()).toEqual([]);
      } else
        await expect
          .poll(() => oracle.violations().map((v) => v.kind), {
            timeout: 5_000,
          })
          .toEqual(["marker"]);
      await page.evaluate(() => document.getElementById("r4-field")?.remove());
      release();
      await displayed(page);
      if (how === "typed") await oracle.assertClean("R4 typed value");
    });

  test("Q1 R4 consumer markers: the vocabulary of the E-R/E-B/LR callers detects the account's verified name while fenced", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, {
      markers: [...FIXTURE_ACCOUNT_MARKERS],
    });
    expect(oracle.markers).toEqual(["alice"]);
    const { page, release } = await heldRecovery(context);
    await page.evaluate((name) => {
      const node = document.createElement("p");
      node.textContent = `Signed in as ${name}`;
      document.body.append(node);
      node.remove();
    }, FIXTURE_ACCOUNT_MARKERS[0] as string);
    await expect
      .poll(() => oracle.violations().map((v) => v.kind), { timeout: 5_000 })
      .toEqual(["marker"]);
    release();
    await displayed(page);
  });

  test("Q1 R4 coverage: a document that never enrolled and was REPLACED before the check is still missing", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, { markers: MARKERS });
    const page = await context.newPage();
    await page.goto("/__session?boot=off&oracle=off");
    await page.waitForFunction(() => window.__atlasData !== undefined);
    await page.goto("/__session?boot=off");
    await page.waitForFunction(() => window.__atlasData !== undefined);
    // The current document enrolled; the replaced one did not, and it is not forgotten.
    const coverage = await oracle.coverage();
    expect(coverage.loaded, JSON.stringify(coverage)).toBe(2);
    expect(coverage.missing, JSON.stringify(coverage)).toHaveLength(1);
    let failed = false;
    try {
      await oracle.assertClean("R4 replaced document");
    } catch {
      failed = true;
    }
    expect(
      failed,
      "assertClean must refuse a replaced unenrolled document",
    ).toBe(true);
  });

  test("Q1 R4 coverage: a violation of a page that CLOSED before the check stands", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, { markers: MARKERS });
    const page = await context.newPage();
    await page.goto("/__session?boot=off");
    await page.waitForFunction(() => window.__atlasData !== undefined);
    await page.evaluate((m) => {
      const node = document.createElement("div");
      node.textContent = m;
      document.body.append(node);
      node.remove();
    }, R4_MARKER);
    await expect
      .poll(() => oracle.violations().length, { timeout: 5_000 })
      .toBe(1);
    await page.close();
    let failed = false;
    try {
      await oracle.assertClean("R4 closed page");
    } catch {
      failed = true;
    }
    expect(failed, "a closed page's violation must survive").toBe(true);
  });
});
