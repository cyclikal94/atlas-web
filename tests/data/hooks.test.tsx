import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  createDataEnv,
  DataEnvProvider,
  useCachedResource,
  useChildPage,
  useMergedUnder,
  useResourceList,
  useVisibleChildren,
} from "../../src/data";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import type { SyncChannel } from "../../src/data/engine/sync-channel";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { Identity, Store } from "../../src/session";
import { DataTestWorld } from "../support/data/env";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";

/**
 * The cache hooks (plan 5.5.6): a resource with the overlay of its admitted changes, live, through the PRODUCTION controller, plans
 * and the double of IndexedDB. They return `unavailable` with no database and NEVER create one. FIXTURE evidence.
 */
afterEach(cleanup);
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

class Cell<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get() {
    return this.value;
  }
  set(next: T) {
    this.value = next;
    for (const l of [...this.listeners]) l();
  }
  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

async function mount(
  options: { database: boolean },
  view: () => React.ReactNode,
) {
  const world = new DataTestWorld();
  world.idb.autoDrive = true;
  const page = world.page("A");
  page.identity.account = ACCOUNT;
  if (options.database) {
    const created = await page.open(ACCOUNT, { create: true });
    if (created.kind !== "opened") throw new Error("setup");
  }
  const identity = new Cell<Identity | null>({
    account_id: ACCOUNT,
    epoch: 1,
    session_id: "s",
  });
  const runtime = new world.modules.accountService.DataRuntime({
    identity,
    persistence: world.modules.accountService.unorderedPersistence,
    registry: page.registry,
    open: (a, o) => page.open(a, o),
  });
  const channel: SyncChannel = {
    post: () => undefined,
    subscribe: () => () => undefined,
  };
  const env = createDataEnv({
    identity,
    loadRuntime: async () => runtime,
    online: new Cell(true),
    quota: createQuotaGuard({ storage: undefined, now: () => 0 }),
    ids: { uuid: () => crypto.randomUUID() },
    clock: { iso: () => new Date().toISOString(), now: () => 0 },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "closed" }),
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: () => () => undefined,
    channel,
  });
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 15; i += 1) await world.settle();
    });
  };
  render(<DataEnvProvider env={env}>{view()}</DataEnvProvider>);
  await settle();
  return { world, page, env, settle };
}

function One({ id }: { id: string }) {
  const out = useCachedResource(id);
  if (out.status !== "ready")
    return (
      <p data-testid="state">
        {out.status === "unavailable"
          ? `unavailable:${out.reason}`
          : out.status}
      </p>
    );
  return (
    <p data-testid="state">
      {out.value.merged
        ? `${out.value.merged.label}|v${out.value.merged.version}|effects:${out.value.effects.length}`
        : "nothing"}
    </p>
  );
}

/** A new resource the cache does not hold: the changes saved against it, a window at a time (R21, revision 10). */
function Pending({ id, after }: { id: string; after?: number | null }) {
  const out = useCachedResource(id, after);
  if (out.status !== "ready") return <p data-testid="pending">{out.status}</p>;
  return (
    <p
      data-testid="pending"
      data-total={out.value.createsTotal}
      data-next={out.value.createsNext ?? ""}
    >
      {out.value.creates.map((draft) => draft.local_id).join(",")}
    </p>
  );
}

/** The same read, moved on by the screen itself: the cursor changes while the view stays mounted. */
function Paged({ id }: { id: string }) {
  const [after, setAfter] = useState<number | null>(null);
  const out = useCachedResource(id, after);
  return (
    <>
      <button
        type="button"
        data-testid="more"
        onClick={() =>
          setAfter(out.status === "ready" ? out.value.createsNext : null)
        }
      >
        more
      </button>
      <p data-testid="paged">
        {out.status === "ready"
          ? out.value.creates.map((draft) => draft.local_id).join(",")
          : out.status}
      </p>
    </>
  );
}

function List({ after, limit }: { after?: string | null; limit?: number }) {
  const out = useResourceList({ kind: "person", after, limit });
  if (out.status !== "ready") return <p data-testid="list">{out.status}</p>;
  return (
    <p data-testid="list" data-next={out.value.next ?? ""}>
      {out.value.rows.map((m) => m.merged.label).join(",")}
    </p>
  );
}

/** A person's fields only while the person is cached (PPL-5, review 15 R15.1); `parent` moves while the view stays mounted. */
function Children() {
  const [parent, setParent] = useState("q");
  const out = useVisibleChildren({
    parentId: parent,
    parentKind: "person",
    kind: "field",
  });
  return (
    <>
      <button type="button" data-testid="other" onClick={() => setParent("r")}>
        other
      </button>
      <p data-testid="children">
        {out.status !== "ready"
          ? out.status
          : out.value === null
            ? "hidden"
            : out.value.rows.map((m) => m.merged.label).join(",")}
      </p>
    </>
  );
}

/** A person's field page with its parent (WEB-11a review 16, R16.1); `parent` moves while the view stays mounted. */
function ChildPageOf() {
  const [parent, setParent] = useState("q");
  const out = useChildPage({
    kind: "field",
    parentKind: "person",
    parentId: parent,
  });
  return (
    <>
      <button
        type="button"
        data-testid="other-page"
        onClick={() => setParent("r")}
      >
        other
      </button>
      <p data-testid="child-page">
        {out.status !== "ready"
          ? out.status
          : `${Object.keys(out.value.parents).join(",") || "none"}:${out.value.page.rows.map((m) => m.merged.label).join(",")}`}
      </p>
    </>
  );
}

/** A field with its parent in one read (WEB-11a review 16); `field` moves while the view stays mounted. */
function UnderOf() {
  const [field, setField] = useState("fq");
  const out = useMergedUnder(field);
  return (
    <>
      <button
        type="button"
        data-testid="other-field"
        onClick={() => setField("fr")}
      >
        other
      </button>
      <p data-testid="under">
        {out.status !== "ready"
          ? out.status
          : `${out.value.resource.merged?.label ?? "none"}|${out.value.parent?.merged?.label ?? "none"}`}
      </p>
    </>
  );
}

describe("with no database", () => {
  test("a resource and a list are unavailable (absent), and nothing is created", async () => {
    const t = await mount({ database: false }, () => (
      <>
        <One id="r" />
        <List />
      </>
    ));
    expect(screen.getByTestId("state")).toHaveTextContent("unavailable:absent");
    expect(screen.getByTestId("list")).toHaveTextContent("unavailable");
    expect(t.world.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
  });
});

describe("with a database", () => {
  test("a cached resource is read with the overlay of its admitted changes layered over it, live", async () => {
    const t = await mount({ database: true }, () => <One id="r" />);
    const name = accountDatabaseName(ACCOUNT);
    expect(screen.getByTestId("state")).toHaveTextContent("nothing");
    t.world.idb.seed(name, "cache", [
      cacheRow({ id: "r", label: "Base", version: 5 }),
    ]);
    // A change to this resource is admitted: its display patch is layered over the cached row.
    t.world.idb.seed(name, "pending_effects", [
      effectRow({
        resource_id: "r",
        local_id: "L1",
        display: { label: "Shown" },
        created_at: "2026-10-01T09:00:00.000Z",
      }),
    ]);
    await t.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await t.settle();
    expect(screen.getByTestId("state")).toHaveTextContent("Shown|v5|effects:1");
  });

  test("a list is the cached rows of a kind, each with its overlay, and a row another tab adds appears without a reload", async () => {
    const t = await mount({ database: true }, () => <List />);
    const name = accountDatabaseName(ACCOUNT);
    t.world.idb.seed(name, "cache", [
      cacheRow({ id: "a", kind: "person", label: "Ada" }),
      cacheRow({ id: "t", kind: "task", label: "Not a person" }),
    ]);
    t.world.idb.seed(name, "pending_effects", [
      effectRow({
        resource_id: "a",
        local_id: "L1",
        display: { label: "Ada L." },
      }),
    ]);
    await t.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await t.settle();
    expect(screen.getByTestId("list")).toHaveTextContent("Ada L.");
    expect(screen.getByTestId("list")).not.toHaveTextContent("Not a person");
    t.world.idb.seed(name, "cache", [
      cacheRow({ id: "b", kind: "person", label: "Bea" }),
    ]);
    await t.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: { n: 2 } }),
    });
    await t.settle();
    expect(screen.getByTestId("list").textContent).toContain("Bea");
  });

  test("a list is a bounded PAGE with a cursor: `limit` and `after` move through it, and the largest page is the approved bound", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      cacheRow({ id: `p-${i}`, kind: "person", label: `Person ${i}` }),
    );
    const first = await mount({ database: true }, () => <List limit={2} />);
    first.world.idb.seed(accountDatabaseName(ACCOUNT), "cache", rows);
    await first.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: { n: 1 } }),
    });
    await first.settle();
    expect(screen.getByTestId("list")).toHaveTextContent("Person 0,Person 1");
    expect(screen.getByTestId("list")).toHaveAttribute("data-next", "p-1");
    cleanup();
    const second = await mount({ database: true }, () => (
      <List limit={2} after="p-1" />
    ));
    second.world.idb.seed(accountDatabaseName(ACCOUNT), "cache", rows);
    await second.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: { n: 1 } }),
    });
    await second.settle();
    expect(screen.getByTestId("list")).toHaveTextContent("Person 2,Person 3");
    expect(screen.getByTestId("list")).toHaveAttribute("data-next", "p-3");
  });

  test("a new resource with 130 saved changes: the first window, and `after` reads on, each change exactly once", async () => {
    const name = accountDatabaseName(ACCOUNT);
    const seed = (t: Awaited<ReturnType<typeof mount>>) =>
      t.world.idb.seed(
        name,
        "drafts",
        Array.from({ length: 130 }, (_, i) =>
          draftRow({
            local_id: `n${String(i).padStart(3, "0")}`,
            created_seq: i + 1,
            index_targets: ["new"],
            target_resource_ids: ["new"],
          } as never),
        ),
      );
    const first = await mount({ database: true }, () => <Pending id="new" />);
    seed(first);
    await first.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await first.settle();
    const page = screen.getByTestId("pending");
    expect(page).toHaveAttribute("data-total", "130");
    expect(page).toHaveAttribute("data-next", "100");
    const ids = (page.textContent ?? "").split(",");
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe("n000");
    expect(ids[99]).toBe("n099");
    cleanup();
    const second = await mount({ database: true }, () => (
      <Pending id="new" after={100} />
    ));
    seed(second);
    await second.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await second.settle();
    const rest = screen.getByTestId("pending");
    expect(rest).toHaveAttribute("data-total", "130");
    expect(rest).toHaveAttribute("data-next", "");
    expect((rest.textContent ?? "").split(",")).toEqual(
      Array.from(
        { length: 30 },
        (_, i) => `n${String(100 + i).padStart(3, "0")}`,
      ),
    );
  });

  test("a screen that moves the cursor on while it stays mounted reads the next window: the read follows `after`", async () => {
    const t = await mount({ database: true }, () => <Paged id="new" />);
    t.world.idb.seed(
      accountDatabaseName(ACCOUNT),
      "drafts",
      Array.from({ length: 130 }, (_, i) =>
        draftRow({
          local_id: `n${String(i).padStart(3, "0")}`,
          created_seq: i + 1,
          index_targets: ["new"],
          target_resource_ids: ["new"],
        } as never),
      ),
    );
    await t.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await t.settle();
    const first = (screen.getByTestId("paged").textContent ?? "").split(",");
    expect(first).toHaveLength(100);
    expect(first[0]).toBe("n000");
    await act(async () => {
      screen.getByTestId("more").click();
    });
    await t.settle();
    const rest = (screen.getByTestId("paged").textContent ?? "").split(",");
    expect(rest).toHaveLength(30);
    expect(rest[0]).toBe("n100");
    expect(rest[29]).toBe("n129");
  });

  test("a person's fields (PPL-5): another parent is a NEW read that starts loading, never the earlier parent's answer", async () => {
    const t = await mount({ database: true }, () => <Children />);
    const name = accountDatabaseName(ACCOUNT);
    t.world.idb.seed(name, "cache", [
      cacheRow({ id: "q", kind: "person", label: "Q" }),
      cacheRow({ id: "fq", kind: "field", parent_id: "q", label: "Q's" }),
      cacheRow({ id: "fr", kind: "field", parent_id: "r", label: "R's" }),
    ]);
    await t.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await t.settle();
    expect(screen.getByTestId("children")).toHaveTextContent("Q's");
    // R's read is not delivered yet: the view must not keep Q's answer for R.
    t.world.idb.autoDrive = false;
    act(() => screen.getByTestId("other").click());
    expect(screen.getByTestId("children")).toHaveTextContent("loading");
    t.world.idb.autoDrive = true;
    await t.settle();
    // R is not cached as a person: its cached field is not shown.
    expect(screen.getByTestId("children")).toHaveTextContent("hidden");
  });

  test("R16.1: a field page with its person: another parent is a NEW read that starts loading, never the earlier parent's answer", async () => {
    const t = await mount({ database: true }, () => <ChildPageOf />);
    const name = accountDatabaseName(ACCOUNT);
    t.world.idb.seed(name, "cache", [
      cacheRow({ id: "q", kind: "person", label: "Q" }),
      cacheRow({ id: "fq", kind: "field", parent_id: "q", label: "Q's" }),
      cacheRow({ id: "fr", kind: "field", parent_id: "r", label: "R's" }),
    ]);
    await t.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await t.settle();
    expect(screen.getByTestId("child-page")).toHaveTextContent("q:Q's");
    t.world.idb.autoDrive = false;
    act(() => screen.getByTestId("other-page").click());
    expect(screen.getByTestId("child-page")).toHaveTextContent("loading");
    t.world.idb.autoDrive = true;
    await t.settle();
    // R is not cached as a person: nothing of its cached field is answered.
    expect(screen.getByTestId("child-page")).toHaveTextContent("none:");
  });

  test("R16.1: a field with its person in one read: another field is a NEW read that starts loading", async () => {
    const t = await mount({ database: true }, () => <UnderOf />);
    const name = accountDatabaseName(ACCOUNT);
    t.world.idb.seed(name, "cache", [
      cacheRow({ id: "q", kind: "person", label: "Q" }),
      cacheRow({ id: "fq", kind: "field", parent_id: "q", label: "Q's" }),
      cacheRow({ id: "fr", kind: "field", parent_id: "r", label: "R's" }),
    ]);
    await t.env.outbox()?.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    await t.settle();
    expect(screen.getByTestId("under")).toHaveTextContent("Q's|Q");
    t.world.idb.autoDrive = false;
    act(() => screen.getByTestId("other-field").click());
    expect(screen.getByTestId("under")).toHaveTextContent("loading");
    t.world.idb.autoDrive = true;
    await t.settle();
    expect(screen.getByTestId("under")).toHaveTextContent("R's|none");
  });

  test("a person's fields with no database: unavailable, never a page", async () => {
    await mount({ database: false }, () => <Children />);
    expect(screen.getByTestId("children")).toHaveTextContent("unavailable");
  });

  test("a view never reads another account: when the identity leaves, it reads as unavailable", async () => {
    const t = await mount({ database: true }, () => <One id="r" />);
    t.page.identity.account = null;
    (t.env.identity as Cell<Identity | null>).set(null);
    await t.settle();
    expect(screen.getByTestId("state")).toHaveTextContent("unavailable");
  });
});
