import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers";
import { navigate } from "./pwa-world";
import {
  armReload,
  type ReceiptPage,
  type ReloadReceipt,
  unsettled,
} from "./reload-receipt";

/**
 * WEB-14a revision 47 (F-R46-PWA-LOAD, family `pwa-reload-document-load-premise`; design assessment of 2 November 2026, Q2/Q3/Q6). The
 * reload receipt (tests/e2e/reload-receipt.ts) against REAL engines, with Playwright's ordinary trace recording (the project records every
 * test, `retain-on-failure`) and the console guard (any console warning or error fails the case: Firefox warns "Layout was forced before
 * the page was fully loaded" when a trace snapshot reads a document still parsing its head, the review r46 failure).
 *
 * No Atlas code is involved: a disposable loopback server serves complete HTML documents whose stylesheet the test can hold. A held
 * stylesheet followed by a parser-blocking script keeps a committed replacement at `readyState` "loading" with no body (the reviewer's
 * diagnostic technique, .agtx/evidence/review-r46-20261102/ordering-failure). Every document carries the production
 * `Cross-Origin-Opener-Policy: same-origin` header. Waits made while a document is held are made in Node (the server's own request log
 * and timers), never through the page: a page call there would itself be snapshotted.
 *
 * This is harness qualification, kept as a maintained regression of the helper; it is not product or integration evidence.
 */

/*
 * Every FIRST navigation of a fresh page goes through `navigate` (pwa-world): Playwright's Firefox can lose the report of a fresh page's
 * `goto` under the COOP header (revision 1, R9). The r47 driver's first control run hit exactly that with a plain `goto`
 * (.agtx/evidence/revision-r47-20261102, kept as a failed exploratory attempt).
 */

/** How long a held state is kept to show that nothing completes or inspects meanwhile (a host timer; not a product duration). */
const HELD_MS = 1_000;

interface Served {
  url: string;
  /** Requests received so far, in order (path with query). */
  log: string[];
  holdStyles(on: boolean): void;
  holdDocuments(on: boolean): void;
  /** Resolves when a request whose path+query matches has been received. */
  requested(match: RegExp): Promise<void>;
  close(): Promise<void>;
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const documentBody = (name: string, n: number, head = "") =>
  "<!doctype html><html><head><meta charset=utf-8><title>Receipt probe</title>" +
  // The comment pads the head so the parser commits and reports it before reaching the stylesheet (as in the reviewer's probe).
  `<!--${" ".repeat(4096)}-->${head}` +
  `<link rel=stylesheet href="/style.css?doc=${name}&n=${n}">` +
  "<script>window.parsedHead = true</script></head>" +
  `<body><main id=root data-doc="${name}" data-n="${n}">Ready</main>` +
  // An app-initiated reload, as the update coordinator makes one: asynchronous, after the click has returned.
  '<button id=reload type=button onclick="setTimeout(() => location.reload(), 50)">Reload</button>' +
  `${name === "framed" ? '<script>window.innerLoads = []; addEventListener("message", (e) => window.innerLoads.push(e.data))</script><iframe src="/inner" title=inner></iframe>' : ""}` +
  "</body></html>";

async function serve(): Promise<Served> {
  const log: string[] = [];
  const waiters: Array<{ match: RegExp; resolve: () => void }> = [];
  let styles = false;
  let documents = false;
  const heldStyles: ServerResponse[] = [];
  const heldDocuments: Array<() => void> = [];
  const counts = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    log.push(path);
    for (const waiter of [...waiters])
      if (waiter.match.test(path)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    const url = new URL(path, "http://probe.invalid");
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/style.css") {
      response.writeHead(200, {
        "content-type": "text/css",
        "cache-control": "no-store",
      });
      if (styles) heldStyles.push(response);
      else response.end("main{color:black}");
      return;
    }
    const name = url.pathname.slice(1) || "a";
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    // The second document of `/twice` (its first reload) starts a further reload of its own once it has reported itself.
    const head =
      name === "twice" && n === 2
        ? "<script>setTimeout(() => location.reload(), 200)</script>"
        : "";
    const send = () => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "cross-origin-opener-policy": "same-origin",
      });
      response.end(
        name === "inner"
          ? // The frame tells its (loaded) parent when it has loaded, so the test never has to ask a frame that is parsing.
            `<!doctype html><html><head><title>inner</title><script>addEventListener("load", () => parent.postMessage("inner-loaded:${n}", "*"))</script></head><body data-n="${n}">inner</body></html>`
          : documentBody(name, n, head),
      );
    };
    if (documents && name !== "inner") heldDocuments.push(send);
    else send();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    holdStyles: (on) => {
      styles = on;
      if (!on)
        for (const response of heldStyles.splice(0))
          response.end("main{color:black}");
    },
    holdDocuments: (on) => {
      documents = on;
      if (!on) for (const send of heldDocuments.splice(0)) send();
    },
    requested: (match) =>
      log.some((path) => match.test(path))
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ match, resolve })),
    close: async () => {
      for (const response of heldStyles.splice(0)) response.end("");
      for (const send of heldDocuments.splice(0)) send();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `page`, with every evaluation made through it recorded (the receipt must make none while a replacement is held). */
function recording(page: Page): { page: ReceiptPage; evaluations: number[] } {
  const evaluations: number[] = [];
  const wrapped = new Proxy(page, {
    get(target, property) {
      if (property === "evaluate")
        return (...args: Parameters<Page["evaluate"]>) => {
          evaluations.push(Date.now());
          return target.evaluate(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { page: wrapped as ReceiptPage, evaluations };
}

/** Problems on a page other than the guarded default one: the same rule (no console warning or error, no page error). */
function guard(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

const settledFlag = (promise: Promise<unknown>) => {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
};

let world: Served;
test.beforeEach(async () => {
  world = await serve();
});
test.afterEach(async ({ context }) => {
  expect(unsettled(context), "every receipt joined or cancelled").toEqual([]);
  // Pages go first: a server closing under a live page fails its requests.
  for (const page of context.pages()) await page.close().catch(() => undefined);
  await world.close();
});

test.describe("revision 47 (F-R46-PWA-LOAD): the reload receipt in real engines", () => {
  test("Q2: a replacement committed and held while parsing (its stylesheet held) is never inspected; the receipt completes only after its load", async ({
    page,
  }) => {
    await navigate(page, `${world.url}/a`);
    const watched = recording(page);
    world.holdStyles(true);
    const receipt = await armReload(watched.page);
    const armedReads = watched.evaluations.length;
    await page.click("#reload");
    const joined = receipt.loaded();
    const state = settledFlag(joined);
    // The replacement has committed and its parser reached the held stylesheet (Node-side evidence: the server received its request).
    await world.requested(/^\/style\.css\?doc=a&n=2$/);
    await pause(HELD_MS);
    expect(state.settled, "the join waits while the replacement parses").toBe(
      false,
    );
    expect(receipt.machine.state.kind).toBe("started");
    expect(
      watched.evaluations.length,
      "no evaluation while the replacement is held",
    ).toBe(armedReads);
    world.holdStyles(false);
    const seen = await joined;
    expect(watched.evaluations.length, "one read, after the load").toBe(
      armedReads + 1,
    );
    expect(seen.history.map((entry) => entry.event.split(" ")[0])).toEqual([
      "armed",
      "start",
      "load",
      "joined",
    ]);
    expect(
      await page.evaluate(() => ({
        readyState: document.readyState,
        body: document.body !== null,
        n: document.getElementById("root")?.dataset.n,
      })),
    ).toEqual({ readyState: "complete", body: true, n: "2" });
  });

  test("a load that completed before the join is kept (late join), and the join is immediate", async ({
    page,
  }) => {
    await navigate(page, `${world.url}/a`);
    const watched = recording(page);
    const receipt = await armReload(watched.page);
    const armedReads = watched.evaluations.length;
    await page.click("#reload");
    await expect
      .poll(() => receipt.machine.state.kind, { intervals: [50] })
      .toBe("loaded");
    expect(watched.evaluations.length).toBe(armedReads);
    // Bounds of 1 ms: the join must not wait at all for a load it already holds.
    expect(
      await receipt.loaded({ start: 1, load: 1 }).then(
        (seen) => seen.href,
        (error: Error) => error.message,
      ),
      "the join keeps the load that came before it",
    ).toBe(`${world.url}/a`);
    expect(watched.evaluations.length).toBe(armedReads + 1);
  });

  test("supersession: a second document starting before the join fails the receipt", async ({
    page,
  }) => {
    await navigate(page, `${world.url}/twice`);
    const receipt = await armReload(page);
    const loads: number[] = [];
    page.on("load", () => loads.push(Date.now()));
    await page.click("#reload");
    // Its first replacement reloads again: wait (in Node) until the third document has loaded before joining.
    await world.requested(/^\/style\.css\?doc=twice&n=3$/);
    await expect.poll(() => loads.length, { intervals: [50] }).toBe(2);
    await expect(receipt.loaded()).rejects.toThrow(
      /^reload receipt: superseded: another document started after /,
    );
  });

  test("a same-document navigation and a frame's own reload never complete it", async ({
    page,
  }) => {
    await navigate(page, `${world.url}/framed`);
    await expect(page.frameLocator("iframe").locator("body")).toHaveText(
      "inner",
    );
    const receipt = await armReload(page);
    await page.evaluate(() => {
      history.pushState({}, "", "#elsewhere");
    });
    const frame = page.frames().find((f) => f !== page.mainFrame());
    expect(frame).toBeDefined();
    const before = world.log.filter((path) => path === "/inner").length;
    await frame?.evaluate(() => location.reload());
    // In Node: the frame's second document was requested; then the (loaded) parent says that it loaded.
    await expect
      .poll(() => world.log.filter((path) => path === "/inner").length, {
        intervals: [50],
      })
      .toBe(before + 1);
    await pause(HELD_MS);
    expect(
      await page.evaluate(
        () => (window as unknown as { innerLoads: string[] }).innerLoads,
      ),
    ).toEqual(["inner-loaded:1", "inner-loaded:2"]);
    expect(
      receipt.machine.state.kind,
      "a same-document navigation and a frame's reload leave the receipt armed",
    ).toBe("armed");
    expect(
      receipt.machine.history.some((entry) =>
        entry.event.startsWith("ignored a frame's start"),
      ),
      receipt.machine.describe(),
    ).toBe(true);
    await expect(receipt.loaded({ start: 1_000 })).rejects.toThrow(
      /no new document started within 1000 ms of the join/,
    );
  });

  test("another page's reload never completes it", async ({
    page,
    context,
  }) => {
    await navigate(page, `${world.url}/a`);
    const peer = await context.newPage();
    const peerProblems = guard(peer);
    await navigate(peer, `${world.url}/a`);
    const receipt = await armReload(page);
    const peerReceipt: ReloadReceipt = await armReload(peer);
    await peer.reload();
    expect(
      await peerReceipt.loaded({ start: 1, load: 1 }).then(
        (seen) => seen.href,
        (error: Error) => error.message,
      ),
      "the peer's own receipt completes on its reload",
    ).toBe(`${world.url}/a`);
    expect(
      receipt.machine.state.kind,
      "the other page's reload leaves this page's receipt armed",
    ).toBe("armed");
    receipt.cancel();
    expect(peerProblems).toEqual([]);
  });

  test("the page closing fails a waiting join", async ({ context }) => {
    const other = await context.newPage();
    const problems = guard(other);
    await navigate(other, `${world.url}/a`);
    const receipt = await armReload(other);
    // The expectation is attached before the close, which rejects the join while `close()` is still being awaited.
    const joined = expect(receipt.loaded()).rejects.toThrow(
      /^reload receipt: the page closed/,
    );
    await other.close();
    await joined;
    expect(problems).toEqual([]);
  });

  test("Q6: a direct awaited reload (`page.reload`) waits for the held replacement's load", async ({
    page,
  }) => {
    await navigate(page, `${world.url}/a`);
    world.holdStyles(true);
    const reloaded = page.reload();
    const state = settledFlag(reloaded);
    await world.requested(/^\/style\.css\?doc=a&n=2$/);
    await pause(HELD_MS);
    expect(state.settled).toBe(false);
    world.holdStyles(false);
    await reloaded;
    expect(await page.evaluate(() => document.readyState)).toBe("complete");
  });

  test("Q6: a popup's first load (window.open) is what the load wait of `displayed` waits for", async ({
    page,
    context,
  }) => {
    await navigate(page, `${world.url}/a`);
    world.holdStyles(true);
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      page.evaluate(() => {
        window.open("/popup");
      }),
    ]);
    const problems = guard(popup);
    const loaded = popup.waitForLoadState("load");
    const state = settledFlag(loaded);
    await world.requested(/^\/style\.css\?doc=popup&n=1$/);
    await pause(HELD_MS);
    expect(state.settled, "not the popup's initial blank document").toBe(false);
    world.holdStyles(false);
    await loaded;
    expect(
      await popup.evaluate(() => ({
        readyState: document.readyState,
        body: document.body !== null,
      })),
    ).toEqual({ readyState: "complete", body: true });
    expect(problems).toEqual([]);
  });

  test("Q6: a fresh page's first navigation (`navigate`: Firefox's self-made navigation under production COOP) does not inspect the document before it loads", async ({
    context,
  }) => {
    const fresh = await context.newPage();
    const problems = guard(fresh);
    world.holdDocuments(true);
    world.holdStyles(true);
    const navigated = navigate(fresh, `${world.url}/first`);
    const state = settledFlag(navigated);
    await world.requested(/^\/first$/);
    await pause(300);
    // The document is answered; its stylesheet stays held: committed, parsing, no body.
    world.holdDocuments(false);
    await world.requested(/^\/style\.css\?doc=first&n=1$/);
    await pause(HELD_MS);
    expect(state.settled).toBe(false);
    world.holdStyles(false);
    await navigated;
    expect(
      await fresh.evaluate(() => ({
        readyState: document.readyState,
        body: document.body !== null,
      })),
    ).toEqual({ readyState: "complete", body: true });
    expect(problems).toEqual([]);
  });
});
