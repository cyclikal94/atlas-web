// @vitest-environment node
import { describe, expect, test } from "vitest";
import { unorderedPersistence } from "../../src/data/engine/account-service";
import { createCommandRegistry } from "../../src/data/outbox/registries";
import { createDataEnv } from "../../src/data/ui/env";
import { StampedRequestError } from "../../src/session";
import { ACCOUNT, pageWorld } from "../support/data/page-world";
import { cacheRow, draftRow } from "../support/data/rows";

/**
 * R7 of the review of 10 October 2026 (finding family queue-conflict-current-read): WF-QUEUE-02's "Currently saved" is the target's
 * CURRENT state from an ordinary AUTHORISED read (the approved amendment `gaps/queue-02-desktop.html`, follow-up decision 4), never the
 * cache. The production controller makes it through the kind's registered `readCurrent` and the session's ORDINARY stamped fetch of the
 * displayed account and epoch; "save as new" is rebuilt on the value that read returned (or on nothing, when the person continued
 * without it), never on the cache.
 */
const LOCAL = "4e219b0a-0000-4000-8000-000000000001";

async function controller(
  options: {
    reader?: boolean;
    fetch?: boolean;
    throws?: boolean;
    /** Work the command does AFTER its decode (R7, second cycle): a test can hold it. */
    interpret?: () => Promise<void>;
  } = {},
) {
  const w = await pageWorld({ cursor: "d1", phase: "delta" });
  w.put("cache", [
    cacheRow({ id: "r1", label: "STALE cached value", version: 1 }),
  ]);
  w.put("drafts", [
    draftRow({
      local_id: LOCAL,
      kind: "edit",
      status: "operation_conflict",
      target_resource_ids: ["r1"],
      command: { kind: "edit", text: "mine" },
    }),
  ]);
  const requests: Array<{ account: string; epoch: number; url: string }> = [];
  const rebuilt: unknown[] = [];
  const commands = createCommandRegistry();
  commands.register("edit", {
    describe: () => "Feed cat",
    rebuild: (_draft, current) => {
      rebuilt.push(current);
      return null;
    },
    ...(options.reader === false
      ? {}
      : {
          readCurrent: async (_draft, io) => {
            if (options.throws) throw new Error("the slice's own failure");
            const response = await io.get("/tasks/r1");
            if (response.status === 404)
              return { kind: "failed", reason: "inaccessible" } as const;
            const body = (await response.json()) as {
              label: string;
              version: number;
            };
            await options.interpret?.();
            return {
              kind: "loaded",
              value: cacheRow({
                id: "r1",
                label: body.label,
                version: body.version,
              }),
            } as const;
          },
        }),
  });
  const runtime = new w.env.modules.accountService.DataRuntime({
    identity: w.identity,
    persistence: unorderedPersistence,
    registry: w.page.registry,
    open: (account, openOptions) => w.page.open(account, openOptions),
  });
  let answer = new Response(
    JSON.stringify({ label: "Fed at 08:02", version: 4 }),
    { status: 200 },
  );
  /**
   * The session's DURABLE record of the settled identity, which `session.api.seal` reads after the caller's whole result (R7, second
   * cycle). It is separate from the page's identity store on purpose: another page's settlement moves the record first, and this page's
   * identity follows only when its notice arrives (or never, when it is lost).
   */
  const record = { account: ACCOUNT as string | null, epoch: 1 };
  const seals: Array<{ account: string; epoch: number }> = [];
  let sealUnreadable = false;
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
    ...(options.fetch === false
      ? {}
      : {
          fetchOrdinary:
            (account: string, epoch: number) => async (request: Request) => {
              requests.push({ account, epoch, url: request.url });
              return answer;
            },
          apiUrl: (path: string) =>
            new URL(`http://localhost/api/experimental/v1${path}`),
          seal: async <T>(
            account: string,
            epoch: number,
            pending: Promise<T>,
          ) => {
            const value = await pending;
            seals.push({ account, epoch });
            if (
              sealUnreadable ||
              record.account !== account ||
              record.epoch !== epoch
            )
              throw new StampedRequestError("stale");
            return value;
          },
        }),
  });
  await w.env.settle();
  for (let i = 0; i < 20 && ui.service() === null; i += 1) await w.env.settle();
  if (ui.service() === null) throw new Error("setup: no database");
  return {
    w,
    ui,
    requests,
    rebuilt,
    setAnswer: (next: Response) => {
      answer = next;
    },
    record,
    seals,
    setSealUnreadable: (next: boolean) => {
      sealUnreadable = next;
    },
  };
}

describe("R7: the authorised current-state read of WF-QUEUE-02", () => {
  test("the kind's read is made with an ORDINARY stamped request of the displayed account and epoch, and its value (not the cache) is the answer", async () => {
    const { ui, requests } = await controller();
    const read = await ui.actions.readCurrent(LOCAL);
    expect(read).toMatchObject({
      kind: "loaded",
      value: { id: "r1", label: "Fed at 08:02", version: 4 },
    });
    expect(requests).toEqual([
      {
        account: ACCOUNT,
        epoch: 1,
        url: "http://localhost/api/experimental/v1/tasks/r1",
      },
    ]);
    ui.dispose();
  });

  test("an access that was lost is a FAILED read, never the cached value", async () => {
    const { ui, setAnswer } = await controller();
    setAnswer(new Response("{}", { status: 404 }));
    expect(await ui.actions.readCurrent(LOCAL)).toEqual({
      kind: "failed",
      reason: "inaccessible",
    });
    ui.dispose();
  });

  test("no registered read, no stamped fetch, or a read that throws: failed (unavailable / error), never the cache", async () => {
    const none = await controller({ reader: false });
    expect(await none.ui.actions.readCurrent(LOCAL)).toEqual({
      kind: "failed",
      reason: "unavailable",
    });
    expect(none.requests).toEqual([]);
    none.ui.dispose();
    const noFetch = await controller({ fetch: false });
    expect(await noFetch.ui.actions.readCurrent(LOCAL)).toEqual({
      kind: "failed",
      reason: "unavailable",
    });
    noFetch.ui.dispose();
    const throwing = await controller({ throws: true });
    expect(await throwing.ui.actions.readCurrent(LOCAL)).toEqual({
      kind: "failed",
      reason: "error",
    });
    throwing.ui.dispose();
  });

  test("'save as new' is rebuilt on the value the person reviewed, or on nothing; never on the cache", async () => {
    const { ui, rebuilt } = await controller();
    const read = await ui.actions.readCurrent(LOCAL);
    if (read.kind !== "loaded") throw new Error("setup: not loaded");
    expect(await ui.actions.saveAsNew(LOCAL, read.value)).toEqual({
      kind: "refused",
      reason: "not_rebuildable",
    });
    expect(await ui.actions.saveAsNew(LOCAL, null)).toEqual({
      kind: "refused",
      reason: "not_rebuildable",
    });
    expect(rebuilt).toEqual([read.value, null]);
    expect(JSON.stringify(rebuilt)).not.toContain("STALE cached value");
    ui.dispose();
  });
});

/** An answer whose decode is held after the stamped Response was released (`Response.json()` is asynchronous). */
function heldJson(body: unknown, status = 200) {
  const response = new Response("{}", { status });
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

async function until(
  w: Awaited<ReturnType<typeof controller>>["w"],
  done: () => boolean,
) {
  for (let i = 0; i < 40 && !done(); i += 1) await w.env.settle();
  if (!done()) throw new Error("setup: the read never reached its decode");
}

const NEW_VALUE = { label: "Fed at 08:02", version: 4 };

describe("R7, second cycle: the WHOLE interpreted result is released only against the durable record and the call's own scope", () => {
  test("control: with the stamp unchanged, a held decode ends and the exact server value is returned (sealed once, for the call's stamp)", async () => {
    const t = await controller();
    const held = heldJson(NEW_VALUE);
    t.setAnswer(held.response);
    const pending = t.ui.actions.readCurrent(LOCAL);
    await until(t.w, () => held.seen.decoding);
    held.release();
    expect(await pending).toMatchObject({
      kind: "loaded",
      value: { id: "r1", label: "Fed at 08:02", version: 4 },
    });
    expect(t.seals).toEqual([{ account: ACCOUNT, epoch: 1 }]);
    t.ui.dispose();
  });

  for (const transition of [
    "account switch",
    "same-account re-authentication",
    "sign-out",
  ] as const)
    test(`the decode held after the stamped Response, then a ${transition} on this page: refused, never the old value`, async () => {
      const t = await controller();
      const held = heldJson(NEW_VALUE);
      t.setAnswer(held.response);
      const pending = t.ui.actions.readCurrent(LOCAL);
      await until(t.w, () => held.seen.decoding);
      const next =
        transition === "account switch"
          ? { account: "other-account", epoch: 2 }
          : transition === "sign-out"
            ? { account: null, epoch: 1 }
            : { account: ACCOUNT, epoch: 2 };
      t.record.account = next.account;
      t.record.epoch = next.epoch;
      t.w.identity.move(next);
      await t.w.env.settle();
      held.release();
      expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
      t.ui.dispose();
    });

  test("ANOTHER page settles a new epoch and this page's notice never arrives (its identity still names the old stamp): the durable record refuses it", async () => {
    const t = await controller();
    const held = heldJson(NEW_VALUE);
    t.setAnswer(held.response);
    const pending = t.ui.actions.readCurrent(LOCAL);
    await until(t.w, () => held.seen.decoding);
    t.record.epoch = 2;
    expect(t.w.identity.get()?.epoch).toBe(1);
    held.release();
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    t.ui.dispose();
  });

  test("the decode finished, the command's LATER interpretation held, then the transition: still refused (sealing the decode alone is too early)", async () => {
    let releaseInterpret!: () => void;
    let interpreting = false;
    const t = await controller({
      interpret: () => {
        interpreting = true;
        return new Promise<void>((resolve) => {
          releaseInterpret = resolve;
        });
      },
    });
    const pending = t.ui.actions.readCurrent(LOCAL);
    await until(t.w, () => interpreting);
    t.record.epoch = 2;
    releaseInterpret();
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    t.ui.dispose();
  });

  test("a failure of the old stamp is not handed back either: a 404 decoded after the switch is unavailable, not inaccessible", async () => {
    const t = await controller();
    t.setAnswer(new Response("{}", { status: 404 }));
    t.record.account = "other-account";
    expect(await t.ui.actions.readCurrent(LOCAL)).toEqual({
      kind: "failed",
      reason: "unavailable",
    });
    t.ui.dispose();
  });

  test("a record that cannot be read at the seal fails closed: unavailable, never loaded", async () => {
    const t = await controller();
    t.setSealUnreadable(true);
    expect(await t.ui.actions.readCurrent(LOCAL)).toEqual({
      kind: "failed",
      reason: "unavailable",
    });
    t.ui.dispose();
  });

  test("the controller stops during the decode, and starts again for the SAME account: the old call stays refused; a new call is loaded", async () => {
    const t = await controller();
    const held = heldJson(NEW_VALUE);
    t.setAnswer(held.response);
    const pending = t.ui.actions.readCurrent(LOCAL);
    await until(t.w, () => held.seen.decoding);
    t.ui.dispose();
    t.ui.start();
    for (let i = 0; i < 20 && t.ui.service() === null; i += 1)
      await t.w.env.settle();
    expect(t.ui.service()).not.toBeNull();
    held.release();
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    t.setAnswer(new Response(JSON.stringify(NEW_VALUE), { status: 200 }));
    expect(await t.ui.actions.readCurrent(LOCAL)).toMatchObject({
      kind: "loaded",
    });
    t.ui.dispose();
  });

  test("the bound service ends during the decode (a wipe, a version change): refused", async () => {
    const t = await controller();
    const held = heldJson(NEW_VALUE);
    t.setAnswer(held.response);
    const pending = t.ui.actions.readCurrent(LOCAL);
    await until(t.w, () => held.seen.decoding);
    t.ui.service()?.dispose("closed");
    await t.w.env.settle();
    held.release();
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    t.ui.dispose();
  });

  test("the caller cancels during the decode of a command that ignores its signal: refused; a sibling call with its own signal is loaded", async () => {
    const t = await controller();
    const held = heldJson(NEW_VALUE);
    t.setAnswer(held.response);
    const cancelled = new AbortController();
    const pending = t.ui.actions.readCurrent(LOCAL, cancelled.signal);
    await until(t.w, () => held.seen.decoding);
    t.setAnswer(new Response(JSON.stringify(NEW_VALUE), { status: 200 }));
    const sibling = t.ui.actions.readCurrent(
      LOCAL,
      new AbortController().signal,
    );
    cancelled.abort();
    held.release();
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    expect(await sibling).toMatchObject({ kind: "loaded" });
    t.ui.dispose();
  });

  test("a call whose scope ended before its draft was read sends nothing", async () => {
    const t = await controller();
    const pending = t.ui.actions.readCurrent(LOCAL);
    t.ui.dispose();
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    expect(t.requests).toEqual([]);
  });
});
