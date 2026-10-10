// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  createWriteFailureMarkers,
  DIRECTORY_PREFIX,
  MARKER_PREFIX,
} from "../../src/data/engine/write-failure-marker";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import {
  markerStands,
  pageMarkers,
  plantMarker,
  scopeOf,
  setGlobalStorage,
  withGlobalStorage,
} from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R47(b) (revision 29): a FRESH dispatcher does not send a draft whose persisted stop it cannot read.
 *
 * Revision 28 kept the markers a page had established, which protects a page that has read them, but a page that reloads has read
 * nothing: its dispatcher asked `has`, which turns "could not read" into "no marker", so a draft whose edit had failed (and whose failure
 * could be recorded only in the fallback marker) was sent when the page came online, with no retry, edit or abandonment, and the
 * acknowledgement then left the raw marker standing. Admission now asks `probe`: a marker that is neither read nor known to this page is
 * `unknown`, and the draft is held back (it is not a stop, and not a permission), asked about again at every step on a paced rescan, and
 * released by a read that lands (the person's retry and the operation's own success remove the record, and what releases the draft is a
 * read that then finds nothing: a removal is not kept as proof of absence, R47 revision 30). EVERY test here builds a FRESH markers
 * object, a fresh facade and a fresh dispatcher: a helper that reuses the previous page's markers cannot show what a reload does.
 *
 * FIXTURE evidence: the production facade, plans and dispatcher over the double of IndexedDB and of `localStorage` (whose reads throw a
 * `SecurityError`); native Dexie/IndexedDB and the page's real `localStorage` are E-O10.
 */
const request = (
  localId: string,
  label: string = localId,
  target = `r-${localId}`,
): EnqueueRequest => ({
  localId,
  endpoint: "/commands",
  targets: [
    {
      resourceId: target,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ],
  build: (bases) => ({
    command: {
      kind: "edit",
      id: target,
      label,
      expected_version: bases[target] as number,
    },
  }),
});

/**
 * ADAPTED, revision 33 (R55): a marker is found by reading the fixed addresses of the directories and the key of each failure they list,
 * never by listing the origin's keys. What can be unreadable is therefore a read of a key: of the directories (`directory`), of the
 * failure's own key (`marker`), or of every key (`getItem`). A listing that is refused (`enumeration`) no longer hides a marker, which is
 * what the first control below asserts. The old kinds `enumeration` and `both` become `directory` and `getItem`.
 */
type Unreadable = "directory" | "marker" | "getItem";
const KINDS: Unreadable[] = ["directory", "marker", "getItem"];
const unreadable = (w: OutboxWorld, kind: Unreadable): void => {
  w.markerStorage.failGets = kind === "getItem";
  w.markerStorage.failGetsFor =
    kind === "directory"
      ? (key) => key.startsWith(DIRECTORY_PREFIX)
      : kind === "marker"
        ? (key) => key.startsWith(MARKER_PREFIX)
        : null;
};
const readable = (w: OutboxWorld): void => {
  w.markerStorage.failEnumeration = false;
  w.markerStorage.failGets = false;
  w.markerStorage.failGetsFor = null;
};
const finish = (w: OutboxWorld): void => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};
const account = (w: OutboxWorld): string => w.service.account;
/**
 * ADAPTED, revision 32 (R52): a marker is a key of its own (`<operation>#<page>.<count>`), written once and removed by that exact key.
 * A marker is READ by listing the account's keys, so `unreadable("getItem")` no longer makes one unreadable (a value is never read) and
 * the cases that varied which way the store could not be read keep their names and say what is now so. A retry made while the store
 * cannot be listed names nothing and removes nothing: the act is entitled to the failures that stood when it began, and a listing made
 * later could name one that is newer. The retry made when a listing lands names the failure that stands and ends it.
 */
const raw = (w: OutboxWorld, operation: string): boolean =>
  markerStands(w.markerStorage, account(w), operation);
const fail = (w: OutboxWorld, label: string, times: number) =>
  w.env.idb.inject({
    match: (tx) => tx.label === label,
    mode: "error",
    times,
  });
/** What the transactions of one plan wrote (a commit that wrote nothing is not counted). */
const written = (w: OutboxWorld, label: string): number =>
  w.env.world.logs.filter(
    (e) => e.type === "idb.commit" && e.label === label && e.wrote === true,
  ).length;
const hint = (w: OutboxWorld): void =>
  w.deliver({ type: "data_changed", account: account(w), stores: ["drafts"] });

async function world(): Promise<OutboxWorld> {
  const w = await outboxWorld();
  w.online = false;
  w.put("cache", [
    cacheRow({ id: "r-a", version: 5 }),
    cacheRow({ id: "r-b", version: 5 }),
    cacheRow({ id: "r-c", version: 5 }),
  ]);
  return w;
}

async function queued(
  w: OutboxWorld,
  ids: readonly string[] = ["a"],
): Promise<void> {
  for (const id of ids)
    expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
      "queued",
    );
  await w.settle();
}

/** The facade's edit of `id` fails and so does the recording of that failure: only the fallback marker holds the stop (the reviewer's schedule). */
async function markerStop(w: OutboxWorld, id = "a"): Promise<void> {
  fail(w, "data.editQueuedDraft", 1);
  fail(w, "data.recordLocalWriteOutcome", 1);
  expect((await w.outbox.editQueued(id, request(id, "unsaved"))).kind).toBe(
    "refused",
  );
  await w.settle();
  expect(w.outbox.storageNotResponding.get()).toBe(true);
  expect(raw(w, `draft:${id}`)).toBe(true);
}

/** The facade's edit fails three times: the durable counter holds the stop. */
async function streakStop(w: OutboxWorld, id = "a"): Promise<void> {
  fail(w, "data.editQueuedDraft", 3);
  for (let i = 0; i < 3; i += 1)
    expect((await w.outbox.editQueued(id, request(id, "unsaved"))).kind).toBe(
      "refused",
    );
  await w.settle();
  expect(w.sync().local_write_streaks[`draft:${id}`]).toBe(3);
}

/** A page reload: the dispatcher and facade of the old page end, and a new page reads the storage with its own fresh markers. */
function reload(
  w: OutboxWorld,
  kind: Unreadable | "readable",
  markers?: ReturnType<typeof createWriteFailureMarkers>,
): void {
  w.dispatcher.stop();
  if (kind === "readable") readable(w);
  else unreadable(w, kind);
  w.reload(markers ? { markers } : undefined);
}

describe("a fresh dispatcher whose marker for a stopped draft cannot be read does not send it", () => {
  for (const kind of KINDS)
    test(`${kind} unreadable: nothing is sent when the page comes online, the marker stands, and nothing was written for the refusal`, async () => {
      const w = await world();
      try {
        await queued(w);
        await markerStop(w);
        reload(w, kind);
        // A store whose directories or markers cannot be read has never been read by this page, which says so (ADAPTED, revision 33).
        // ADAPTED, revision 34: with only the directories unreadable the listing names the marker, and the draft is held as marked.
        expect(w.markers.probe(scopeOf(account(w)), "draft:a")).toBe(
          kind === "directory" ? "marked" : "unknown",
        );
        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        expect(w.sent).toHaveLength(0);
        expect(raw(w, "draft:a")).toBe(true);
        expect(w.drafts()[0]?.status).toBe("queued");
        expect(w.dispatcher.state.get()).toEqual({
          kind: "stopped",
          cause: "local_storage",
        });
        // Refusing is not recovering: no claim wrote, and the stop was neither ended nor created anew.
        expect(written(w, "data.markInFlight")).toBe(0);
        expect(w.sync().local_write_streaks).toEqual({});
      } finally {
        finish(w);
      }
    });

  for (const kind of KINDS)
    test(`${kind} unreadable then readable: the stop the marker records is still honoured, and the person's retry is what sends the draft, once, and removes the marker`, async () => {
      const w = await world();
      try {
        await queued(w);
        await markerStop(w);
        reload(w, kind);
        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        readable(w);
        w.dispatcher.wake();
        await w.settle();
        await w.advance(70_000);
        expect(w.sent).toHaveLength(0);
        expect(raw(w, "draft:a")).toBe(true);
        hint(w);
        await w.settle();
        expect(w.outbox.storageNotResponding.get()).toBe(true);
        w.outbox.retry("a");
        await w.settle();
        await w.advance(10_000);
        expect(w.sent.map((s) => s.key)).toEqual(["a"]);
        expect(raw(w, "draft:a")).toBe(false);
        expect(w.outbox.storageNotResponding.get()).toBe(false);
      } finally {
        finish(w);
      }
    });

  test("both unreadable and NO marker anywhere (a store the page cannot read at all): the draft is held, and a read that lands releases it without anyone's act", async () => {
    const w = await world();
    try {
      await queued(w);
      reload(w, "getItem");
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      expect(w.dispatcher.state.get().kind).toBe("stopped");
      readable(w);
      // The store is readable now, but nothing tells the page: the rescan (a paced timer) is what asks again.
      await w.advance(70_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(w.dispatcher.state.get().kind).toBe("idle");
    } finally {
      finish(w);
    }
  });

  test("a wake after the store is readable releases it at once, and the draft is sent exactly once", async () => {
    const w = await world();
    try {
      await queued(w);
      reload(w, "getItem");
      w.online = true;
      w.start();
      await w.settle();
      expect(w.sent).toHaveLength(0);
      readable(w);
      w.dispatcher.wake();
      await w.settle();
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      await w.advance(70_000);
      expect(w.sent).toHaveLength(1);
    } finally {
      finish(w);
    }
  });

  test("the unreadable store is asked about on a pace and not in a loop: a bounded number of reads over five minutes", async () => {
    const w = await world();
    try {
      await queued(w, ["a", "b"]);
      reload(w, "getItem");
      // ADAPTED, revision 33: an observation of an unreadable store is one refused read of the first directory, so the reads counted are
      // the observations made (formerly the uses of the listing's length).
      let gets = 0;
      const getItem = w.markerStorage.getItem.bind(w.markerStorage);
      w.markerStorage.getItem = (k) => {
        gets += 1;
        return getItem(k);
      };
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(300_000);
      expect(w.sent).toHaveLength(0);
      // Two drafts, two operations each, a handful of looks: nothing proportional to the time that passed.
      expect(gets).toBeLessThan(120);
      expect(gets).toBeGreaterThan(0);
    } finally {
      finish(w);
    }
  });
});

describe("controls: the stops and the permissions that were already right", () => {
  for (const kind of KINDS)
    test(`the durable counter holds the stop with the markers ${kind} unreadable (and readable): nothing is sent, and the retry sends once`, async () => {
      const w = await world();
      try {
        await queued(w);
        await streakStop(w);
        reload(w, kind);
        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        expect(w.sent).toHaveLength(0);
        readable(w);
        w.dispatcher.wake();
        await w.settle();
        await w.advance(70_000);
        expect(w.sent).toHaveLength(0);
        w.outbox.retry("a");
        await w.settle();
        await w.advance(10_000);
        expect(w.sent.map((s) => s.key)).toEqual(["a"]);
        expect(w.sync().local_write_streaks).toEqual({});
      } finally {
        finish(w);
      }
    });

  test("a marker that is readable holds the draft (the control of the cold schedule), and the retry lifts it", async () => {
    const w = await world();
    try {
      await queued(w);
      await markerStop(w);
      reload(w, "readable");
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
    } finally {
      finish(w);
    }
  });

  test("a healthy page sends at once, reads values only at the directories' fixed addresses (adapted, revisions 33 and 34), walks the keys once for each look and leaves nothing waiting", async () => {
    const w = await world();
    try {
      await queued(w);
      reload(w, "readable");
      const asked: string[] = [];
      const getItem = w.markerStorage.getItem.bind(w.markerStorage);
      w.markerStorage.getItem = (k) => {
        asked.push(k);
        return getItem(k);
      };
      const listed = w.markerStorage.enumerations;
      w.online = true;
      w.start();
      await w.settle();
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      // No marker stands, so no value but the directories' addresses is read (R55). ADAPTED, revision 34: the origin's keys are walked
      // too (the listing is the second witness), and a walk reads no value.
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((k) => k.startsWith(DIRECTORY_PREFIX))).toBe(true);
      expect(w.markerStorage.enumerations).toBeGreaterThan(listed);
      expect(w.dispatcher.state.get().kind).toBe("idle");
    } finally {
      finish(w);
    }
  });

  // ADAPTED, revision 33: a failure that is listed and whose own key cannot be read makes ITS operation unknown and no other, so the
  // markers of other operations (their keys unreadable) do not hold this draft; a directory that cannot be read says nothing of any
  // operation, and the draft is held (next test).
  for (const kind of ["marker"] as const)
    test(`markers of OTHER operations do not hold the draft while only their ${kind} keys cannot be read: exact-operation isolation`, async () => {
      const w = await world();
      try {
        await queued(w, ["a", "b"]);
        const other = w.markerStorage.page("prior-page");
        plantMarker(other.storage, account(w), "draft:unrelated", "other.1");
        plantMarker(other.storage, account(w), "page:elsewhere", "other.2");
        plantMarker(other.storage, account(w), "receipt:unrelated", "other.3");
        reload(w, kind);
        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        expect(w.sent.map((s) => s.key).sort()).toEqual(["a", "b"]);
        expect(raw(w, "draft:unrelated")).toBe(true);
      } finally {
        finish(w);
      }
    });

  // ADAPTED, revision 34. Revision 33 sent draft b while the origin's listing was refused, because no read depended on the listing (R55).
  // The listing is the second witness now: draft a is still held (its directory names its marker, a witness that can be read), but
  // nothing can be said of draft b without the listing (a marker may stand that no directory lists), so b is held back as unreadable
  // and goes out once, when a listing lands. The old intent is kept: a stop that can be found is honoured, and the other draft is not
  // held by it for ever.
  test("the stopped draft is held and the other one waits, instead of being sent, while the listing of the origin is refused; it goes out once when a listing lands", async () => {
    const w = await world();
    try {
      await queued(w, ["a", "b"]);
      await markerStop(w, "a");
      reload(w, "readable");
      w.markerStorage.forbidEnumeration = true;
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      expect(raw(w, "draft:a")).toBe(true);
      w.markerStorage.forbidEnumeration = false;
      await w.advance(70_000);
      expect(w.sent.map((s) => s.key)).toEqual(["b"]);
      expect(raw(w, "draft:a")).toBe(true);
    } finally {
      finish(w);
    }
  });
});

describe("exact-operation isolation when the listing cannot be made (adapted, revision 32)", () => {
  test("markers of OTHER operations are listed as theirs when the store can be listed, and when it cannot nothing is sent for either draft until a listing lands", async () => {
    const w = await world();
    try {
      await queued(w, ["a", "b"]);
      const other = w.markerStorage.page("prior-page");
      plantMarker(other.storage, account(w), "draft:unrelated", "other.1");
      reload(w, "directory");
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      readable(w);
      await w.advance(70_000);
      expect(w.sent.map((s) => s.key).sort()).toEqual(["a", "b"]);
      expect(raw(w, "draft:unrelated")).toBe(true);
    } finally {
      finish(w);
    }
  });
});

describe("recovery: what lifts a stop whose record cannot be read, and what does not", () => {
  // ADAPTED, revision 30 (separately labelled, for the reviewer to accept or reject). Revision 29 let the person's retry, and the draft's
  // own success, lift a stop whose marker could not be read, because a removal that returned was kept as the page's "evidence" that the
  // key was gone. The review of revision 29 showed the consequence (see "an older recovery, then another page's NEW stop" below): a
  // recovery establishes absence AT that moment, and the page that admits the draft later cannot tell a marker another page wrote since.
  // The intent of each test is kept (the person's retry, the retry of all, the retry of another draft, a removal that throws, the
  // draft's own edit): the act still removes exactly its record, and the draft goes out ONCE when a read LANDS and finds nothing there.
  test("(adapted) the person's retry of the draft removes the record it can name; made while the store cannot be listed it names nothing, and the retry made when a listing lands sends the draft once", async () => {
    const w = await world();
    try {
      await queued(w);
      await markerStop(w);
      reload(w, "getItem");
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      expect(w.markers.probe(scopeOf(account(w)), "draft:a")).toBe("unknown");
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      // ADAPTED, revision 32 (R52, R53). The retry could not name the record (nothing could be listed when the person asked), and the
      // failure that stands when a listing lands may be one that is newer than the person's decision, which the act is not entitled to
      // end. So it removes nothing: the stop stands and nothing is sent, as before. The retry made when a listing lands names the
      // failure that stands and ends it; the draft goes out once.
      expect(raw(w, "draft:a")).toBe(true);
      expect(w.markers.probe(scopeOf(account(w)), "draft:a")).toBe("unknown");
      expect(w.sent).toHaveLength(0);
      expect(w.dispatcher.state.get().kind).toBe("stopped");
      readable(w);
      await w.advance(70_000);
      expect(w.sent).toHaveLength(0);
      expect(raw(w, "draft:a")).toBe(true);
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(raw(w, "draft:a")).toBe(false);
    } finally {
      finish(w);
    }
  });

  test("(adapted) the facade's retry before the dispatcher has started (the review's schedule): it cannot name the record of a draft nothing here has read; the draft is held until a listing lands, and the retry made then sends it once", async () => {
    const w = await world();
    try {
      await queued(w);
      await markerStop(w);
      reload(w, "getItem");
      w.outbox.retry("a");
      await w.settle();
      // ADAPTED, revision 32: nothing could be listed when the retry was made, so it named and removed nothing (see the test above).
      expect(raw(w, "draft:a")).toBe(true);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      readable(w);
      await w.advance(70_000);
      expect(w.sent).toHaveLength(0);
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(raw(w, "draft:a")).toBe(false);
    } finally {
      finish(w);
    }
  });

  test("connectivity lost and regained while the draft is held asks for no new claim: the draft stays out of the candidates", async () => {
    const w = await world();
    try {
      await queued(w);
      reload(w, "getItem");
      w.online = true;
      w.start();
      await w.settle();
      const claims = (): number =>
        w.env.world.logs.filter(
          (e) => e.type === "idb.commit" && e.label === "data.markInFlight",
        ).length;
      expect(claims()).toBe(1);
      w.online = false;
      w.fire();
      w.goOnline();
      await w.settle();
      expect(claims()).toBe(1);
      expect(w.sent).toHaveLength(0);
    } finally {
      finish(w);
    }
  });

  test("(adapted) the retry of ALL drafts removes the records it can name; the draft with none goes when a listing lands, and the retry made then lifts the other", async () => {
    const w = await world();
    try {
      await queued(w, ["a", "b"]);
      await markerStop(w, "a");
      reload(w, "getItem");
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      w.outbox.retry();
      await w.settle();
      await w.advance(10_000);
      // ADAPTED, revision 32: the retry could not name the record of `a` (nothing could be listed), so it stands; `b` has none, and the
      // listing that lands releases it.
      expect(raw(w, "draft:a")).toBe(true);
      expect(w.sent).toHaveLength(0);
      readable(w);
      await w.advance(70_000);
      expect(w.sent.map((s) => s.key)).toEqual(["b"]);
      w.outbox.retry();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent.map((s) => s.key).sort()).toEqual(["a", "b"]);
      expect(raw(w, "draft:a")).toBe(false);
    } finally {
      finish(w);
    }
  });

  test("(adapted) the retry of ANOTHER draft lifts nothing of this one: its own record stands, and only the retried draft goes when a read lands", async () => {
    const w = await world();
    try {
      await queued(w, ["a", "b"]);
      await markerStop(w, "a");
      reload(w, "getItem");
      w.online = true;
      w.start();
      await w.settle();
      w.outbox.retry("b");
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      expect(raw(w, "draft:a")).toBe(true);
      readable(w);
      await w.advance(70_000);
      // `b`'s record was removed and no read finds a stop for it; `a` is read now, and its marker (never removed) holds it.
      expect(w.sent.map((s) => s.key)).toEqual(["b"]);
      expect(raw(w, "draft:a")).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("(adapted) a retry whose removal THROWS is no recovery: the record stands; a retry that can remove it sends the draft once", async () => {
    const w = await world();
    try {
      await queued(w);
      await markerStop(w);
      // ADAPTED, revision 32: the store can be listed, so the retry names the record and tries to remove it; the removal is what throws
      // (revision 31 made the reads fail as well, which now means the retry names nothing: see the tests above).
      reload(w, "readable");
      const removeItem = w.markerStorage.removeItem.bind(w.markerStorage);
      w.markerStorage.removeItem = () => {
        throw new DOMException("refused", "SecurityError");
      };
      w.online = true;
      w.start();
      await w.settle();
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      expect(raw(w, "draft:a")).toBe(true);
      w.markerStorage.removeItem = removeItem;
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      expect(raw(w, "draft:a")).toBe(false);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
    } finally {
      finish(w);
    }
  });

  // ADAPTED, revision 31 (separately labelled, for the reviewer to accept or reject). Revisions 28 to 30 removed the record blind when
  // the draft's own edit succeeded, however little the page could read. A page built while the store cannot be read has read nothing: it
  // cannot name the marker that stands, and a success that is delivered later cannot show that the marker it finds then predates the
  // write (R50: another page may have recorded a NEWER stop meanwhile, which only a name can tell from this one). So the edit does not
  // end the stop; the person's "Try again" does, and the draft then goes once, edited, when a read lands. The same page that HAD read
  // the marker (its facade listed it while the store was healthy) ends it by name: see the schedules below.
  test("(adapted, revision 31) a page that never read the marker: the draft's OWN successful edit cannot end it; the draft is held, and the person's retry then lets it go, edited, once a read lands", async () => {
    const w = await world();
    try {
      await queued(w);
      await markerStop(w);
      reload(w, "getItem");
      expect(
        (await w.outbox.editQueued("a", request("a", "edited"))).kind,
      ).toBe("edited");
      await w.settle();
      expect(raw(w, "draft:a")).toBe(true);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      readable(w);
      await w.advance(70_000);
      // The record is read now: it is a stop, and the edit did not end it.
      expect(w.sent).toHaveLength(0);
      expect(raw(w, "draft:a")).toBe(true);
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      expect(raw(w, "draft:a")).toBe(false);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(w.sent[0]?.body).toContain("edited");
    } finally {
      finish(w);
    }
  });

  // ADAPTED, revision 32 (R52). The isolation this test showed (the receipt's key cannot be read while the draft's own can) came from reading
  // each operation's marker by its own key. A marker is now read by listing the account's keys, which answers for every operation at once or
  // for none, so a store that cannot be listed leaves the draft's own operation unknown too, and a queued draft is held like a resent one
  // until a listing lands. What is kept: nothing is sent while the draft's own operation cannot be read, nothing is needed beyond a
  // listing that finds no marker to send it, and a receipt marker that a listing DOES find holds it (no other way to know).
  test("a queued draft whose store cannot be listed is held, and goes once a listing lands and finds neither of its operations marked", async () => {
    const w = await world();
    try {
      await queued(w);
      reload(w, "readable");
      unreadable(w, "getItem");
      expect(w.markers.probe(scopeOf(account(w)), "draft:a")).toBe("unknown");
      expect(w.markers.probe(scopeOf(account(w)), "receipt:a")).toBe("unknown");
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      readable(w);
      await w.advance(70_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
    } finally {
      finish(w);
    }
  });

  test("abandoning the draft ends its operations, sends nothing, and leaves no marker of either", async () => {
    const w = await world();
    try {
      await queued(w);
      await markerStop(w);
      // ADAPTED, revision 32: the page can list the store, so the discard names the markers that stand and removes them. (With the store
      // unreadable it names nothing and the stale marker stands until a listing lands and the person's retry ends it: the next test.)
      reload(w, "readable");
      expect((await w.outbox.discard("a")).kind).toBe("discarded");
      await w.settle();
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      expect(raw(w, "draft:a")).toBe(false);
      expect(w.drafts()).toHaveLength(0);
    } finally {
      finish(w);
    }
  });

  // RETIRED, revision 33: "the marker of an earlier build (it names no instance) ends with an abandonment". A key written before keys named
  // their failure (and before they named their database's lifetime) is not read by anything, so there is no such marker to end; the card is
  // new and nothing of the earlier formats has shipped (the review of revision 32 requires no migration). Its replacement is the control
  // that a key of ANOTHER lifetime is not this lifetime's marker (`marker-lifetime.test.ts`).

  test("abandoning the draft while the store cannot be listed removes nothing it cannot name: the draft is gone, its stale marker stands until a listing lands and a retry ends it", async () => {
    const w = await world();
    try {
      await queued(w);
      await markerStop(w);
      reload(w, "getItem");
      expect((await w.outbox.discard("a")).kind).toBe("discarded");
      await w.settle();
      expect(w.drafts()).toHaveLength(0);
      expect(raw(w, "draft:a")).toBe(true);
      readable(w);
      w.outbox.retry();
      await w.settle();
      expect(raw(w, "draft:a")).toBe(false);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
    } finally {
      finish(w);
    }
  });
});

/**
 * R47 (revision 30): an OLDER recovery is no proof about a NEWER stop. The review of revision 29 enqueued a draft offline, persisted its
 * stop, made the marker reads fail, completed `outbox.retry("a")` (the removal returned), and then had ANOTHER page write a new
 * `draft:a` marker with its notification held before dispatch resumed: the dispatcher claimed, sent and acknowledged the draft while the
 * stop remained `1`. The retry completed BEFORE the new stop, so it cannot justify issuing through it, and the page cannot tell it from
 * "no new stop" unless a read lands: the answer there is `unknown`, and the draft is held. The same holds for the other recoveries (the
 * draft's own successful edit). The notification is not what protects: the delivered, held and unreadable-then-readable schedules all
 * hold a draft that has a newer stop, and only a read that finds nothing sends it.
 */
describe("an older recovery, then another page's NEW stop (R47, revision 30)", () => {
  type Schedule = {
    /** Another page writes a NEW marker for the draft after the recovery. */
    newMarker: boolean;
    /** The `storage` notification of that write reaches this page before the draft is admitted. */
    delivered: boolean;
    /** The store can be read when the draft is admitted. */
    readableThen: boolean;
    /**
     * The dispatcher is already RUNNING (waiting, the page offline) when the recovery completes, as a production page's is; otherwise it
     * starts after the recovery. A dispatcher that kept a memory of the recovery of its own (the retry reaches it) is only shown by the
     * first.
     */
    running?: boolean;
  };
  const recover = {
    "the person's retry": async (w: OutboxWorld) => {
      w.outbox.retry("a");
      await w.settle();
    },
    "the draft's own successful edit": async (w: OutboxWorld) => {
      expect(
        (await w.outbox.editQueued("a", request("a", "edited"))).kind,
      ).toBe("edited");
      await w.settle();
    },
  } as const;

  async function schedule(
    w: OutboxWorld,
    by: keyof typeof recover,
    { newMarker, delivered, readableThen, running = false }: Schedule,
  ): Promise<void> {
    await queued(w);
    await markerStop(w);
    // The page that recovers listens to the storage of the other pages, as a production page does.
    reload(w, "readable", pageMarkers(w.markerStorage));
    await w.settle();
    unreadable(w, "getItem");
    if (running) {
      w.start();
      await w.settle();
    }
    await recover[by](w);
    // The person's retry removed the record, and so did the draft's own success: the page named the instance only because its facade
    // listed it earlier, and the removal of a key that names its failure needs no read (ADAPTED, revision 32: revision 31 owed the
    // success's removal to the first read that landed, because it had to compare a shared value first; see `marker-exact-keys.test.ts`).
    expect(raw(w, "draft:a")).toBe(false);
    if (!delivered) w.markerStorage.hold();
    if (newMarker)
      plantMarker(
        w.markerStorage.page("another-tab").storage,
        account(w),
        "draft:a",
        "other.9",
      );
    if (readableThen) readable(w);
    w.online = true;
    if (running) w.goOnline();
    else w.start();
    await w.settle();
    await w.advance(10_000);
  }

  for (const by of Object.keys(recover) as Array<keyof typeof recover>)
    for (const running of [false, true]) {
      const how = running ? " (the dispatcher is already running)" : "";
      test(`${by}, then a NEW stop whose notification is held and nothing can be read: nothing is sent, the new stop stands${how}`, async () => {
        const w = await world();
        try {
          await schedule(w, by, {
            newMarker: true,
            delivered: false,
            readableThen: false,
            running,
          });
          expect(w.sent).toHaveLength(0);
          expect(raw(w, "draft:a")).toBe(true);
          expect(w.dispatcher.state.get()).toEqual({
            kind: "stopped",
            cause: "local_storage",
          });
          // The store comes back: the NEW stop is read, and still holds the draft (it is a stop, not an unknown), until the person lifts it.
          w.markerStorage.release();
          readable(w);
          await w.advance(70_000);
          expect(w.sent).toHaveLength(0);
          expect(raw(w, "draft:a")).toBe(true);
          w.outbox.retry("a");
          await w.settle();
          await w.advance(10_000);
          expect(w.sent.map((s) => s.key)).toEqual(["a"]);
          expect(raw(w, "draft:a")).toBe(false);
        } finally {
          finish(w);
        }
      });

      test(`${by}, then a NEW stop whose notification is delivered and nothing can be read: nothing is sent${how}`, async () => {
        const w = await world();
        try {
          await schedule(w, by, {
            newMarker: true,
            delivered: true,
            readableThen: false,
            running,
          });
          expect(w.sent).toHaveLength(0);
          expect(raw(w, "draft:a")).toBe(true);
        } finally {
          finish(w);
        }
      });

      test(`${by}, then a NEW stop that can be read (the notification is held): nothing is sent${how}`, async () => {
        const w = await world();
        try {
          await schedule(w, by, {
            newMarker: true,
            delivered: false,
            readableThen: true,
            running,
          });
          expect(w.sent).toHaveLength(0);
          expect(raw(w, "draft:a")).toBe(true);
        } finally {
          finish(w);
        }
      });

      test(`${by}, then NO new stop and nothing can be read: it cannot be told from the schedules above, so nothing is sent; the draft goes when a read lands${how}`, async () => {
        const w = await world();
        try {
          await schedule(w, by, {
            newMarker: false,
            delivered: false,
            readableThen: false,
            running,
          });
          expect(w.sent).toHaveLength(0);
          expect(w.dispatcher.state.get()).toEqual({
            kind: "stopped",
            cause: "local_storage",
          });
          readable(w);
          await w.advance(70_000);
          expect(w.sent.map((s) => s.key)).toEqual(["a"]);
        } finally {
          finish(w);
        }
      });

      test(`${by}, then NO new stop and it can be read: the draft is sent once (the person's recovery is intact)${how}`, async () => {
        const w = await world();
        try {
          await schedule(w, by, {
            newMarker: false,
            delivered: false,
            readableThen: true,
            running,
          });
          expect(w.sent.map((s) => s.key)).toEqual(["a"]);
          expect(raw(w, "draft:a")).toBe(false);
        } finally {
          finish(w);
        }
      });
    }

  // The dispatcher's own retry reaches a draft only when the dispatcher had stalled it (its marker was read and stands). It then removes
  // the marker it named, and nothing the dispatcher kept of that removal may stand for evidence about a newer stop (R47, revision 30).
  // The facade's retry in the schedules above does not exercise it: a dispatcher started while the store cannot be listed holds the draft
  // as unknown, and a retry made then names nothing (revision 32).
  test("the dispatcher keeps no memory of the person's retry: a draft it stalled is retried, the store then cannot be listed and another page records a NEW stop: nothing is sent", async () => {
    const w = await world();
    try {
      await queued(w);
      await markerStop(w);
      reload(w, "readable", pageMarkers(w.markerStorage));
      await w.settle();
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      expect(w.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "local_storage",
      });
      // The retry names the marker the dispatcher read, while the store can be listed; what follows happens while it waits on the
      // database: the store stops being listable and another page records a NEW stop.
      w.dispatcher.retry("a");
      unreadable(w, "getItem");
      plantMarker(
        w.markerStorage.page("another-tab").storage,
        account(w),
        "draft:a",
        "other.9",
      );
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      expect(w.markers.probe(scopeOf(account(w)), "draft:a")).toBe("unknown");
      readable(w);
      await w.advance(70_000);
      expect(w.sent).toHaveLength(0);
      expect(raw(w, "draft:a")).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("what the page can observe is the SAME with and without the new stop (the schedules differ only in a record it cannot read and a notification it has not heard), and so is what it does", async () => {
    const run = async (newMarker: boolean) => {
      const w = await world();
      try {
        await schedule(w, "the person's retry", {
          newMarker,
          delivered: false,
          readableThen: false,
        });
        return {
          raw: raw(w, "draft:a"),
          seen: {
            sent: w.sent.length,
            state: w.dispatcher.state.get(),
            probe: w.markers.probe(scopeOf(account(w)), "draft:a"),
            warning: w.outbox.storageNotResponding.get(),
          },
        };
      } finally {
        finish(w);
      }
    };
    const withNew = await run(true);
    const without = await run(false);
    expect(withNew.raw).toBe(true);
    expect(without.raw).toBe(false);
    expect(withNew.seen).toEqual(without.seen);
    expect(withNew.seen.sent).toBe(0);
  });
});

describe("a draft that was sent without an answer is asked about its receipt as well", () => {
  // ADAPTED, revision 32 (R52): see the note on the queued draft above. The receipt cannot be unreadable while the draft's own marker is
  // read, because both are read by one listing. A resend is held while the store cannot be listed (both operations are unknown), and it
  // goes out once a listing lands and finds neither of them marked; a receipt marker that a listing finds holds it.
  test("(adapted) a resend is held while the store cannot be listed, and goes out once it can", async () => {
    const w = await world();
    try {
      await queued(w);
      w.online = true;
      w.script.push(new Error("network down"));
      w.start();
      await w.settle();
      expect(w.sent).toHaveLength(1);
      expect(w.drafts()[0]?.status).toBe("in_flight");
      reload(w, "readable");
      unreadable(w, "getItem");
      expect(w.markers.probe(scopeOf(account(w)), "draft:a")).toBe("unknown");
      expect(w.markers.probe(scopeOf(account(w)), "receipt:a")).toBe("unknown");
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(120_000);
      // The first request is the only one: a resend would need both operations to be known not to stand.
      expect(w.sent).toHaveLength(1);
      readable(w);
      w.dispatcher.wake();
      await w.settle();
      await w.advance(120_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a", "a"]);
    } finally {
      finish(w);
    }
  });

  /**
   * The dispatcher's own rule, asked of the markers port (revision 32). `probe` answers per operation, and this port says `unknown` for
   * the receipt operations while `state.unknown` is set and as the real markers do for every other. The production markers never
   * produce that mixture (one listing answers for both operations of a draft, so a store that cannot be listed is unknown for both),
   * so these cases pin the RULE against the port's contract and not a storage state: a queued draft is asked about its own operation
   * alone, and a draft already `in_flight` about both.
   */
  function receiptsUnknown(real: ReturnType<typeof createWriteFailureMarkers>) {
    const state = { unknown: true };
    const markers = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== "probe") return Reflect.get(target, prop, receiver);
        return (accountId: string, operation: string) =>
          state.unknown && operation.startsWith("receipt:")
            ? "unknown"
            : target.probe(scopeOf(accountId), operation);
      },
    });
    return { markers, state };
  }

  test("a QUEUED draft is asked about its own operation alone: a receipt marker that cannot be read does not hold it (the success of its own edit is enough)", async () => {
    const w = await world();
    try {
      await queued(w);
      const { markers } = receiptsUnknown(pageMarkers(w.markerStorage));
      reload(w, "readable", markers);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(markers.probe(scopeOf(account(w)), "receipt:a")).toBe("unknown");
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
    } finally {
      finish(w);
    }
  });

  test("a resend of an `in_flight` draft is asked about its receipt's marker as well: the draft is held while only that cannot be read, and goes when it can", async () => {
    const w = await world();
    try {
      await queued(w);
      w.online = true;
      w.script.push(new Error("network down"));
      w.start();
      await w.settle();
      expect(w.sent).toHaveLength(1);
      expect(w.drafts()[0]?.status).toBe("in_flight");
      const { markers, state } = receiptsUnknown(pageMarkers(w.markerStorage));
      reload(w, "readable", markers);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(120_000);
      expect(markers.probe(scopeOf(account(w)), "draft:a")).toBe("unmarked");
      expect(w.sent).toHaveLength(1);
      state.unknown = false;
      w.dispatcher.wake();
      await w.settle();
      await w.advance(120_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a", "a"]);
    } finally {
      finish(w);
    }
  });

  test("a receipt marker that a listing finds holds the resend, and the person's retry lifts it", async () => {
    const w = await world();
    try {
      await queued(w);
      w.online = true;
      w.script.push(new Error("network down"));
      w.start();
      await w.settle();
      expect(w.sent).toHaveLength(1);
      plantMarker(
        w.markerStorage.page("another-tab").storage,
        account(w),
        "receipt:a",
        "tab.1",
      );
      reload(w, "readable");
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(120_000);
      expect(w.sent).toHaveLength(1);
      w.outbox.retry("a");
      await w.settle();
      await w.advance(120_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a", "a"]);
      expect(raw(w, "receipt:a")).toBe(false);
    } finally {
      finish(w);
    }
  });
});

describe("a page whose storage getter threw when it was built (the production default path)", () => {
  test("holds the draft while the getter throws and sends nothing; access restored, the same markers find the marker and keep the stop", async () => {
    const w = await world();
    try {
      await queued(w);
      await markerStop(w);
      const markers = withGlobalStorage("throws", () =>
        createWriteFailureMarkers(),
      );
      const restore = setGlobalStorage("throws");
      try {
        reload(w, "readable", markers);
        expect(w.markers.probe(scopeOf(account(w)), "draft:a")).toBe("unknown");
        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        expect(w.sent).toHaveLength(0);
        expect(w.dispatcher.state.get().kind).toBe("stopped");
      } finally {
        restore();
      }
      const again = setGlobalStorage(w.markerStorage);
      try {
        w.dispatcher.wake();
        await w.settle();
        await w.advance(70_000);
        // The marker is there and is now read: the stop stands, as for any page that can read it.
        expect(w.markers.probe(scopeOf(account(w)), "draft:a")).toBe("marked");
        expect(w.sent).toHaveLength(0);
        w.outbox.retry("a");
        await w.settle();
        await w.advance(10_000);
        expect(w.sent.map((s) => s.key)).toEqual(["a"]);
        expect(raw(w, "draft:a")).toBe(false);
      } finally {
        again();
      }
    } finally {
      finish(w);
    }
  });

  test("with NO marker, the same page sends the draft once the getter stops throwing, without anyone's act", async () => {
    const w = await world();
    try {
      await queued(w);
      const markers = withGlobalStorage("throws", () =>
        createWriteFailureMarkers(),
      );
      const restore = setGlobalStorage("throws");
      try {
        reload(w, "readable", markers);
        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        expect(w.sent).toHaveLength(0);
      } finally {
        restore();
      }
      const again = setGlobalStorage(w.markerStorage);
      try {
        await w.advance(70_000);
        expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      } finally {
        again();
      }
    } finally {
      finish(w);
    }
  });
});
