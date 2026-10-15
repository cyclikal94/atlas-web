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

/**
 * WEB-08c revision 5 (R5-A/R5-B of the review of 14 October 2026; design assessment P1-P3, Q2, schedules S1-S17): native qualification of
 * the event-time recorder and the per-document ledger in Chromium, Firefox and macOS WebKit. Each DOM schedule is made in ONE synchronous
 * task while the production session's recovery read is HELD (the account fenced, the root inert and empty), so the recorder receives it as
 * one batch of records whose nodes have since moved; the violation is asserted BEFORE the release, with the fenced record, and the
 * recovery then completes. The review's own probes are here with their assertions: `nested-remove-text`, `nested-remove-attribute`,
 * `detached-title-no-marker` and the interrupted-document schedule (S10).
 */
const R5_MARKER = "oracle-marker-qualify";
const R5_EXPECTED = {
  // S1: nested subtrees dismantled in the task that inserted them (the review's probes) and their safe control.
  "nested-remove-text": ["marker"],
  "nested-remove-attribute": ["marker"],
  "nested-safe": [],
  // S2: topology variants (a node moved within the document is inserted again: a second exposure event).
  "siblings-first-last": ["marker"],
  "siblings-last-first": ["marker"],
  "ancestor-removed-then-edited": ["marker"],
  "moved-between-parents": ["marker", "marker"],
  "containing-subtree-replaced": ["marker"],
  "fragment-inserted-removed": ["marker"],
  "detached-only": [],
  "safe-move": [],
  // S3: title membership at each record (the review's refined probe has no configured marker).
  "detached-title-no-marker": ["title"],
  "title-element-replaced": ["title"],
  "title-text-moved-back": ["title"],
  "title-setter-control": ["title"],
  "neutral-title-control": [],
  // S5: the root and its episodes.
  "root-replaced-ungated": ["lift"],
  "root-replaced-gated": [],
  "remount-same-node": ["mount", "mount"],
  // S6: a field's value PROPERTY (no mutation record).
  "value-property": ["marker"],
} as const satisfies Record<string, readonly string[]>;
type R5Injection = keyof typeof R5_EXPECTED;
const injectR5 = (page: Page, kind: R5Injection, marker: string) =>
  page.evaluate(
    ({ k, m }) => {
      const body = document.body;
      const root = document.getElementById("protected-root") as HTMLElement;
      const el = (tag: string, text?: string) => {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        return node;
      };
      switch (k) {
        case "nested-remove-text":
        case "nested-remove-attribute":
        case "nested-safe": {
          const outer = el("div");
          const inner = el("span");
          const value = k === "nested-safe" ? "Safe" : m;
          if (k === "nested-remove-attribute")
            inner.setAttribute("aria-label", value);
          else inner.textContent = value;
          outer.append(inner);
          body.append(outer);
          outer.replaceChildren();
          outer.remove();
          break;
        }
        case "siblings-first-last":
        case "siblings-last-first": {
          const outer = el("div");
          const a = el("span", k === "siblings-last-first" ? m : "a");
          const b = el("span", k === "siblings-first-last" ? m : "b");
          outer.append(a, b);
          body.append(outer);
          if (k === "siblings-first-last") {
            a.remove();
            b.remove();
          } else {
            b.remove();
            a.remove();
          }
          outer.remove();
          break;
        }
        case "ancestor-removed-then-edited": {
          const outer = el("div");
          const inner = el("span", m);
          outer.append(inner);
          body.append(outer);
          outer.remove();
          (inner.firstChild as Text).data = "safe";
          break;
        }
        case "moved-between-parents": {
          const one = el("div");
          const two = el("div");
          const inner = el("span");
          inner.setAttribute("aria-label", m);
          one.append(inner);
          body.append(one, two);
          two.append(inner);
          inner.remove();
          one.remove();
          two.remove();
          break;
        }
        case "containing-subtree-replaced": {
          const holder = el("section");
          body.append(holder);
          const outer = el("div");
          const p = el("p");
          p.append(el("em", m));
          outer.append(p);
          holder.append(outer);
          const replacement = el("section");
          holder.replaceWith(replacement);
          replacement.remove();
          break;
        }
        case "fragment-inserted-removed": {
          const fragment = document.createDocumentFragment();
          const p = el("p", m);
          fragment.append(el("i"), p);
          body.append(fragment);
          p.remove();
          (body.lastChild as Element).remove();
          break;
        }
        case "detached-only": {
          const outer = el("div");
          outer.append(el("span", m));
          outer.replaceChildren();
          const holder = el("div");
          holder.append(outer);
          body.append(holder);
          holder.remove();
          break;
        }
        case "safe-move": {
          const one = el("div");
          const two = el("div");
          const inner = el("span", "safe");
          one.append(inner);
          body.append(one, two);
          two.append(inner);
          one.remove();
          two.remove();
          break;
        }
        case "detached-title-no-marker": {
          const title = document.querySelector("title") as HTMLTitleElement;
          const before = title.textContent ?? "";
          const text = document.createTextNode("Protected task details");
          title.replaceChildren(text);
          text.data = "Atlas";
          text.remove();
          title.textContent = before;
          break;
        }
        case "title-element-replaced": {
          const old = document.querySelector("title") as HTMLTitleElement;
          const protectedTitle = el("title", "Today · Atlas");
          old.replaceWith(protectedTitle);
          protectedTitle.replaceWith(old);
          break;
        }
        case "title-text-moved-back": {
          const title = document.querySelector("title") as HTMLTitleElement;
          const text = title.firstChild as Text;
          const before = text.data;
          const parking = el("div");
          document.head.append(parking);
          parking.append(text);
          text.data = "Today · Atlas";
          title.append(text);
          text.data = before;
          parking.remove();
          break;
        }
        case "title-setter-control": {
          const before = document.title;
          document.title = "Protected task details";
          document.title = before;
          break;
        }
        case "neutral-title-control": {
          const before = document.title;
          document.title = "Atlas";
          document.title = before;
          break;
        }
        case "root-replaced-ungated":
        case "root-replaced-gated": {
          const replacement = el("div");
          replacement.id = "protected-root";
          if (k === "root-replaced-gated") {
            replacement.setAttribute("inert", "");
            replacement.setAttribute("aria-hidden", "true");
          }
          root.replaceWith(replacement);
          // The original root goes back at once (the session's gate keeps its own reference).
          replacement.replaceWith(root);
          break;
        }
        case "remount-same-node": {
          const node = el("div");
          root.append(node);
          node.remove();
          root.append(node);
          node.remove();
          break;
        }
        case "value-property": {
          const input = el("input") as HTMLInputElement;
          body.append(input);
          input.value = m;
          input.value = "";
          input.remove();
          break;
        }
      }
      return {
        inert: root.hasAttribute("inert"),
        ariaHidden: root.getAttribute("aria-hidden"),
        children: root.childNodes.length,
        rootConnected: root.isConnected,
        title: document.title,
      };
    },
    { k: kind, m: marker },
  );

test.describe("Q1 (revision 5): every schedule is judged as the document was at each record (S1-S6)", () => {
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

  for (const kind of Object.keys(R5_EXPECTED) as R5Injection[]) {
    const expected: readonly string[] = R5_EXPECTED[kind];
    test(`Q1 R5 ${kind}: ${expected.length ? `reported as ${expected.join(",")} while fenced` : "control, nothing reported"}`, async ({
      context,
    }) => {
      const oracle = await installDisplayOracle(context, {
        markers: [R5_MARKER],
      });
      const { page, release } = await heldRecovery(context);
      await oracle.mark(page, "before the injection");
      expect(oracle.violations(), "precondition: nothing yet").toEqual([]);
      const after = await injectR5(page, kind, R5_MARKER);
      // The final DOM is safe: the account is fenced, the root inert, empty and in place, the title neutral.
      expect(after).toEqual({
        inert: true,
        ariaHidden: "true",
        children: 0,
        rootConnected: true,
        title: "Atlas (fixture)",
      });
      expect(await fencesOf(page)).toHaveLength(1);
      await oracle.mark(page, "after the injection");
      await expect
        .poll(() => oracle.violations().map((v) => v.kind), {
          timeout: 5_000,
        })
        .toEqual([...expected]);
      for (const v of oracle.violations()) {
        expect(v.record?.settled).toBe(ACCOUNT);
        expect(v.record?.fences[ACCOUNT] ?? 0).toBeGreaterThan(0);
      }
      release();
      await displayed(page);
      expect(await fencesOf(page)).toEqual([]);
      expect(oracle.violations().map((v) => v.kind)).toEqual([...expected]);
      const coverage = await oracle.coverage();
      expect(coverage.missing, JSON.stringify(coverage.documents)).toEqual([]);
      expect(coverage.incomplete).toEqual([]);
      if (expected.length === 0) await oracle.assertClean(`R5 ${kind}`);
    });
  }

  test("Q1 R5 S6 parser: a document's own static or inline title is judged by its value (no loading-state exemption)", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, {
      markers: [R5_MARKER],
    });
    await reviewDocs(context);
    const page = await context.newPage();
    await page.goto("/review-doc?neutral=1");
    expect(oracle.violations()).toEqual([]);
    await page.goto("/review-doc?static-title=1");
    await page.goto("/review-doc?inline-title=1");
    await expect
      .poll(
        () =>
          oracle
            .violations()
            .map((v) => [v.kind, v.detail.includes('title "Today · Atlas"')]),
        { timeout: 5_000 },
      )
      .toEqual([
        ["title", true],
        ["title", true],
      ]);
    // The second is the inline script's write through the setter; the first, the parser's static title (however the engine inserts it).
    expect(oracle.violations()[1]?.detail).toContain("(document.title)");
  });
});

/** Route-fulfilled documents (no application) for the ledger schedules: `slow` holds a stylesheet before a script (no DOMContentLoaded). */
async function reviewDocs(context: Parameters<typeof installDisplayOracle>[0]) {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route("**/review-block.css", async (route) => {
    await barrier;
    await route
      .fulfill({ body: "body{color:black}", contentType: "text/css" })
      .catch(() => undefined);
  });
  await context.route("**/review-doc**", (route) => {
    const url = new URL(route.request().url());
    const has = (name: string) => url.searchParams.has(name);
    const title = has("static-title") ? "Today · Atlas" : "Atlas";
    const head = [
      // WebKit ignores the charset of a route-fulfilled Content-Type header: the document declares it.
      '<meta charset="utf-8">',
      `<title>${title}</title>`,
      has("slow") ? '<link rel="stylesheet" href="/review-block.css">' : "",
      has("inline-title")
        ? '<script>document.title = "Today · Atlas"; document.title = "Atlas";</script>'
        : "",
    ].join("");
    // Two subframes: the same origin, and a cross-origin one (localhost for 127.0.0.1) that always gets a Window of its own.
    const cross = url.origin.replace("127.0.0.1", "localhost");
    const body = has("frame")
      ? `<iframe src="/review-doc?inner=1" title="inner"></iframe><iframe src="${cross}/review-doc?inner=2" title="cross"></iframe>`
      : "";
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head>${head}</head><body><script>window.ready = true</script><div id="protected-root" inert aria-hidden="true"></div>Safe${body}</body></html>`,
    });
  });
  await context.route("**/review-redirect", (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: new URL("/review-doc?redirected=1", route.request().url())
          .href,
      },
    }),
  );
  return { release };
}
const docOf = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __displayOracleDocument?: { doc: string } })
        .__displayOracleDocument?.doc ?? null,
  );
const refused = async (oracle: { assertClean(m?: string): Promise<void> }) => {
  try {
    await oracle.assertClean("expected refusal");
  } catch {
    return true;
  }
  return false;
};

test.describe("Q1 (revision 5): every document is accounted for by its own identity (S8-S17)", () => {
  test("S10 the review's schedule: an interrupted ENROLLED document cannot pay for a later loaded document with the recorder off", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context);
    const { release } = await reviewDocs(context);
    const page = await context.newPage();
    await page.goto("/review-doc?slow=1", { waitUntil: "commit" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            (window as unknown as { __displayOracle?: unknown })
              .__displayOracle,
          ),
        ),
      )
      .toBe(true);
    expect(await page.evaluate(() => document.readyState)).not.toBe("complete");
    const d1 = await docOf(page);
    await page.goto("/review-doc?oracle=off");
    release();
    expect(
      await page.evaluate(() =>
        Boolean(
          (window as unknown as { __displayOracle?: unknown }).__displayOracle,
        ),
      ),
    ).toBe(false);
    const d2 = await docOf(page);
    await page.goto("/review-doc?last=1");
    const d3 = await docOf(page);
    const coverage = await oracle.coverage();
    const outcome = (doc: string | null) =>
      coverage.documents.find((d) => d.doc === doc)?.outcome;
    expect(coverage.missing, JSON.stringify(coverage)).toHaveLength(1);
    expect(coverage.missing[0]).toContain(`document ${d2}`);
    expect(coverage.incomplete).toEqual([]);
    expect([outcome(d1), outcome(d2), outcome(d3)]).toEqual([
      "complete",
      "missing",
      "complete",
    ]);
    expect(await refused(oracle)).toBe(true);
    // Measured in this revision: Chromium and WebKit never load D1; Gecko fires DOMContentLoaded on the aborted document as it navigates
    // away, so in Firefox the schedule has no surplus to cross-subsidise (the next case reaches one in every engine).
    test.info().annotations.push({
      type: "interrupted document",
      description: `D1 loaded: ${coverage.documents.find((d) => d.doc === d1)?.loaded}`,
    });
  });
  test("S10 a still-loading CURRENT document (held stylesheet) cannot pay for an earlier loaded document with the recorder off", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context);
    const { release } = await reviewDocs(context);
    const page = await context.newPage();
    await page.goto("/review-doc?oracle=off");
    const missingDoc = await docOf(page);
    await page.goto("/review-doc?slow=1", { waitUntil: "commit" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            (window as unknown as { __displayOracle?: unknown })
              .__displayOracle,
          ),
        ),
      )
      .toBe(true);
    expect(await page.evaluate(() => document.readyState)).toBe("loading");
    const coverage = await oracle.coverage();
    release();
    // One load (the unenrolled document), one enrolled main document (the current one, still loading): equal totals, one missing.
    expect(coverage.loaded).toBe(1);
    expect(coverage.missing).toEqual([
      expect.stringContaining(`document ${missingDoc}`),
    ]);
    expect(coverage.incomplete).toEqual([]);
  });
  test("S10 controls: without the interrupted document the unenrolled one is missing; the interrupted document followed by a normal one is clean", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context);
    const { release } = await reviewDocs(context);
    const page = await context.newPage();
    await page.goto("/review-doc?oracle=off");
    await page.goto("/review-doc?last=1");
    expect((await oracle.coverage()).missing).toHaveLength(1);
    const healthy = await context.newPage();
    await healthy.goto("/review-doc?slow=1", { waitUntil: "commit" });
    await healthy.goto("/review-doc?last=2");
    release();
    const coverage = await oracle.coverage();
    // Only the first page's unenrolled document; the healthy page's interrupted and final documents are complete.
    expect(coverage.missing).toHaveLength(1);
    expect(coverage.incomplete).toEqual([]);
  });
  test("S11 identical URLs: one of three generations of the SAME URL without the recorder is identified; same-document navigation adds none", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context);
    await reviewDocs(context);
    const page = await context.newPage();
    await page.goto("/review-doc?same=1");
    await page.evaluate(() => {
      history.pushState({}, "", "/review-doc?same=1&pushed=1");
      location.hash = "x";
    });
    await page.goBack();
    expect(
      (await oracle.coverage()).documents.filter((d) => d.role === "main"),
    ).toHaveLength(1);
    await oracle.assertClean("same-document navigation");
    // The middle generation escapes the recorder through a seam that does not change the URL (window.name survives a reload).
    await page.evaluate(() => {
      window.name = "__display_oracle_off__";
    });
    await page.reload();
    expect(
      await page.evaluate(() =>
        Boolean(
          (window as unknown as { __displayOracle?: unknown }).__displayOracle,
        ),
      ),
    ).toBe(false);
    const middle = await docOf(page);
    await page.evaluate(() => {
      window.name = "";
    });
    await page.reload();
    const coverage = await oracle.coverage();
    expect(coverage.missing).toEqual([
      expect.stringContaining(`document ${middle}`),
    ]);
    expect(
      coverage.documents.filter((d) => d.role === "main").map((d) => d.url),
    ).toEqual(Array(3).fill(expect.stringContaining("/review-doc?same=1")));
  });
  test("S12 replacement: a document with neither witness nor recorder is missing; an application-driven replacement and a server redirect are each accounted for once", async ({
    context,
    browserName,
  }) => {
    const oracle = await installDisplayOracle(context);
    await reviewDocs(context);
    const page = await context.newPage();
    await page.goto("/review-doc?first=1");
    await Promise.all([
      page.waitForURL((u) => u.search.includes("replaced=1")),
      page.evaluate(() => location.replace("/review-doc?replaced=1")),
    ]);
    await page.waitForLoadState("domcontentloaded");
    if (browserName !== "webkit") {
      // WebKit does not complete a Playwright route-fulfilled 302 navigation (measured in this revision's diagnostics): not applicable there.
      await page.goto("/review-redirect");
      expect(page.url()).toContain("redirected=1");
    }
    let coverage = await oracle.coverage();
    expect(coverage.missing).toEqual([]);
    expect(coverage.incomplete).toEqual([]);
    expect(coverage.documents.filter((d) => d.role === "main")).toHaveLength(
      browserName === "webkit" ? 2 : 3,
    );
    await page.goto("/review-doc?oracle=off&witness=off");
    await page.goto("/review-doc?after=1");
    coverage = await oracle.coverage();
    expect(coverage.missing).toEqual([
      expect.stringContaining("loaded documents have no witness"),
    ]);
  });
  test("S13 closure: an unenrolled closed page is missing; a violating page whose report is LOST before it closes is incomplete; a clean closed page is complete", async ({
    context,
  }) => {
    let drop: string | null = null;
    const oracle = await installDisplayOracle(context, {
      markers: [R5_MARKER],
      transport: (r) =>
        r.binding === "oracle" && r.type === "violation" && r.doc === drop
          ? "drop"
          : "deliver",
    });
    await reviewDocs(context);
    const clean = await context.newPage();
    await clean.goto("/review-doc?clean=1");
    await clean.close();
    let coverage = await oracle.coverage();
    expect(coverage.documents.map((d) => [d.state, d.outcome])).toContainEqual([
      "retired",
      "complete",
    ]);
    await oracle.assertClean("a clean closed page");
    const lost = await context.newPage();
    await lost.goto("/review-doc?lost=1");
    drop = await docOf(lost);
    await lost.evaluate((m) => {
      const p = document.createElement("p");
      p.textContent = m;
      document.body.append(p);
      p.remove();
    }, R5_MARKER);
    await lost.close();
    coverage = await oracle.coverage();
    expect(coverage.violations).toEqual([]);
    expect(coverage.incomplete).toEqual([
      expect.stringContaining(`document ${drop} of page`),
    ]);
    expect(coverage.incomplete[0]).toContain(
      "1 of 2 reports were not delivered",
    );
    const unenrolled = await context.newPage();
    await unenrolled.goto("/review-doc?oracle=off");
    await unenrolled.close();
    coverage = await oracle.coverage();
    expect(coverage.missing).toHaveLength(1);
  });
  test("S13 immediate close: a violation made just before close() is either delivered or known lost, never clean", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, {
      markers: [R5_MARKER],
    });
    await reviewDocs(context);
    const page = await context.newPage();
    await page.goto("/review-doc?abrupt=1");
    await page.evaluate((m) => {
      const p = document.createElement("p");
      p.textContent = m;
      document.body.append(p);
      p.remove();
    }, R5_MARKER);
    await page.close();
    const coverage = await oracle.coverage();
    expect(
      coverage.violations.length + coverage.incomplete.length,
      JSON.stringify(coverage),
    ).toBeGreaterThan(0);
    expect(await refused(oracle)).toBe(true);
  });
  test("S14 transport: a report HELD until its document was replaced keeps its own document; a lost enrolment of a retired document is incomplete", async ({
    context,
  }) => {
    let hold: string | null = null;
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    let dropEnrolment = false;
    const oracle = await installDisplayOracle(context, {
      markers: [R5_MARKER],
      transport: async (r) => {
        if (
          r.binding === "oracle" &&
          r.type === "violation" &&
          r.doc === hold
        ) {
          await held;
          return "deliver";
        }
        if (dropEnrolment && r.binding === "oracle" && r.type === "enrolled")
          return "drop";
        return "deliver";
      },
    });
    await reviewDocs(context);
    const page = await context.newPage();
    await page.goto("/review-doc?old=1");
    hold = await docOf(page);
    await page.evaluate((m) => {
      const p = document.createElement("p");
      p.textContent = m;
      document.body.append(p);
      p.remove();
    }, R5_MARKER);
    dropEnrolment = true;
    await page.goto("/review-doc?new=1");
    const successor = await docOf(page);
    dropEnrolment = false;
    expect(oracle.violations()).toEqual([]);
    releaseHeld();
    await expect
      .poll(() => oracle.violations().map((v) => v.doc))
      .toEqual([hold]);
    await page.goto("/review-doc?third=1");
    const coverage = await oracle.coverage();
    expect(coverage.incomplete).toEqual([
      expect.stringContaining(`document ${successor} of page`),
    ]);
    expect(coverage.incomplete[0]).toContain(
      "enrolled but its enrolment report was not delivered",
    );
  });
  test("S15 finalisation: concurrent finalisers are serialised and agree; a reload and a new page during collection are accounted for", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context);
    await reviewDocs(context);
    const page = await context.newPage();
    await page.goto("/review-doc?one=1");
    const [a, b] = await Promise.all([oracle.coverage(), oracle.coverage()]);
    expect(a.documents).toEqual(b.documents);
    const [during] = await Promise.all([
      oracle.coverage(),
      page.reload(),
      context.newPage().then((p) => p.goto("/review-doc?two=1")),
    ]);
    // Whatever the concurrent collection saw is consistent (never a clean claim over a document it did not account for)...
    expect(during.missing).toEqual([]);
    for (const d of during.documents.filter((x) => x.role === "main"))
      expect(["complete", "incomplete"]).toContain(d.outcome);
    // ...and the next sealed collection accounts for all three documents.
    const after = await oracle.coverage();
    expect(after.documents.filter((d) => d.role === "main")).toHaveLength(3);
    await oracle.assertClean("after concurrent collection");
  });
  test("S15 successor: a predecessor's lost report is not acknowledged by its successor's answer in the same page", async ({
    context,
  }) => {
    let drop: string | null = null;
    const oracle = await installDisplayOracle(context, {
      markers: [R5_MARKER],
      transport: (r) =>
        r.binding === "oracle" && r.type === "violation" && r.doc === drop
          ? "drop"
          : "deliver",
    });
    await reviewDocs(context);
    const page = await context.newPage();
    await page.goto("/review-doc?predecessor=1");
    drop = await docOf(page);
    await page.evaluate((m) => {
      const p = document.createElement("p");
      p.textContent = m;
      document.body.append(p);
      p.remove();
    }, R5_MARKER);
    await page.goto("/review-doc?successor=1");
    const successor = await docOf(page);
    const coverage = await oracle.coverage();
    const states = Object.fromEntries(
      coverage.documents.map((d) => [d.doc, [d.state, d.outcome]]),
    );
    expect(states[successor as string]).toEqual(["open", "complete"]);
    expect(states[drop as string]).toEqual(["retired", "incomplete"]);
    expect(coverage.incomplete).toEqual([
      expect.stringContaining(`document ${drop} of page`),
    ]);
  });
  test("S16 inspection and bounds: an open page that cannot answer, and a recorder limit, are incomplete", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, {
      limits: { subtree: 3 },
    });
    await reviewDocs(context);
    const page = await context.newPage();
    await page.goto("/review-doc?inspect=1");
    await page.evaluate(() => {
      const outer = document.createElement("div");
      for (let i = 0; i < 5; i += 1) outer.append(document.createElement("i"));
      document.body.append(outer);
    });
    await page.evaluate(() => {
      (
        window as unknown as { __displayOracle: { flush: () => unknown } }
      ).__displayOracle.flush = () => {
        throw new Error("deliberately unanswerable");
      };
    });
    const coverage = await oracle.coverage();
    expect(coverage.incomplete).toEqual([
      expect.stringContaining("subtree over 3 nodes"),
      expect.stringContaining("could not be inspected"),
    ]);
  });
  test("S17 frames and blank documents: a subframe's enrolment cannot cover its page's unenrolled main document; a subframe's violation stands, or its unobserved document is incomplete", async ({
    context,
    browserName,
  }) => {
    const oracle = await installDisplayOracle(context, {
      markers: [R5_MARKER],
    });
    await reviewDocs(context);
    const blank = await context.newPage();
    expect(blank.url()).toBe("about:blank");
    const page = await context.newPage();
    await page.goto("/review-doc?frame=1&oracle=off");
    for (const title of ["inner", "cross"])
      await expect(
        page.frameLocator(`iframe[title="${title}"]`).locator("body"),
      ).toContainText("Safe");
    const frameOf = (part: string) =>
      page.frames().find((f) => f.url().includes(part));
    for (const part of ["inner=1", "inner=2"])
      await frameOf(part)?.evaluate((m) => {
        const p = document.createElement("p");
        p.textContent = m;
        document.body.append(p);
        p.remove();
      }, R5_MARKER);
    const crossDoc = await frameOf("inner=2")?.evaluate(
      () =>
        (window as unknown as { __displayOracleDocument?: { doc: string } })
          .__displayOracleDocument?.doc,
    );
    // The cross-origin frame has its own Window, witness and recorder in every engine: its violation is delivered.
    await expect
      .poll(() => oracle.violations().map((v) => v.doc))
      .toContain(crossDoc);
    const coverage = await oracle.coverage();
    expect(coverage.missing).toEqual([
      expect.stringContaining("/review-doc?frame=1&oracle=off) did not enrol"),
    ]);
    expect(
      coverage.documents
        .filter((d) => d.outcome === "not-required")
        .map((d) => d.role),
    ).toEqual(expect.arrayContaining(["blank", "sub"]));
    // The SAME-origin frame: either its violation is delivered, or (Firefox: the frame's first document reuses the initial about:blank
    // Window and no init script runs for it) its document is reported unobserved. Never clean.
    const sameOriginViolation = coverage.violations.some(
      (v) => v.doc !== crossDoc && v.kind === "marker",
    );
    const sameOriginUnobserved = coverage.incomplete.some((m) =>
      m.includes("review-doc?inner=1) is not observed"),
    );
    test.info().annotations.push({
      type: "same-origin subframe",
      description: `${browserName}: ${sameOriginViolation ? "violation delivered" : ""}${sameOriginUnobserved ? "document unobserved (incomplete)" : ""}`,
    });
    expect(sameOriginViolation || sameOriginUnobserved).toBe(true);
    expect(sameOriginViolation && sameOriginUnobserved).toBe(false);
    expect(await refused(oracle)).toBe(true);
  });
  test("S8 two tabs: another tab's committed clear never authorises this page; only this page's own completed read does", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, {
      markers: [R5_MARKER],
    });
    const { page: leader, release } = await heldRecovery(context);
    // A second page of the context with the gated shell and NO session: it reads `atlas-auth` only when the test makes it.
    const other = await context.newPage();
    await other.goto("/__session?boot=off");
    await other.waitForFunction(
      () => window.__atlasFixture?.session !== undefined,
    );
    release();
    await displayed(leader);
    expect(await fencesOf(leader)).toEqual([]);
    // The lift, with the record THIS page had committed at that moment (asserted in the same task: no race with a read of its own).
    const lift = () =>
      other.evaluate(() => {
        const oracle = (
          window as unknown as {
            __displayOracle: {
              state(): {
                record: {
                  settled: string | null;
                  fences: Record<string, number>;
                } | null;
              };
            };
          }
        ).__displayOracle;
        const record = oracle.state().record;
        const root = document.getElementById("protected-root") as HTMLElement;
        root.removeAttribute("inert");
        root.setAttribute("inert", "");
        return record;
      });
    const otherDoc = await docOf(other);
    const before = await lift();
    expect(
      before === null || (before.fences[ACCOUNT] ?? 0) > 0,
      `this page had committed no clear record: ${JSON.stringify(before)}`,
    ).toBe(true);
    await expect
      .poll(() => oracle.violations().map((v) => [v.doc, v.kind]))
      .toEqual([[otherDoc, "lift"]]);
    // Its own completed read of the (now clear) record authorises it.
    expect(await fencesOf(other)).toEqual([]);
    expect(await lift()).toMatchObject({ settled: ACCOUNT, fences: {} });
    await oracle.mark(other, "after the authorised lift");
    expect(oracle.violations()).toHaveLength(1);
    const log = await oracle.log(other);
    expect(log.some((e) => e.op === "episode.open")).toBe(true);
  });
  test("S9 helpers: the short-lived helper documents of seedAuth/arrange have their own complete evidence; an unenrolled helper is still missing", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context);
    const { page, release } = await heldRecovery(context);
    release();
    await displayed(page);
    let coverage = await oracle.coverage();
    const retired = coverage.documents.filter(
      (d) => d.role === "main" && d.state === "retired",
    );
    expect(retired.length).toBeGreaterThanOrEqual(2);
    for (const d of retired) expect(d.outcome).toBe("complete");
    expect(new Set(coverage.documents.map((d) => d.doc)).size).toBe(
      coverage.documents.length,
    );
    await oracle.assertClean("helpers");
    const helper = await context.newPage();
    await helper.goto("/__session?boot=off&oracle=off");
    await helper.waitForFunction(() => window.__atlasData !== undefined);
    await helper.close();
    coverage = await oracle.coverage();
    expect(coverage.missing).toHaveLength(1);
  });
});
