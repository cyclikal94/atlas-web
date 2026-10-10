import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { DataEnvProvider, useCachedResource } from "../../src/data";
import { DATA_CONFIG } from "../../src/data/model/config";
import { invalidateOperation } from "../../src/data/model/retry";
import { resetSizingFloor } from "../../src/data/plans/sync-writers";
import { CacheGate } from "../../src/features/sync/CacheGate";
import { GATE_TITLE } from "../../src/features/sync/copy";
import {
  type ControllerProbe,
  controllerProbe,
} from "../support/data/controller-world";
import { engineWorld } from "../support/data/engine-world";
import { pageMarkers, scopeOf } from "../support/data/marker-storage";
import { cacheRow, draftRow } from "../support/data/rows";
import { uuid } from "../support/data/sync-pages";

/**
 * R15 at the component boundary (revision 11): the REAL provider, `CacheGate` and `useCachedResource` over the production controller,
 * engine, plans and the double of IndexedDB, in jsdom. The sixth review reproduced that the retained content stayed rendered in an
 * already-open follower after another page recorded an invalidation only in the fallback marker. Here the follower is mounted and
 * showing the content BEFORE the leader's invalidation fails, for the counter-write failure and the quota path, and the content must
 * leave the screen while the shell stays. FIXTURE evidence (jsdom, named injected faults, a `localStorage` double that models pages).
 */
afterEach(cleanup);
const RETAINED = "REVIEW RETAINED CONTENT";
const OP = invalidateOperation("cursor-0");

/** What the mounted content did: how many times it was mounted, and unmounted (a flicker is an unmount and a mount). */
const lifecycle = { mounted: 0, unmounted: 0 };

function Resource() {
  const resource = useCachedResource(uuid(9));
  useEffect(() => {
    lifecycle.mounted += 1;
    return () => {
      lifecycle.unmounted += 1;
    };
  }, []);
  return (
    <p data-testid="resource">
      {resource.status === "ready"
        ? (resource.value.merged?.label ?? "nothing")
        : `unavailable:${resource.status}`}
    </p>
  );
}

async function mountFollower() {
  lifecycle.mounted = 0;
  lifecycle.unmounted = 0;
  const w = await engineWorld({ cursor: "cursor-0" });
  w.put("cache", [cacheRow({ id: uuid(9), label: RETAINED })]);
  w.put("drafts", [draftRow({ local_id: "kept", status: "queued" })]);
  const leader = await controllerProbe(w, { leader: true });
  const follower = await controllerProbe(w, { leader: false });
  render(
    <DataEnvProvider env={follower.ui}>
      <nav aria-label="Shell">Shell stays</nav>
      <CacheGate>
        <Resource />
      </CacheGate>
    </DataEnvProvider>,
  );
  await act(() => w.settle());
  return { w, leader, follower };
}
type Mounted = Awaited<ReturnType<typeof mountFollower>>;

const gateShown = () =>
  screen.queryByRole("heading", { name: GATE_TITLE }) !== null;

/** The leader receives the 410 and its invalidation fails; only the marker (or, for the control, the counter) records it. */
async function failInvalidation(
  t: Mounted,
  path: "counter" | "marker" | "quota",
) {
  t.w.env.idb.inject({
    match: (tx) => tx.label === "data.invalidateCache",
    mode: path === "quota" ? "quota" : "error",
    times: 100,
  });
  if (path === "marker")
    t.w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 100,
    });
  t.w.script.push(t.w.status(410, { body: { code: "resync_required" } }));
  await act(async () => {
    t.w.start();
    await t.w.settle();
    await t.w.advance(600_000);
  });
}

const finish = (t: Mounted) => {
  cleanup();
  t.leader.dispose();
  t.follower.dispose();
  t.w.engine.stop();
};

describe("an already-open follower's CacheGate after another page's invalidation could only be recorded in the marker", () => {
  test("control: before anything fails the content is rendered, with no gate", async () => {
    const t = await mountFollower();
    expect(screen.getByText(RETAINED)).toBeInTheDocument();
    expect(gateShown()).toBe(false);
    finish(t);
  });

  for (const path of ["counter", "marker", "quota"] as const)
    test(`${path}: the retained content leaves the screen, the gate's message and the shell are shown, and the draft and the cached row are kept`, async () => {
      const t = await mountFollower();
      expect(screen.getByText(RETAINED)).toBeInTheDocument();
      await failInvalidation(t, path);
      // The database still says `valid` for the two marker paths: only the marker records the invalidation.
      expect(t.w.sync().cache_status).toBe("valid");
      if (path === "counter")
        expect(t.w.markers.operations(scopeOf(t.w.service.account))).toEqual(
          [],
        );
      else
        expect(t.w.markers.operations(scopeOf(t.w.service.account))).toEqual([
          OP,
        ]);
      expect(screen.queryByText(RETAINED)).toBeNull();
      expect(screen.queryByTestId("resource")).toBeNull();
      expect(gateShown()).toBe(true);
      expect(
        screen.getByRole("navigation", { name: "Shell" }),
      ).toBeInTheDocument();
      expect(t.w.rows("drafts")).toHaveLength(1);
      expect(t.w.cache()).toHaveLength(1);
      finish(t);
    });
});

describe("a marker that does not concern the displayed account and position does not touch the screen", () => {
  const FOREIGN: ReadonlyArray<
    readonly [string, (account: string) => [string, string]]
  > = [
    ["another account's marker", () => ["other-acct", OP]],
    [
      "another position's marker",
      (account) => [account, invalidateOperation("cursor-9")],
    ],
    [
      "an unrelated operation's marker",
      (account) => [account, "page:cursor-0"],
    ],
  ];
  for (const [name, key] of FOREIGN)
    test(`${name}: the content is neither hidden nor re-mounted`, async () => {
      const t = await mountFollower();
      const page = t.w.markerStorage.page("another-tab");
      const other = pageMarkers(page);
      const [account, operation] = key(t.w.service.account);
      await act(async () => {
        other.set(scopeOf(account), operation);
        await t.w.settle();
      });
      expect(screen.getByText(RETAINED)).toBeInTheDocument();
      expect(gateShown()).toBe(false);
      await act(async () => {
        other.clear(scopeOf(account), operation);
        await t.w.settle();
      });
      expect(screen.getByText(RETAINED)).toBeInTheDocument();
      expect(lifecycle).toEqual({ mounted: 1, unmounted: 0 });
      finish(t);
    });
});

describe("recovery and the notification's limits, on the screen", () => {
  const nudge = (t: Mounted, probe: ControllerProbe) =>
    act(async () => {
      const service = probe.ui.service() ?? t.w.service;
      await service.store.run(resetSizingFloor, {
        incarnationId: service.incarnationId,
      });
      await t.w.settle();
    });

  test("the leader's retry writes the invalidation and the marker goes: the content stays hidden until a snapshot is applied, then returns", async () => {
    const t = await mountFollower();
    await failInvalidation(t, "marker");
    expect(gateShown()).toBe(true);
    t.w.env.idb.clearInjections();
    await act(async () => {
      t.leader.ui.actions.retryUpdates();
      await t.w.settle();
      await t.w.advance(60_000);
    });
    expect(t.w.sync().cache_status).toBe("invalid");
    expect(t.w.markers.operations(scopeOf(t.w.service.account))).toEqual([]);
    expect(screen.queryByText(RETAINED)).toBeNull();
    expect(gateShown()).toBe(true);
    t.w.setSync({
      cache_status: "valid",
      cursor: "cursor-1",
      local_write_streaks: {},
    });
    await nudge(t, t.follower);
    expect(screen.getByText(RETAINED)).toBeInTheDocument();
    expect(gateShown()).toBe(false);
    finish(t);
  });

  test("a marker another page removes opens nothing by itself: the content returns only when a read begun after it lands", async () => {
    const t = await mountFollower();
    const page = t.w.markerStorage.page("another-tab");
    const other = pageMarkers(page);
    await act(async () => {
      other.set(scopeOf(t.w.service.account), OP);
      await t.w.settle();
    });
    expect(screen.queryByText(RETAINED)).toBeNull();
    expect(gateShown()).toBe(true);
    // The marker goes while the facts still say `valid`; the read that would say so does not answer. Both pages' controllers (the
    // leader's page also hears another page's change) read again, so two reads never answer.
    t.w.env.idb.inject({
      match: (tx) => tx.label === "data.readSyncFacts",
      mode: "pending",
      times: 2,
    });
    await act(async () => {
      other.clear(scopeOf(t.w.service.account), OP);
      await t.w.settle();
    });
    expect(screen.queryByText(RETAINED)).toBeNull();
    expect(gateShown()).toBe(true);
    await act(async () => {
      await t.w.advance(DATA_CONFIG.factsReadRetryMs * 4);
    });
    expect(screen.queryByText(RETAINED)).toBeNull();
    await nudge(t, t.follower);
    expect(screen.getByText(RETAINED)).toBeInTheDocument();
    expect(gateShown()).toBe(false);
    finish(t);
  });
});
