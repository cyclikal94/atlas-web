// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  CurrentRead,
  CurrentReadIo,
  DraftWithCommand,
  EnqueueRequest,
} from "../../../src/data";
import { unorderedPersistence } from "../../../src/data/engine/account-service";
import { createCommandRegistry } from "../../../src/data/outbox/registries";
import { createDataEnv } from "../../../src/data/ui/env";
import { exclude, record } from "../../../src/features/tasks/model/commands";
import {
  registerTaskCommands,
  taskCommandSpecs,
} from "../../../src/features/tasks/register";
import { StampedRequestError } from "../../../src/session";
import { outboxWorld } from "../../support/data/outbox-world";
import { ACCOUNT, pageWorld } from "../../support/data/page-world";
import { cacheRow, draftRow } from "../../support/data/rows";
import { ME } from "../../support/data/sharing";

/**
 * R19 (review 7 of 15 October 2026, family `task-conflict-rebuild-command-contract`): the authorised current read of a progress-level
 * kind (`record`, `exclude`) looks for my stream in `GET /progress?parent_id=<occurrence>`, a PAGED collection. The released endpoint
 * (v0.28.0-rc.1, `list` + `Store::resources`) orders the occurrence's visible streams by id, answers at most `limit` (200) after `after`,
 * and names the last id of a FULL page as `next_after` (a page that is not full ends with `null`). `endpoint` below answers exactly so.
 * Design assessment P1-P8: the stream on any page is found (and nothing after it is asked for); absence only on a page that ends the
 * collection; a later refusal/error/malformed page is never absence; a cursor that is missing, repeats or goes back stops the walk; a scope
 * that ended sends nothing more; the reviewed later-page version is the replacement's base.
 */
const OCC = "70000000-0000-4000-8000-000000000013";
const OWN = "70000000-0000-4000-8000-000000000014";
const LIMIT = 200;
/** `n` other streams, every id below OWN's (they come first in the endpoint's order). */
const others = (n: number, from = 1) =>
  Array.from(
    { length: n },
    (_, i) =>
      `60000000-0000-4000-8000-${(from + i).toString(16).padStart(12, "0")}`,
  );
const projection = (id: string, version = 7) => ({
  id,
  kind: "progress",
  parent_id: OCC,
  label: "Progress",
  value: {},
  version,
  can_edit: true,
});
const pageOf = (ids: string[], next: string | null) => ({
  items: ids.map((id) => projection(id)),
  next_after: next,
});
/** The released endpoint's page for `after`: ids in byte order after it, at most 200, the last id as the cursor of a full page. */
function endpoint(ids: string[], after: string | null) {
  const items = [...ids]
    .sort()
    .filter((id) => after === null || id > after)
    .slice(0, LIMIT);
  return pageOf(
    items,
    items.length === LIMIT ? (items.at(-1) as string) : null,
  );
}
const pathOf = (after: string | null) =>
  `/progress?parent_id=${OCC}&limit=200${after === null ? "" : `&after=${after}`}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const afterOf = (path: string) =>
  new URL(path, "http://localhost").searchParams.get("after");

const VARIANTS = ["record-primary", "record-side-effect", "exclude"] as const;
type Variant = (typeof VARIANTS)[number];
/** The queued command of `variant`, as the outbox stores it: the builder's primaries are the targets, its side effects carry bases. */
function draftOf(variant: Variant): DraftWithCommand {
  const request: EnqueueRequest =
    variant === "exclude"
      ? exclude({ occurrenceId: OCC, progressId: OWN, excluded: true })
      : record({
          occurrenceId: OCC,
          progressId: OWN,
          me: ME,
          entryId: "70000000-0000-4000-8000-000000000015",
          evidence:
            variant === "record-side-effect"
              ? { kind: "quantity", amount: "2" }
              : { kind: "checkbox", complete: true },
          happenedAt: 1_700_000_000,
          replaces: null,
          firstAnyoneStream: false,
          defaults: null,
        });
  const bases = { [OWN]: 3, [OCC]: 1 };
  return draftRow({
    kind: variant === "exclude" ? "exclude" : "record",
    status: "version_conflict",
    command: request.build(bases).command as DraftWithCommand["command"],
    target_resource_ids: request.targets
      .filter((t) => t.role === "primary")
      .map((t) => t.resourceId),
    side_effect_bases: Object.fromEntries(
      request.targets
        .filter((t) => t.role === "side_effect")
        .map((t) => [t.resourceId, 3]),
    ),
  });
}

const registry = createCommandRegistry();
registerTaskCommands(registry);

/** Reads through the production registration with `answer` per request; records every path asked for. */
async function readWith(
  variant: Variant,
  answer: (path: string, n: number) => Response | Promise<Response>,
  signal: AbortSignal = new AbortController().signal,
) {
  const asked: string[] = [];
  const io: CurrentReadIo = {
    signal,
    get: async (path) => {
      asked.push(path);
      // A bound of the TEST's own (a walk that never ends would starve the event loop): the eleventh request is refused, so an
      // unbounded walk ends as an assertion failure, not a hang.
      if (asked.length > 10) throw new Error("the walk did not stop");
      return answer(path, asked.length);
    },
  };
  const read = await registry.readCurrent(draftOf(variant), io);
  return { read, asked };
}
const serving = (ids: string[]) => (path: string) =>
  json(endpoint(ids, afterOf(path)));

describe("R19 (P1): my stream is found on whichever page holds it, and nothing after it is asked for", () => {
  test("both registrations use the one paged reader", () => {
    const specs = taskCommandSpecs();
    expect(specs.record?.readCurrent).toBeDefined();
    expect(specs.exclude?.readCurrent).toBe(specs.record?.readCurrent);
  });

  for (const variant of VARIANTS)
    for (const [where, before] of [
      ["first", 0],
      ["second", 200],
      ["third", 400],
    ] as const)
      test(`${variant}: on the ${where} page, after ${before} other streams`, async () => {
        const ids = [
          ...others(before),
          OWN,
          ...others(30, 5000).map((id) => id.replace(/^6/, "8")),
        ];
        const { read, asked } = await readWith(variant, serving(ids));
        expect(read).toMatchObject({
          kind: "loaded",
          value: { id: OWN, kind: "progress", version: 7 },
        });
        const cursors = [
          null,
          ...[200, 400]
            .filter((n) => n <= before)
            .map((n) => others(before)[n - 1] as string),
        ];
        expect(asked).toEqual(cursors.map(pathOf));
      });
});

describe("R19 (P2): absent only once a valid page ends the collection", () => {
  for (const variant of VARIANTS) {
    test(`${variant}: after two full pages and a short last page: inaccessible, three requests`, async () => {
      const ids = others(450);
      const { read, asked } = await readWith(variant, serving(ids));
      expect(read).toEqual({ kind: "failed", reason: "inaccessible" });
      expect(asked).toEqual(
        [null, ids[199], ids[399]].map((a) => pathOf(a ?? null)),
      );
    });

    test(`${variant}: exactly 400 streams (two full pages, then an EMPTY last page): inaccessible, nothing after the empty page`, async () => {
      const ids = others(400);
      const { read, asked } = await readWith(variant, serving(ids));
      expect(read).toEqual({ kind: "failed", reason: "inaccessible" });
      expect(asked).toHaveLength(3);
      expect(afterOf(asked[2] as string)).toBe(ids[399]);
    });

    test(`${variant} control: mine is the LAST row of a full page, then nothing more is asked for`, async () => {
      const ids = [...others(399), OWN];
      const { read, asked } = await readWith(variant, serving(ids));
      expect(read).toMatchObject({ kind: "loaded", value: { id: OWN } });
      expect(asked).toHaveLength(2);
    });

    test(`${variant} control: a collection of mine alone: one request`, async () => {
      const { read, asked } = await readWith(variant, serving([OWN]));
      expect(read).toMatchObject({ kind: "loaded", value: { id: OWN } });
      expect(asked).toEqual([pathOf(null)]);
    });
  }
});

describe("R19 (P3): a later page's refusal or failure is that page's answer, never absence from the part walked", () => {
  const ids = [...others(200), OWN];
  const firstThen =
    (later: () => Response | Promise<Response>) => (path: string) =>
      afterOf(path) === null ? json(endpoint(ids, null)) : later();

  test("control: the same later page, answered, is loaded", async () => {
    const { read, asked } = await readWith(
      "record-primary",
      firstThen(() => json(endpoint(ids, ids[199] as string))),
    );
    expect(read).toMatchObject({ kind: "loaded", value: { id: OWN } });
    expect(asked).toHaveLength(2);
  });

  for (const variant of VARIANTS) {
    for (const status of [403, 404, 410])
      test(`${variant}: the later page is refused ${status}: inaccessible as a refusal of the collection, nothing more asked`, async () => {
        const { read, asked } = await readWith(
          variant,
          firstThen(() => json({ code: "forbidden" }, status)),
        );
        expect(read).toEqual({ kind: "failed", reason: "inaccessible" });
        expect(asked).toHaveLength(2);
      });
    for (const status of [401, 429, 500, 503])
      test(`${variant}: the later page answers ${status}: error, never inaccessible`, async () => {
        const { read, asked } = await readWith(
          variant,
          firstThen(() => json({ code: "x" }, status)),
        );
        expect(read).toEqual({ kind: "failed", reason: "error" });
        expect(asked).toHaveLength(2);
      });
    test(`${variant}: the later request is rejected (network, a refused session): error`, async () => {
      const { read, asked } = await readWith(
        variant,
        firstThen(() => Promise.reject(new TypeError("network"))),
      );
      expect(read).toEqual({ kind: "failed", reason: "error" });
      expect(asked).toHaveLength(2);
    });
    test(`${variant}: the later page is not JSON: indeterminate, never inaccessible`, async () => {
      const { read } = await readWith(
        variant,
        firstThen(() => new Response("<html>", { status: 200 })),
      );
      expect(read).toEqual({ kind: "indeterminate" });
    });
  }
});

describe("R19 (P4): a page that is not one of this collection stops the walk (indeterminate), never absence, never a loop", () => {
  const first = others(200);
  const last = first[199] as string;
  const cases: Array<[string, (path: string) => Response]> = [
    [
      "a full page with no cursor (missing-cursor-as-terminal)",
      () => json(pageOf(first, null)),
    ],
    [
      "a page without next_after at all",
      () => json({ items: pageOf(first, null).items }),
    ],
    ["a cursor that is not an id", () => json(pageOf(first, "not-a-uuid"))],
    [
      "a cursor that points back into the page",
      () => json(pageOf(first, first[100] as string)),
    ],
    [
      "a short page that has a cursor",
      () => json(pageOf(first.slice(0, 199), first[198] as string)),
    ],
    ["an empty page that has a cursor", () => json(pageOf([], last))],
    [
      "projections out of the endpoint's order",
      () => json(pageOf([...first].reverse(), first[0] as string)),
    ],
    [
      "a projection of another kind",
      () =>
        json({
          ...pageOf(first.slice(0, 5), null),
          items: [{ ...projection(OWN), kind: "task" }],
        }),
    ],
    [
      "a projection of another occurrence",
      () =>
        json({
          items: [
            {
              ...projection(OWN),
              parent_id: "70000000-0000-4000-8000-000000000099",
            },
          ],
          next_after: null,
        }),
    ],
    [
      "an envelope with another member",
      () => json({ ...pageOf([OWN], null), revision: 4 }),
    ],
    [
      "more projections than the limit",
      () => json(pageOf(others(201), others(201)[200] as string)),
    ],
    [
      "the SAME page again for the cursor (a repeated cursor)",
      () => json(pageOf(first, last)),
    ],
    [
      "a later page that goes back before the cursor",
      (path) =>
        afterOf(path) === null
          ? json(pageOf(first, last))
          : json(pageOf(others(200, 50), others(200, 50)[199] as string)),
    ],
  ];
  for (const variant of VARIANTS)
    for (const [name, answer] of cases)
      test(`${variant}: ${name}`, async () => {
        const { read, asked } = await readWith(variant, answer);
        expect(read).toEqual({ kind: "indeterminate" });
        expect(asked.length).toBeLessThanOrEqual(2);
      });

  test("control: a valid advancing cursor is followed", async () => {
    const { read, asked } = await readWith("record-primary", (path) =>
      afterOf(path) === null
        ? json(pageOf(first, last))
        : json(pageOf([OWN], null)),
    );
    expect(read).toMatchObject({ kind: "loaded", value: { id: OWN } });
    expect(asked).toEqual([pathOf(null), pathOf(last)]);
  });
});

/** An answer whose body is held (and ignores any abort) until `release`. */
function held(body: unknown) {
  const response = new Response("{}", { status: 200 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = { decoding: false };
  response.json = async () => {
    seen.decoding = true;
    await gate;
    return body;
  };
  return { response, release, seen };
}
async function until(done: () => boolean) {
  for (let i = 0; i < 50 && !done(); i += 1) await Promise.resolve();
  if (!done()) throw new Error("setup: the read never reached its decode");
}

describe("R19 (P5): a scope that ended sends nothing more and answers nothing", () => {
  const ids = [...others(450), OWN];
  test("aborted before the first page: unavailable, no request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { read, asked } = await readWith(
      "record-primary",
      serving(ids),
      controller.signal,
    );
    expect(read).toEqual({ kind: "failed", reason: "unavailable" });
    expect(asked).toEqual([]);
  });

  for (const page of [1, 2])
    test(`aborted while page ${page}'s body is held (the body ignores the abort): unavailable, no page ${page + 1}`, async () => {
      const controller = new AbortController();
      const hold = held(
        endpoint(ids, page === 1 ? null : (ids[199] as string)),
      );
      const pending = readWith(
        "exclude",
        (path, n) => (n === page ? hold.response : serving(ids)(path)),
        controller.signal,
      );
      await until(() => hold.seen.decoding);
      controller.abort();
      hold.release();
      const { read, asked } = await pending;
      expect(read).toEqual({ kind: "failed", reason: "unavailable" });
      expect(asked).toHaveLength(page);
    });

  test("aborted while the page that HOLDS mine is held: unavailable, never a loaded answer after the scope ended", async () => {
    const controller = new AbortController();
    const hold = held(endpoint(ids, ids[399] as string));
    const pending = readWith(
      "record-side-effect",
      (path, n) => (n === 3 ? hold.response : serving(ids)(path)),
      controller.signal,
    );
    await until(() => hold.seen.decoding);
    controller.abort();
    hold.release();
    const { read, asked } = await pending;
    expect(read).toEqual({ kind: "failed", reason: "unavailable" });
    expect(asked).toHaveLength(3);
  });

  test("control: the same held page released without an abort walks on to my stream", async () => {
    const hold = held(endpoint(ids, ids[199] as string));
    const pending = readWith("exclude", (path, n) =>
      n === 2 ? hold.response : serving(ids)(path),
    );
    await until(() => hold.seen.decoding);
    hold.release();
    const { read, asked } = await pending;
    expect(read).toMatchObject({ kind: "loaded", value: { id: OWN } });
    expect(asked).toHaveLength(3);
  });
});

// ---- P8: the reviewed later-page version is the replacement's base, through the production outbox ---------------------------------

describe("R19 (P8): the version read from a later page is what the replacement is based on", () => {
  for (const variant of VARIANTS)
    test(`${variant}: reviewed at 7 on page two; the replacement is sent on 7 in its own role, with a new identity`, async () => {
      const w = await outboxWorld();
      w.put("cache", [
        cacheRow({ id: OCC, kind: "occurrence", version: 1 }),
        cacheRow({ id: OWN, kind: "progress", version: 3 }),
      ]);
      w.start();
      await w.settle();
      const original = draftOf(variant);
      const request: EnqueueRequest =
        variant === "exclude"
          ? exclude({ occurrenceId: OCC, progressId: OWN, excluded: true })
          : record({
              occurrenceId: OCC,
              progressId: OWN,
              me: ME,
              entryId: crypto.randomUUID(),
              evidence: (original.command as { command: { evidence: never } })
                .command.evidence,
              happenedAt: 1_700_000_000,
              replaces: null,
              firstAnyoneStream: false,
              defaults: null,
            });
      w.script.push(
        w.error(
          409,
          variant === "record-side-effect" ? "operation_conflict" : "conflict",
        ),
      );
      const out = await w.outbox.enqueue(request);
      if (out.kind !== "queued") throw new Error(`setup: ${out.kind}`);
      await w.settle();
      const header = w.drafts().find((d) => d.local_id === out.localId);
      if (header === undefined) throw new Error("setup: no draft");
      const stored = {
        ...header,
        command: w.commandOf(out.localId),
      } as DraftWithCommand;
      const asked: string[] = [];
      const read = await registry.readCurrent(stored, {
        signal: new AbortController().signal,
        get: async (path) => {
          asked.push(path);
          return json(endpoint([...others(200), OWN], afterOf(path)));
        },
      });
      expect(asked).toHaveLength(2);
      expect(read.kind).toBe("loaded");
      if (read.kind !== "loaded") return;
      const rebuilt = registry.rebuild(stored, read.value);
      expect(rebuilt).not.toBeNull();
      if (rebuilt === null) return;
      expect(rebuilt.targets.find((t) => t.resourceId === OWN)).toMatchObject({
        role: variant === "record-side-effect" ? "side_effect" : "primary",
        reviewedBase: 7,
      });
      const superseded = await w.outbox.supersede(out.localId, rebuilt);
      expect(superseded.kind).toBe("superseded");
      await w.settle();
      const sent = w.sent.map(
        (s) =>
          (JSON.parse(s.body) as { command: Record<string, unknown> }).command,
      );
      expect(sent).toHaveLength(2);
      if (variant === "record-side-effect")
        expect(sent[1]).not.toHaveProperty("expected_version");
      else expect(sent[1]?.expected_version).toBe(7);
      if (variant !== "exclude")
        expect(sent[1]?.entry_id).not.toBe(sent[0]?.entry_id);
      expect(
        w.versions().find((v) => v.resource_id === OWN)
          ?.locally_assumed_version,
      ).toBe(8);
    });
});

// ---- P5-P7 composed: the production controller seals the WHOLE walk ------------------------------------------------------------------

const LOCAL = "4e219b0a-0000-4000-8000-000000000019";

async function composed(ids: string[]) {
  const w = await pageWorld({ cursor: "d1", phase: "delta" });
  const draft = draftOf("record-primary");
  w.put("drafts", [{ ...draft, local_id: LOCAL }]);
  const commands = createCommandRegistry();
  registerTaskCommands(commands);
  const runtime = new w.env.modules.accountService.DataRuntime({
    identity: w.identity,
    persistence: unorderedPersistence,
    registry: w.page.registry,
    open: (account, openOptions) => w.page.open(account, openOptions),
  });
  const requests: Array<{
    account: string;
    epoch: number;
    after: string | null;
  }> = [];
  /** `holds[n]`: the n-th request's body is held (1-based). */
  const holds = new Map<number, ReturnType<typeof held>>();
  const durable = { account: ACCOUNT as string | null, epoch: 1 };
  const ui = createDataEnv({
    identity: w.identity,
    loadRuntime: async () => runtime,
    online: { get: () => true, subscribe: () => () => undefined },
    quota: { check: async () => "admit" } as never,
    ids: { uuid: () => crypto.randomUUID() },
    clock: { now: () => Date.now(), iso: () => new Date().toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "closed" }),
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: () => () => undefined,
    commands,
    fetchOrdinary:
      (account: string, epoch: number) => async (request: Request) => {
        const after = new URL(request.url).searchParams.get("after");
        requests.push({ account, epoch, after });
        const hold = holds.get(requests.length);
        return hold?.response ?? json(endpoint(ids, after));
      },
    apiUrl: (path: string) =>
      new URL(`http://localhost/api/experimental/v1${path}`),
    seal: async <T>(account: string, epoch: number, pending: Promise<T>) => {
      const value = await pending;
      if (durable.account !== account || durable.epoch !== epoch)
        throw new StampedRequestError("stale");
      return value;
    },
  });
  await w.env.settle();
  for (let i = 0; i < 20 && ui.service() === null; i += 1) await w.env.settle();
  if (ui.service() === null) throw new Error("setup: no database");
  const holdAt = (n: number) => {
    const after =
      n === 1 ? null : ([...ids].sort()[LIMIT * (n - 1) - 1] as string);
    const h = held(endpoint(ids, after));
    holds.set(n, h);
    return h;
  };
  const reached = async (h: ReturnType<typeof held>) => {
    for (let i = 0; i < 60 && !h.seen.decoding; i += 1) await w.env.settle();
    if (!h.seen.decoding)
      throw new Error("setup: the walk never reached the held page");
  };
  return { w, ui, requests, durable, holdAt, reached };
}

describe("R19 (P5-P7) through the production controller: every page in the call's scope, the whole walk sealed", () => {
  const ids = [...others(450), OWN];

  test("control: three stamped requests of the displayed account and epoch, then the exact server projection", async () => {
    const t = await composed(ids);
    const read: CurrentRead = await t.ui.actions.readCurrent(LOCAL);
    expect(read).toMatchObject({
      kind: "loaded",
      value: { id: OWN, version: 7 },
    });
    expect(t.requests).toEqual([
      { account: ACCOUNT, epoch: 1, after: null },
      { account: ACCOUNT, epoch: 1, after: ids[199] },
      { account: ACCOUNT, epoch: 1, after: ids[399] },
    ]);
    t.ui.dispose();
  });

  test("P6: page two is held, ANOTHER page settles epoch 2 and this page hears nothing: refused at the record, no page three", async () => {
    const t = await composed(ids);
    const h = t.holdAt(2);
    const pending = t.ui.actions.readCurrent(LOCAL);
    await t.reached(h);
    t.durable.epoch = 2;
    expect(t.w.identity.get()?.epoch).toBe(1);
    h.release();
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    t.ui.dispose();
  });

  test("P6: an absence proved under the old epoch is not handed back either (unavailable, not inaccessible)", async () => {
    const t = await composed(others(450));
    const h = t.holdAt(3);
    const pending = t.ui.actions.readCurrent(LOCAL);
    await t.reached(h);
    t.durable.account = "other-account";
    h.release();
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    t.ui.dispose();
  });

  test("P5: the caller cancels while page two is held: unavailable, no page three; a sibling call with its own signal walks to mine", async () => {
    const t = await composed(ids);
    const h = t.holdAt(2);
    const cancelled = new AbortController();
    const pending = t.ui.actions.readCurrent(LOCAL, cancelled.signal);
    await t.reached(h);
    cancelled.abort();
    h.release();
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    expect(t.requests).toHaveLength(2);
    expect(
      await t.ui.actions.readCurrent(LOCAL, new AbortController().signal),
    ).toMatchObject({
      kind: "loaded",
      value: { id: OWN },
    });
    expect(t.requests.slice(2).map((r) => r.after)).toEqual([
      null,
      ids[199],
      ids[399],
    ]);
    t.ui.dispose();
  });

  test("P7: the controller stops and starts again for the SAME account while page two is held: the old walk ends, a new call starts at page one", async () => {
    const t = await composed(ids);
    const h = t.holdAt(2);
    const pending = t.ui.actions.readCurrent(LOCAL);
    await t.reached(h);
    t.ui.dispose();
    t.ui.start();
    for (let i = 0; i < 20 && t.ui.service() === null; i += 1)
      await t.w.env.settle();
    expect(t.ui.service()).not.toBeNull();
    h.release();
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    expect(t.requests).toHaveLength(2);
    expect(await t.ui.actions.readCurrent(LOCAL)).toMatchObject({
      kind: "loaded",
      value: { id: OWN },
    });
    expect(t.requests.slice(2).map((r) => r.after)).toEqual([
      null,
      ids[199],
      ids[399],
    ]);
    t.ui.dispose();
  });

  test("P7: the bound service ends (a wipe, a version change) while page two is held: refused, nothing more asked", async () => {
    const t = await composed(ids);
    const h = t.holdAt(2);
    const pending = t.ui.actions.readCurrent(LOCAL);
    await t.reached(h);
    t.ui.service()?.dispose("closed");
    await t.w.env.settle();
    h.release();
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    expect(t.requests).toHaveLength(2);
    t.ui.dispose();
  });
});
