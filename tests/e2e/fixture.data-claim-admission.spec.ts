import type { BrowserContext, Page } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  arm,
  boot,
  edit,
  hits,
  holdStorageEvents,
  incarnationOf,
  install,
  installMarkerReadFaults,
  installStorageHold,
  type MarkerReads,
  markerEventCounts,
  markerInstances,
  markerReads,
  markers,
  NO_READ_FAULTS,
  outboxState,
  plantMarkerOn,
  queue,
  releaseStorageEvents,
  statusOf,
  streaks,
  warning,
} from "./data-local-faults";
import {
  type OutboxReadiness,
  untilDraftWriteCommitted,
  withSettledOutboxPeers,
} from "./data-operation-barriers";
import {
  ACCOUNT,
  bootSession,
  dataPage,
  startOutbox,
  untilTreeSettled,
  uuid,
} from "./data-sync-helpers";
import {
  type HeldCall,
  type HeldOperations,
  type Hold,
  withHeldOperations,
} from "./held-operation";
import { expect, test } from "./helpers";

/**
 * E-O10 (revision 28, R46 and R47): a stop admits no send, whenever it was recorded, and an unreadable marker is unknown, not empty, in a
 * real engine.
 *
 * The production outbox facade, plans, dispatcher, Dexie adapter and fallback markers over REAL IndexedDB and the page's REAL
 * `localStorage`, through the production session's stamped wrapper, with the network stubbed by `page.route`.
 *
 * R46. The dispatcher reads the queue, then claims the draft it picked and issues the request. The independent review (revision 27)
 * held the answer of the queue read, made the facade's edit of the draft fail by each of the three stop mechanisms (three counted
 * failures; the counter and then the marker unwritable; neither, so the page's memory holds it) and released the answer: the claim ended
 * the stop in the transaction that claimed the draft, released the memory stop and the marker as its "own success", and the draft was sent
 * (three failing cases in each of three engines). Here the same schedule holds the answer of the dispatcher's queue read through the
 * fixture (`holdOutboxPlan`), and asserts that nothing is sent, that the stop is EXACTLY as it was recorded (count, marker and memory),
 * that the draft is queued and untouched, and that the person's retry or the operation's own success still lifts it.
 *
 * R47. The review made the page's `localStorage` unreadable (a `SecurityError`) after a marker-backed stop had been shown: an unrelated
 * save of another draft hid the warning and the dispatcher sent the stopped draft (three engines). Here the enumeration (`length` and
 * `key`), the individual read (`getItem` of a marker's key) and both are made to throw, independently, for each mechanism.
 *
 * FIXTURE evidence for this engine on this machine: the HTTP answers are scripted inputs, not the released backend's, the dispatcher is
 * the fixture's test leader (production starts none until WEB-09b), the faults are installed by the spec (a throwing `put` of one
 * draft's row, a throwing write of the failure's counter, a refused marker `setItem`, throwing reads of `localStorage`), and no real
 * failing disk, unreadable storage or full origin is produced. The page is OFFLINE while a draft is queued, so the saved work is held
 * until the case lets it go.
 */
const A = uuid(51);
const B = uuid(52);

type Mechanism = "streak" | "marker" | "memory";
const MECHANISMS: Mechanism[] = ["streak", "marker", "memory"];
const faultFor = (mechanism: Mechanism) => ({
  armed: mechanism === "streak" ? 3 : 1,
  counter: mechanism === "streak" ? 0 : 1,
  markers: mechanism === "memory" ? 1 : 0,
});
/**
 * ADAPTED, revision 33 (R55): a marker is found by reading the directories' fixed addresses and the key of each failure they list, and the
 * origin's keys are never listed. A read can fail for the directories (`directory`), for the listed failure's own key (`marker`: that
 * operation, and no other, is then unknown) or for every key (`getItem`).
 */
type Unreadable = "directory" | "marker" | "getItem" | "directory-only";
const KINDS: Unreadable[] = ["directory", "marker", "getItem"];
// ADAPTED, revision 34. A failure is also found by the LISTING of the origin's keys now, so "the directories cannot be read" no longer
// leaves the marker unreadable by itself: `directory` here means that neither witness can name it (the directories and the listing are
// both refused), which is the situation these cases protect. The case in which only the directories fail is its own (below).
const readsOf = (kind: Unreadable): MarkerReads => ({
  enumeration: kind === "directory",
  getItem: kind === "getItem",
  directory: kind === "directory" || kind === "directory-only",
  key: kind === "marker",
});

const enqueue = (page: Page, localId: string, target: string, label: string) =>
  page.evaluate(
    (spec) => window.__atlasData?.enqueue(spec),
    edit(target, localId, label),
  );
const editDraft = (page: Page, id: string, target: string, label: string) =>
  page.evaluate(
    ({ id: draft, spec }) => window.__atlasData?.editQueued(draft, spec),
    { id, spec: edit(target, id, label) },
  );
const untilState = (page: Page, kind: string) =>
  expect
    .poll(async () => (await outboxState(page))?.kind, { timeout: 20_000 })
    .toBe(kind);
const untilWarning = (
  page: Page,
  notResponding: boolean,
  memoryOnly: boolean,
) =>
  expect
    .poll(async () => await warning(page), { timeout: 20_000 })
    .toEqual({ notResponding, memoryOnly });
const untilStatus = (page: Page, id: string, status: string) =>
  expect.poll(() => statusOf(page, id), { timeout: 20_000 }).toBe(status);
const untilLanded = (page: Page, text: string) =>
  untilDraftWriteCommitted(page, ACCOUNT, text);
/** The state stays `stopped` and nothing is sent while the page is observed, however the dispatcher is woken meanwhile. */
async function staysHeld(
  page: Page,
  net: { commands: unknown[] },
  allowed = 0,
): Promise<void> {
  for (let sample = 0; sample < 12; sample += 1) {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    expect((await outboxState(page))?.kind).toBe("stopped");
    expect(net.commands).toHaveLength(allowed);
    await page.waitForTimeout(50);
  }
}
/**
 * Nothing is sent while the page is observed, however the dispatcher is woken meanwhile, and the dispatcher ends up stopped. Unlike
 * `staysHeld` it does not assert the state at every sample: after a person's retry the dispatcher passes through `waiting` while the retry
 * resumes it (a transient of the retry, not a send), and the case is about what is sent.
 */
async function staysUnsent(
  page: Page,
  net: { commands: unknown[] },
  allowed = 0,
): Promise<void> {
  for (let sample = 0; sample < 12; sample += 1) {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    expect(net.commands).toHaveLength(allowed);
    await page.waitForTimeout(50);
  }
  await expect
    .poll(async () => (await outboxState(page))?.kind, { timeout: 10_000 })
    .toBe("stopped");
  expect(net.commands).toHaveLength(allowed);
}
/** The facade's own write of `id` fails by `mechanism`, `armed` times: the stop is recorded by the facade, the other writer. */
async function facadeStop(
  page: Page,
  mechanism: Mechanism,
  id: string,
  target: string,
): Promise<void> {
  const faults = faultFor(mechanism);
  await arm(page, { id, ...faults });
  for (let i = 0; i < faults.armed; i += 1)
    expect(await editDraft(page, id, target, "unsaved")).toMatchObject({
      kind: "refused",
      reason: "storage",
    });
  await untilWarning(page, true, mechanism === "memory");
}
/** Another page with its own running outbox (no dispatcher: it never sends) over the same database and `localStorage`. */
async function anotherOutbox(context: BrowserContext): Promise<Page> {
  const page = await bootSession(context);
  await untilTreeSettled(page, { connections: 0 });
  await startOutbox(page, ACCOUNT, { start: false });
  await untilTreeSettled(page, { connections: 2 });
  await install(page);
  return page;
}
const standing = async (page: Page, id: string) => ({
  streak: (await streaks(page))[`draft:${id}`] ?? 0,
  marker: (await markers(page)).includes(`draft:${id}`),
});
const STANDING = (mechanism: Mechanism) => ({
  streak: mechanism === "streak" ? 3 : 0,
  marker: mechanism === "marker",
});

test.describe("E-O10 (revision 28, R46): a stop recorded after the queue read admits no send, in a real engine", () => {
  for (const mechanism of MECHANISMS)
    test(`R46: ${mechanism}: recorded while the queue read is held, the draft is not sent and the stop is exactly as it was recorded`, async ({
      context,
    }, info) => {
      const { net, page } = await boot(context);
      await context.setOffline(true);
      expect((await enqueue(page, A, "r", "original"))?.kind).toBe("queued");
      // Revision 21 (R20-N1): the held queue read is owned by a scope that releases it by its own token on every path.
      const recorded = await withHeldOperations(async (holds) => {
        const read = await holds.holdOutbox(page, "data.readDispatchWindow");
        await context.setOffline(false);
        await read.untilHeld();
        await facadeStop(page, mechanism, A, "r");
        const recorded = {
          standing: await standing(page, A),
          warning: await warning(page),
          hits: await hits(page),
        };
        expect(recorded.standing).toEqual(STANDING(mechanism));
        await read.release();
        return recorded;
      });
      await untilState(page, "stopped");
      await staysHeld(page, net);
      const after = {
        standing: await standing(page, A),
        warning: await warning(page),
        state: await outboxState(page),
        status: await statusOf(page, A),
        sent: net.commands.length,
      };
      recordEvidence(info, `held-${mechanism}`, { recorded, after });
      expect(after.sent).toBe(0);
      expect(after.standing).toEqual(recorded.standing);
      expect(after.warning).toEqual({
        notResponding: true,
        memoryOnly: mechanism === "memory",
      });
      expect(after.status).toBe("queued");
      if (mechanism === "memory")
        expect(after.state).toEqual({
          kind: "stopped",
          cause: "local_storage",
          memoryOnly: true,
        });
    });

  for (const mechanism of MECHANISMS)
    for (const recovery of ["the explicit retry", "the edit's own success"])
      test(`R46: ${mechanism}: after the refusal, ${recovery} lifts the stop and the draft is sent exactly once`, async ({
        context,
      }, info) => {
        const { net, page } = await boot(context);
        await context.setOffline(true);
        expect((await enqueue(page, A, "r", "original"))?.kind).toBe("queued");
        await withHeldOperations(async (holds) => {
          const read = await holds.holdOutbox(page, "data.readDispatchWindow");
          await context.setOffline(false);
          await read.untilHeld();
          await facadeStop(page, mechanism, A, "r");
          await read.release();
        });
        await untilState(page, "stopped");
        await staysHeld(page, net);
        if (recovery === "the explicit retry")
          await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
        else
          expect((await editDraft(page, A, "r", "saved"))?.kind).toBe("edited");
        await untilWarning(page, false, false);
        await untilStatus(page, A, "acknowledged");
        expect(net.commands).toHaveLength(1);
        expect(net.commands[0]?.key).toBe(A);
        expect(net.commands[0]?.body).toContain(
          recovery === "the explicit retry"
            ? '"label":"original"'
            : '"label":"saved"',
        );
        expect(await streaks(page)).toEqual({});
        expect(await markers(page)).toEqual([]);
        recordEvidence(info, `lifted-${mechanism}`, {
          sent: net.commands.map((c) => c.key),
        });
      });

  for (const mechanism of MECHANISMS)
    test(`R46: ${mechanism}: a stop of ANOTHER draft recorded while the queue read is held holds that draft and sends this one`, async ({
      context,
    }, info) => {
      const { net, page } = await boot(context);
      await context.setOffline(true);
      expect((await enqueue(page, A, "r", "first"))?.kind).toBe("queued");
      expect((await enqueue(page, B, "s", "second"))?.kind).toBe("queued");
      await withHeldOperations(async (holds) => {
        const read = await holds.holdOutbox(page, "data.readDispatchWindow");
        await context.setOffline(false);
        await read.untilHeld();
        await facadeStop(page, mechanism, B, "s");
        await read.release();
      });
      await untilStatus(page, A, "acknowledged");
      await untilState(page, "stopped");
      await staysHeld(page, net, 1);
      expect(net.commands.map((c) => c.key)).toEqual([A]);
      expect(await statusOf(page, B)).toBe("queued");
      expect(await standing(page, B)).toEqual(STANDING(mechanism));
      recordEvidence(info, `other-${mechanism}`, {
        sent: net.commands.map((c) => c.key),
      });
    });
});

test.describe("E-O10 (revision 28, R47): an unreadable `localStorage` is unknown, not empty, in a real engine", () => {
  for (const mechanism of MECHANISMS)
    for (const kind of KINDS)
      test(`R47: ${mechanism}, ${kind} unreadable: an unrelated save of another draft for the same resource leaves the warning up and the stopped draft unsent`, async ({
        context,
      }, info) => {
        const { net, page } = await boot(context);
        await installMarkerReadFaults(page);
        await context.setOffline(true);
        expect((await enqueue(page, A, "r", "original"))?.kind).toBe("queued");
        await facadeStop(page, mechanism, A, "r");
        const before = await standing(page, A);
        expect(before).toEqual(STANDING(mechanism));

        await markerReads(page, readsOf(kind));
        expect((await enqueue(page, B, "r", "second"))?.kind).toBe("queued");
        for (let sample = 0; sample < 12; sample += 1) {
          expect(await warning(page)).toEqual({
            notResponding: true,
            memoryOnly: mechanism === "memory",
          });
          await page.waitForTimeout(50);
        }
        // The dispatcher starts and looks at the queue: the stopped draft is held, and the draft behind it waits for it.
        await context.setOffline(false);
        await untilState(page, "stopped");
        await staysHeld(page, net);
        recordEvidence(info, `${mechanism}-${kind}`, {
          warning: await warning(page),
          streaks: await streaks(page),
          hits: await hits(page),
          sent: net.commands.length,
        });
        expect(await statusOf(page, A)).toBe("queued");
        expect(await warning(page)).toEqual({
          notResponding: true,
          memoryOnly: mechanism === "memory",
        });

        // The control the review used: once the page can read again, the person's explicit retry is what lifts the stop.
        await markerReads(page, NO_READ_FAULTS);
        expect(await standing(page, A)).toEqual(before);
        await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
        await untilWarning(page, false, false);
        await untilStatus(page, A, "acknowledged");
        await untilStatus(page, B, "acknowledged");
        expect(net.commands.map((c) => c.key)).toEqual([A, B]);
      });

  // ADAPTED for `both`, revision 30 (separately labelled, for the reviewer to accept or reject). With one way of reading left (the
  // enumeration or the individual read) the new draft's own marker is read and found absent, so it is sent while the stopped draft is
  // held, exactly as before. With NEITHER, revisions 28 and 29 sent it as well: revision 29 took the removal that the draft's own save
  // left (`ended`) as evidence that its marker was gone. That is the evidence the review of revision 29 rejected (another page may have
  // recorded a stop for the draft since, and no read or notification need have said so), so a page that can read nothing holds the new
  // draft like the stopped one and sends it, once, when a read lands: the independent draft is isolated from the stopped one by what is
  // READ about it, never by what the page did earlier.
  for (const kind of KINDS)
    test(`R47: marker, ${kind} unreadable: a draft for an INDEPENDENT resource is sent while the stopped draft is held${kind !== "marker" ? ", once a read lands (adapted, revisions 30 and 33)" : ""}`, async ({
      context,
    }) => {
      const { net, page } = await boot(context);
      await installMarkerReadFaults(page);
      await context.setOffline(true);
      expect((await enqueue(page, A, "r", "original"))?.kind).toBe("queued");
      await facadeStop(page, "marker", A, "r");
      await markerReads(page, readsOf(kind));
      expect((await enqueue(page, B, "s", "second"))?.kind).toBe("queued");
      await context.setOffline(false);
      // ADAPTED, revision 33 (R55): when only the stopped draft's own marker key cannot be read, that operation is unknown and the new
      // draft (whose operations list nothing) goes; when the directories or every key cannot be read, nothing can be said of the new
      // draft either: it is held with the stopped one until a read lands.
      if (kind !== "marker") {
        await untilState(page, "stopped");
        await staysUnsent(page, net);
        await markerReads(page, NO_READ_FAULTS);
      }
      await untilStatus(page, B, "acknowledged");
      await untilState(page, "stopped");
      await staysHeld(page, net, 1);
      expect(net.commands.map((c) => c.key)).toEqual([B]);
      expect(await statusOf(page, A)).toBe("queued");
      expect(await warning(page)).toEqual({
        notResponding: true,
        memoryOnly: false,
      });
    });

  // ADAPTED, revision 30 (separately labelled, for the reviewer to accept or reject). Revision 28 sent the draft here on the strength of
  // the edit's own success while nothing could be read, and revision 29 kept that by treating the removal that returned as evidence
  // that the key was gone. The review of revision 29 showed that an OLDER recovery then overrides a NEWER stop that another page recorded
  // (see "E-O10 (revision 30, R47)" below). The intent is kept: the edit's own success ends exactly its own operation (the marker is
  // removed), and the draft goes out once, edited, as soon as a read LANDS and finds nothing; what is no longer so is that it goes out
  // while nothing can be read.
  test("R47: marker, both unreadable: the draft's OWN successful edit ends the marker (its removal is owed to the first read that lands); the draft is sent once a read lands, edited, and the warning says recovered then (adapted, revision 30 and 31)", async ({
    context,
  }, info) => {
    const { net, page } = await boot(context);
    await installMarkerReadFaults(page);
    await context.setOffline(true);
    expect((await enqueue(page, A, "r", "original"))?.kind).toBe("queued");
    await facadeStop(page, "marker", A, "r");
    await markerReads(page, readsOf("getItem"));
    expect((await editDraft(page, A, "r", "saved"))?.kind).toBe("edited");
    await context.setOffline(false);
    await untilState(page, "stopped");
    await staysHeld(page, net);
    // ADAPTED, revision 32 (R52): this page's facade named the instance when it was written, and the removal of a key that names its
    // failure needs no read, so the edit's success ends it at once (revision 31 owed the removal to the first read that landed, because
    // it had to compare a shared value first). The warning still waits for a read that lands.
    expect(await markers(page)).toEqual([]);
    // A read that could not be made does not say "recovered".
    expect((await warning(page))?.notResponding).toBe(true);
    await markerReads(page, NO_READ_FAULTS);
    await untilStatus(page, A, "acknowledged");
    expect(net.commands).toHaveLength(1);
    expect(net.commands[0]?.body).toContain('"label":"saved"');
    expect(await markers(page)).toEqual([]);
    await page.evaluate(() => window.__atlasData?.retryOutbox("unrelated"));
    await untilWarning(page, false, false);
    recordEvidence(info, "own-success-unreadable", {
      sent: net.commands.map((c) => c.key),
      queue: await queue(page),
    });
  });
});

/**
 * E-O10 (revision 29, R47(b)): a page that RELOADS with the marker of a stopped draft unreadable does not send the draft, in a real engine.
 *
 * The independent review of revision 28 made a draft's edit fail and the recording of that failure fail too, so that only the fallback
 * marker held the stop; then built a FRESH facade and dispatcher while the markers' enumeration and individual reads threw, and brought the
 * page online: the dispatcher asked `has`, which reads "could not read" as "no marker", and sent the draft with no retry, edit or
 * abandonment (three engines), the acknowledgement leaving the raw marker standing. Here the first page records the stop in the REAL
 * `localStorage` and is closed; a SECOND page boots over the same database and `localStorage` with its reads made to throw from its first
 * one (`installMarkerReadFaults`, before the harness outbox starts), so the markers object of that page has read and established nothing.
 * It is the production facade, plans, dispatcher, Dexie adapter and markers, through the production session's stamped wrapper, with the
 * network stubbed by `page.route`.
 *
 * FIXTURE evidence for this engine on this machine: the HTTP answers are scripted inputs, the dispatcher is the fixture's test leader
 * (production starts none until WEB-09b), and the faults (a throwing `put` of the draft's row, a throwing write of the counter, throwing
 * reads of `Storage.prototype`) are installed by the spec: no real unreadable storage or failing disk is produced.
 */
test.describe("E-O10 (revision 29, R47): a page that reloads with a stopped draft's marker unreadable does not send the draft, in a real engine", () => {
  /** The first page records the stop and is closed; the page that replaces it boots with `reads` already failing, and the network returns. */
  async function reload(
    context: BrowserContext,
    first: Page,
    reads: Partial<MarkerReads>,
    start = true,
  ): Promise<Page> {
    await first.close();
    // The page that replaces it has to boot (it needs the network), and it starts its dispatcher with the faults already in force: the
    // network is back from here, which is the moment the dispatcher of a reloaded page first asks what to send.
    await context.setOffline(false);
    const page = await bootSession(context);
    await untilTreeSettled(page, { connections: 0 });
    await installMarkerReadFaults(page);
    await markerReads(page, reads);
    await startOutbox(page, ACCOUNT, { start });
    await untilTreeSettled(page, { connections: 2 });
    await install(page);
    return page;
  }
  const NONE = NO_READ_FAULTS;
  /**
   * The waits of these cases are ASSERTIONS that fail before the test's own timeout (30 s: two page boots take about 10 s of it): a
   * dispatcher that sends what it should hold, or holds what it should send, fails by what it did, not by a wait that outlives the case.
   */
  const untilStopped = (page: Page) =>
    expect
      .poll(async () => (await outboxState(page))?.kind, { timeout: 10_000 })
      .toBe("stopped");
  const untilSent = (page: Page, id: string) =>
    expect
      .poll(() => statusOf(page, id), { timeout: 12_000 })
      .toBe("acknowledged");

  for (const kind of KINDS)
    test(`R47 cold: marker, ${kind} unreadable: the fresh page sends nothing when it comes online, the stop stands once the markers can be read, and the person's retry sends the draft once`, async ({
      context,
    }, info) => {
      const { net, page: first } = await boot(context);
      await context.setOffline(true);
      expect((await enqueue(first, A, "r", "original"))?.kind).toBe("queued");
      await facadeStop(first, "marker", A, "r");
      const page = await reload(context, first, readsOf(kind));
      await untilStopped(page);
      await staysHeld(page, net);
      expect(await statusOf(page, A)).toBe("queued");
      expect(await markers(page)).toEqual([`draft:${A}`]);
      expect(await streaks(page)).toEqual({});
      recordEvidence(info, `cold-${kind}`, {
        state: await outboxState(page),
        warning: await warning(page),
        sent: net.commands.length,
      });
      // The markers can be read again: what they say is what they said, and nothing is sent until the person retries.
      await markerReads(page, NONE);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.waitForTimeout(500);
      expect(net.commands).toHaveLength(0);
      expect(await markers(page)).toEqual([`draft:${A}`]);
      await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
      await untilSent(page, A);
      expect(net.commands.map((c) => c.key)).toEqual([A]);
      expect(await markers(page)).toEqual([]);
      await untilWarning(page, false, false);
    });

  // ADDED, revision 33 (qualification of MU-904, which survived in the pool once the single-page cases could no longer tell it apart): the facade
  // whose FIRST look could not read the markers is unsure, not blind. The page here is a FOLLOWER (no dispatcher: nothing but its facade can say
  // what stands, where a dispatcher's own announcement would also have told it) and the marker `storage` events it is sent are kept back, so
  // that only the stores' hint (the channel) can tell it anything. It established nothing, so it shows nothing while nothing can be read;
  // once the markers can be read again, the first thing another tab writes makes it look again and show the stop. A facade that took its
  // incomplete first look for a complete one (`known` forced true) stops listening and shows nothing. The order matters: the page whose first
  // look fails is the LAST to boot, because a page that boots mounts the other pages' trees again (R43, R57) and a fresh facade would look anew.
  // ADDED, revision 34: `directory-only` is the case in which the directories cannot be read and the LISTING can: the second witness names the
  // marker at the first look, so the facade is not blind at all and shows the stop at once (the other kinds leave nothing that can name it).
  for (const kind of [...KINDS, "directory-only"] as Unreadable[])
    test(`R47: marker, ${kind} unreadable at the first look: a follower's facade is not left blind for good, and a write by ANOTHER tab after the markers can be read shows the stop`, async ({
      context,
    }, info) => {
      await installStorageHold(context);
      const { net, page: first } = await boot(context);
      await context.setOffline(true);
      expect((await enqueue(first, A, "r", "original"))?.kind).toBe("queued");
      await facadeStop(first, "marker", A, "r");
      await first.close();
      await context.setOffline(false);
      const writer = await anotherOutbox(context);
      // The cold page: it boots with the faults already in force, after the writer, and the writer is settled (its captured outbox bound) after it.
      const readiness: OutboxReadiness[] = [];
      const page = await withSettledOutboxPeers(
        async () => {
          const cold = await bootSession(context);
          await untilTreeSettled(cold, { connections: 0 });
          await installMarkerReadFaults(cold);
          await markerReads(cold, readsOf(kind));
          await startOutbox(cold, ACCOUNT, { start: false });
          await untilTreeSettled(cold, { connections: 2 });
          await install(cold);
          return cold;
        },
        [writer],
        readiness,
      );
      recordEvidence(info, "peer-readiness", readiness);
      await holdStorageEvents(page);
      if (kind === "directory-only") {
        // The listing names the marker although no directory can be read: the stop is shown at the first look.
        await untilWarning(page, true, false);
        expect(await markers(page)).toEqual([`draft:${A}`]);
      } else {
        // Nothing can be read, and this page established nothing: it says nothing.
        expect(await warning(page)).toEqual({
          notResponding: false,
          memoryOnly: false,
        });
      }
      await markerReads(page, NONE);
      // Another tab writes: the stores changed, and this facade looks again.
      expect((await enqueue(writer, B, "s", "second"))?.kind).toBe("queued");
      await untilWarning(page, true, false);
      expect(await markers(page)).toEqual([`draft:${A}`]);
      expect(net.commands).toHaveLength(0);
      recordEvidence(info, `blind-${kind}`, {
        warning: await warning(page),
        markers: await markers(page),
        events: await markerEventCounts(page),
      });
      await releaseStorageEvents(page);
      // The person's retry lifts the stop (no dispatcher runs here, so nothing is sent).
      await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
      await untilWarning(page, false, false);
      expect(await markers(page)).toEqual([]);
    });

  test("R47 cold: both unreadable and NO marker: the draft is held while nothing can be read, and a read that lands releases it without anyone's act", async ({
    context,
  }, info) => {
    const { net, page: first } = await boot(context);
    await context.setOffline(true);
    expect((await enqueue(first, A, "r", "original"))?.kind).toBe("queued");
    const page = await reload(context, first, readsOf("getItem"));
    await untilStopped(page);
    await staysHeld(page, net);
    expect(await statusOf(page, A)).toBe("queued");
    await markerReads(page, NONE);
    // The store is readable now and nothing tells the page: the dispatcher asks again on its rescan (5 s).
    await untilSent(page, A);
    expect(net.commands.map((c) => c.key)).toEqual([A]);
    recordEvidence(info, "cold-no-marker-released", {
      sent: net.commands.map((c) => c.key),
    });
  });

  // ADAPTED, revision 30 (separately labelled): the two retries below used to send the draft while nothing could be read, because a removal
  // that returned was kept as evidence that the key was gone (revision 29). A removal is not kept (an older recovery is no proof about a
  // newer stop, see "E-O10 (revision 30, R47)"): the retry still removes exactly the record of the draft(s) it covers, the draft is held
  // while nothing can be read, and it is sent exactly once when a read lands and finds nothing.
  // ADAPTED, revision 32 (R52, R53): a retry made while nothing can be listed names no failure, and a failure that a listing finds LATER
  // may be newer than the person's decision, which the retry is not entitled to end. So it removes nothing: the stop stands (`unknown`
  // meanwhile), the draft stays held when a listing lands and finds the marker, and the retry made THEN names it, removes it, and the
  // draft is sent exactly once.
  test("R47 cold: marker, both unreadable: the person's retry cannot name the record, so it stands; the retry made when a listing lands removes it, and the draft is sent exactly once (adapted, revisions 30 and 32)", async ({
    context,
  }, info) => {
    const { net, page: first } = await boot(context);
    await context.setOffline(true);
    expect((await enqueue(first, A, "r", "original"))?.kind).toBe("queued");
    await facadeStop(first, "marker", A, "r");
    const page = await reload(context, first, readsOf("getItem"));
    await untilStopped(page);
    await staysHeld(page, net);
    await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
    await page.waitForTimeout(500);
    expect(await markers(page)).toEqual([`draft:${A}`]);
    await staysUnsent(page, net);
    await markerReads(page, NONE);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(500);
    expect(net.commands).toHaveLength(0);
    await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
    await untilSent(page, A);
    expect(net.commands.map((c) => c.key)).toEqual([A]);
    expect(await markers(page)).toEqual([]);
    recordEvidence(info, "cold-retry-unreadable", {
      sent: net.commands.map((c) => c.key),
    });
  });

  test("R47 cold: marker, both unreadable: the person's retry of ALL drafts cannot name it either, so it stands; the retry made when a listing lands removes it, and the draft is sent exactly once (adapted, revisions 30 and 32)", async ({
    context,
  }, info) => {
    const { net, page: first } = await boot(context);
    await context.setOffline(true);
    expect((await enqueue(first, A, "r", "original"))?.kind).toBe("queued");
    await facadeStop(first, "marker", A, "r");
    const page = await reload(context, first, readsOf("getItem"));
    await untilStopped(page);
    await staysHeld(page, net);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await page.waitForTimeout(500);
    expect(await markers(page)).toEqual([`draft:${A}`]);
    await staysUnsent(page, net);
    await markerReads(page, NONE);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(500);
    expect(net.commands).toHaveLength(0);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await untilSent(page, A);
    expect(net.commands.map((c) => c.key)).toEqual([A]);
    expect(await markers(page)).toEqual([]);
    recordEvidence(info, "cold-retry-all-unreadable", {
      sent: net.commands.map((c) => c.key),
    });
  });

  test("R47 cold: the durable counter holds the stop with the markers unreadable: nothing is sent, and the retry sends the draft once", async ({
    context,
  }) => {
    const { net, page: first } = await boot(context);
    await context.setOffline(true);
    expect((await enqueue(first, A, "r", "original"))?.kind).toBe("queued");
    await facadeStop(first, "streak", A, "r");
    const page = await reload(context, first, readsOf("getItem"));
    await untilStopped(page);
    await staysHeld(page, net);
    await markerReads(page, NONE);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(500);
    expect(net.commands).toHaveLength(0);
    expect((await streaks(page))[`draft:${A}`]).toBe(3);
    await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
    await untilSent(page, A);
    expect(net.commands.map((c) => c.key)).toEqual([A]);
  });

  test("R47 cold: control: a healthy fresh page with no stop sends the draft at once", async ({
    context,
  }) => {
    const { net, page: first } = await boot(context);
    await context.setOffline(true);
    expect((await enqueue(first, A, "r", "original"))?.kind).toBe("queued");
    const page = await reload(context, first, NONE);
    await untilSent(page, A);
    expect(net.commands.map((c) => c.key)).toEqual([A]);
  });

  // ADAPTED, revision 32 (R52): with only the individual read failing nothing changes (the listing lands, and the markers of other
  // operations are listed as theirs); with the listing failing nothing can be said of the draft's own operations, so it waits for a
  // listing (the next test).
  for (const kind of ["marker"] as const)
    test(`R47 cold: markers of OTHER operations do not hold the draft while only their ${kind} keys cannot be read (exact-operation isolation)`, async ({
      context,
    }) => {
      const { net, page: first } = await boot(context);
      await context.setOffline(true);
      expect((await enqueue(first, A, "r", "first"))?.kind).toBe("queued");
      expect((await enqueue(first, B, "s", "second"))?.kind).toBe("queued");
      for (const operation of [
        "draft:unrelated",
        "receipt:unrelated",
        "page:elsewhere",
      ])
        await plantMarkerOn(first, ACCOUNT, operation, "other.1");
      const page = await reload(context, first, readsOf(kind));
      await untilSent(page, A);
      await untilSent(page, B);
      expect(net.commands.map((c) => c.key).sort()).toEqual([A, B].sort());
    });

  test("R47 cold: the listing cannot be made (markers of other operations stand): nothing is sent for either draft until a listing lands, and then both are", async ({
    context,
  }) => {
    const { net, page: first } = await boot(context);
    await context.setOffline(true);
    expect((await enqueue(first, A, "r", "first"))?.kind).toBe("queued");
    expect((await enqueue(first, B, "s", "second"))?.kind).toBe("queued");
    for (const operation of ["draft:unrelated", "page:elsewhere"])
      await plantMarkerOn(first, ACCOUNT, operation, "other.1");
    const page = await reload(context, first, readsOf("directory"));
    await untilStopped(page);
    await staysHeld(page, net);
    await markerReads(page, NONE);
    await untilSent(page, A);
    await untilSent(page, B);
    expect(net.commands.map((c) => c.key).sort()).toEqual([A, B].sort());
  });
});

/**
 * E-O10 (revision 30, R47): an OLDER recovery is no proof about a NEWER stop, in a real engine.
 *
 * The independent review of revision 29 stopped a draft (the edit and the recording of its failure both failed, so only the fallback
 * marker holds the stop), made the reads of the marker fail, completed the person's retry (the removal returned), and then had ANOTHER
 * page write a new `draft:<id>` marker with its notification held before dispatch resumed: the dispatcher claimed, sent and acknowledged
 * the draft while the stop remained (three engines). A completed removal establishes absence AT that moment; the page that admits the
 * draft later cannot tell a marker written since from "none" unless a read lands, and a notification is never the only protection.
 * Here the recovery is the person's retry or the draft's own successful edit; the new stop is written by a REAL second page into the
 * REAL `localStorage`; the first page's marker reads are made to throw (`installMarkerReadFaults`) and its `storage` events for marker
 * keys are held back (`holdStorageEvents`) or delivered; the page then comes online.
 *
 * What is asserted: with a new stop NOTHING is sent whether the page can read, cannot read, has heard or has not heard (and the new stop
 * is never erased by anything); with NO new stop and nothing readable the page cannot tell it from the case above, so it also holds the
 * draft (deliberately: see `docs/data-layer.md`); the draft goes out exactly once when a read lands and finds nothing there; and the
 * person can lift a NEW stop with a new retry once it is read. FIXTURE evidence: the HTTP answers are scripted, the dispatcher is the
 * fixture's test leader, the unreadable storage and the held notification are installed by the spec, and the "other page" is a second
 * fixture page of the same origin.
 */
test.describe("E-O10 (revision 30, R47): an older recovery is no proof about a newer stop, in a real engine", () => {
  const NONE = NO_READ_FAULTS;
  interface Schedule {
    name: string;
    /** Another page wrote a NEW marker after the recovery. */
    newMarker: boolean;
    /** The `storage` event of that write reaches the page before the draft is admitted. */
    delivered: boolean;
    /** The store can be read when the draft is admitted. */
    readableThen: boolean;
  }
  const SCHEDULES: Schedule[] = [
    {
      name: "a NEW stop, its notification held, nothing readable",
      newMarker: true,
      delivered: false,
      readableThen: false,
    },
    {
      name: "a NEW stop, its notification delivered, nothing readable",
      newMarker: true,
      delivered: true,
      readableThen: false,
    },
    {
      name: "a NEW stop that can be read (its notification held)",
      newMarker: true,
      delivered: false,
      readableThen: true,
    },
    {
      name: "NO new stop and nothing readable (indistinguishable from the first)",
      newMarker: false,
      delivered: false,
      readableThen: false,
    },
    {
      name: "NO new stop and it can be read",
      newMarker: false,
      delivered: false,
      readableThen: true,
    },
  ];
  const untilStopped = (page: Page) =>
    expect
      .poll(async () => (await outboxState(page))?.kind, { timeout: 10_000 })
      .toBe("stopped");
  const untilSent = (page: Page, id: string) =>
    expect
      .poll(() => statusOf(page, id), { timeout: 12_000 })
      .toBe("acknowledged");
  /** What the page's markers answer for the draft's operation now (the module's own three-valued answer, in the real engine). */
  const believes = async (page: Page) =>
    page.evaluate(
      ([account, operation, lifetime]) =>
        window.__atlasData?.markers.probe(
          { account: account as string, incarnationId: lifetime as string },
          operation as string,
        ),
      [ACCOUNT, `draft:${A}`, await incarnationOf(page, ACCOUNT)],
    );
  /** ANOTHER page records a NEW failure of the draft (its directory, then its own key), in the lifetime of the database both have open. */
  const writeNewStop = async (writer: Page, page: Page) =>
    plantMarkerOn(writer, ACCOUNT, `draft:${A}`, "writer.1", {
      incarnation: await incarnationOf(page, ACCOUNT),
    });

  for (const recovery of [
    "the person's retry",
    "the draft's own successful edit",
  ] as const)
    for (const schedule of SCHEDULES)
      test(`R47 newer stop: ${recovery}, then ${schedule.name}`, async ({
        context,
      }, info) => {
        // The page's storage hold must be its FIRST `storage` listener (see `storageHoldInit`): installed before the page exists.
        await installStorageHold(context);
        const { net, page } = await boot(context);
        // The other page boots while the network is up (a page needs it to boot), and stays open: it only writes `localStorage`.
        const writer = await dataPage(context);
        await installMarkerReadFaults(page);
        // The notification feed of marker keys: held or delivered, as the schedule says.
        if (!schedule.delivered) await holdStorageEvents(page);
        await context.setOffline(true);
        expect((await enqueue(page, A, "r", "original"))?.kind).toBe("queued");
        await facadeStop(page, "marker", A, "r");
        // The store cannot be read, and the recovery completes: its removal returns.
        await markerReads(page, readsOf("getItem"));
        if (recovery === "the person's retry")
          await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
        else
          expect((await editDraft(page, A, "r", "saved"))?.kind).toBe("edited");
        // The person's retry removed the record, and so did the draft's own success: this page's facade named the instance when it was
        // written, and the removal of a key that names its failure needs no read (ADAPTED, revision 32: revision 31 owed the success's
        // removal to the first read that landed, because it had to compare a shared value first).
        await expect
          .poll(() => markers(writer), { timeout: 10_000 })
          .toEqual([]);
        // ANOTHER page records a NEW stop after the recovery.
        if (schedule.newMarker) {
          // ANOTHER page's failure is a key of its own (R52, revision 32): the recovery above removed the key it named and cannot reach it.
          await writeNewStop(writer, page);
          if (schedule.delivered)
            await expect
              .poll(async () => (await markerEventCounts(page)).received, {
                timeout: 10_000,
              })
              .toBeGreaterThan(0);
          else
            await expect
              .poll(async () => (await markerEventCounts(page)).held, {
                timeout: 10_000,
              })
              .toBeGreaterThan(0);
        }
        if (schedule.readableThen) await markerReads(page, NONE);
        await context.setOffline(false);
        const held = schedule.newMarker || !schedule.readableThen;
        if (held) {
          await untilStopped(page);
          await staysUnsent(page, net);
          // The module's own answer: a marker it can read is `marked`; with nothing readable it is `unknown`, never `unmarked` (the
          // page removed the record itself, and that is no proof about a record written since).
          expect(await believes(page)).toBe(
            schedule.readableThen ? "marked" : "unknown",
          );
          expect((await markers(writer)).includes(`draft:${A}`)).toBe(
            schedule.newMarker,
          );
        } else {
          await untilSent(page, A);
        }
        recordEvidence(
          info,
          `r47-newer-${recovery === "the person's retry" ? "retry" : "edit"}-${SCHEDULES.indexOf(schedule)}`,
          {
            sent: net.commands.map((c) => c.key),
            state: await outboxState(page),
            markers: await markers(writer),
            events: await markerEventCounts(page),
          },
        );
        if (schedule.newMarker) {
          // The store comes back and the held notification is delivered: the NEW stop is read, and it holds the draft (it is a stop).
          await markerReads(page, NONE);
          await releaseStorageEvents(page);
          await staysUnsent(page, net);
          expect(await markers(writer)).toEqual([`draft:${A}`]);
          // The person lifts it with a new retry, which is what a stop needs.
          await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
          await untilSent(page, A);
          expect(await markers(writer)).toEqual([]);
        } else if (held) {
          // Nothing was recorded after the recovery: the draft goes out, once, when a read lands.
          await markerReads(page, NONE);
          await untilSent(page, A);
        }
        expect(net.commands.map((c) => c.key)).toEqual([A]);
        expect(net.commands[0]?.body).toContain(
          recovery === "the person's retry"
            ? '"label":"original"'
            : '"label":"saved"',
        );
      });

  /**
   * ADDED, revision 32 (R52): the dispatcher's own retry reaches a draft only when the dispatcher had STALLED it, that is, read its marker
   * while the store could be listed. (The cases above retry while nothing can be listed, which names nothing, so they no longer reach it.)
   * The retry then removes the key it named; what follows happens while it waits on the database, as in the review of revision 29: the
   * store stops being listable and ANOTHER real page records a NEW stop. Nothing the dispatcher kept of its own removal may stand for
   * evidence about that stop.
   */
  test("R47 newer stop: the dispatcher's own retry of a draft it stalled, then nothing can be listed and another page records a NEW stop: nothing is sent, and the new stop is never erased", async ({
    context,
  }, info) => {
    const { net, page } = await boot(context);
    const writer = await dataPage(context);
    await installMarkerReadFaults(page);
    await context.setOffline(true);
    expect((await enqueue(page, A, "r", "original"))?.kind).toBe("queued");
    await facadeStop(page, "marker", A, "r");
    // Back online with the store readable: the dispatcher reads the marker and stalls the draft.
    await context.setOffline(false);
    await untilStopped(page);
    await staysUnsent(page, net);
    // The retry names the marker the dispatcher read; in the same turn the store stops being listable (the retry is still waiting on the
    // database), and another page records a NEW stop, a key of its own.
    await page.evaluate((id) => {
      window.__atlasData?.retryOutbox(id);
      const reads = (
        window as unknown as {
          __markerReads: { enumeration: boolean; getItem: boolean };
        }
      ).__markerReads;
      reads.enumeration = true;
      reads.getItem = true;
    }, A);
    await writeNewStop(writer, page);
    await expect
      .poll(async () => (await markers(writer)).includes(`draft:${A}`), {
        timeout: 10_000,
      })
      .toBe(true);
    await staysUnsent(page, net);
    expect(await believes(page)).toBe("unknown");
    recordEvidence(info, "r47-newer-dispatcher-retry", {
      sent: net.commands.map((c) => c.key),
      state: await outboxState(page),
      markers: await markers(writer),
    });
    // The store comes back: the NEW stop is read, and it holds the draft until the person lifts it.
    await markerReads(page, NONE);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await staysUnsent(page, net);
    expect(await markers(writer)).toEqual([`draft:${A}`]);
    await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
    await untilSent(page, A);
    expect(await markers(writer)).toEqual([]);
    expect(net.commands.map((c) => c.key)).toEqual([A]);
  });
});

/**
 * E-O10 (revision 31, R50): an OLDER successful write, whose result is delivered LATE, does not end a NEWER stop, in a real engine.
 *
 * The independent review of revision 30 saved a draft, committed an edit (`older-success`) and held the delivery of its result, made a
 * second edit of the same draft fail (the failure's counter failed too, so the stop was a marker, or, with the marker unwritable, the
 * page's memory), released the older result and started the dispatcher: the facade's cleanup after the awaited transaction removed the
 * newer stop, the warning disappeared and the dispatcher sent the OLDER body (6 failing cases and 12 controls in Chromium, Firefox and
 * WebKit; and, with the newer failure produced by ANOTHER page's facade through aborted native transactions, 3 failing cases and 9
 * controls). A success now ends the stop instances that stood when it was ISSUED, however late its result arrives; a stop recorded
 * since is a newer failure and is exactly as it was recorded. Here the same schedule runs through the production facade over REAL
 * IndexedDB (the failures are aborted by a fault the spec installs in the page), the page's REAL `localStorage` and, for the second
 * case, a SECOND real page with its own facade. The delayed delivery is the fixture's hold of the facade's `data.editQueuedDraft`
 * answer (the transaction commits at once; the facade is told when the spec says), as the review held it.
 *
 * What is NOT claimed here: that the newer, unsaved body was saved or sent (it was neither: the draft is sent as the last transaction
 * that landed left it, once the person lifts the stop), a real freeze or a slow disk (the delay is injected), or real storage failures.
 * FIXTURE evidence for this engine on this machine: the HTTP answers are scripted, and the dispatcher is the fixture's test leader.
 */
test.describe("E-O10 (revision 31, R50): an older successful write delivered after a newer stop does not end it, in a real engine", () => {
  /**
   * ADAPTED, revision 32 (R52): a failure's marker is a key of its own, so what the cases compare is the NAMES of the failures that stand
   * for the operation (the part of each key after `#`, joined), not the value of one shared key. `null`: none stands.
   */
  const markerValue = async (page: Page) =>
    (await markerInstances(page, ACCOUNT, `draft:${A}`)).join(",") || null;
  for (const mechanism of MECHANISMS)
    for (const delayed of [true, false])
      test(`R50: ${mechanism}: an older successful edit, its result ${delayed ? "delivered late" : "delivered in time (control)"}, does not end a newer stop: the stop stands exactly as recorded, the warning stays and nothing is sent`, async ({
        context,
      }, info) => {
        const { net, page } = await boot(context);
        await context.setOffline(true);
        expect(await enqueue(page, A, "r", "original")).toMatchObject({
          kind: "queued",
        });
        // Revision 21 (R20-N1): delayed, the older edit and its held answer are owned by a scope that releases the hold by its own
        // token and joins the edit on every path; the timely control runs the same steps without one.
        const run = async (holds: HeldOperations | null) => {
          let older: HeldCall<unknown> | null = null;
          let hold: Hold | null = null;
          if (holds !== null) {
            hold = await holds.holdOutbox(page, "data.editQueuedDraft");
            older = holds.launch("the older edit", () =>
              editDraft(page, A, "r", "older-success"),
            );
            await hold.untilHeld();
            await untilLanded(page, "older-success");
          } else
            expect((await editDraft(page, A, "r", "older-success"))?.kind).toBe(
              "edited",
            );
          // The NEWER edit fails by `mechanism` after the older write was issued (and, delayed, committed).
          await facadeStop(page, mechanism, A, "r");
          const recorded = {
            standing: await standing(page, A),
            warning: await warning(page),
            value: await markerValue(page),
            hits: await hits(page),
          };
          expect(recorded.standing).toEqual(STANDING(mechanism));
          if (hold !== null && older !== null) {
            await hold.release();
            expect(await older.settled()).toMatchObject({ kind: "edited" });
          }
          return recorded;
        };
        const recorded = delayed
          ? await withHeldOperations(run)
          : await run(null);
        await context.setOffline(false);
        await untilState(page, "stopped");
        await staysHeld(page, net);
        const after = {
          standing: await standing(page, A),
          warning: await warning(page),
          value: await markerValue(page),
          state: await outboxState(page),
          status: await statusOf(page, A),
          sent: net.commands.length,
        };
        recordEvidence(
          info,
          `r50-${mechanism}-${delayed ? "late" : "timely"}`,
          {
            recorded,
            after,
          },
        );
        // The newer stop is exactly as it was recorded: the same instance, in the same record.
        expect(after.standing).toEqual(recorded.standing);
        expect(after.value).toBe(recorded.value);
        expect(after.warning).toEqual({
          notResponding: true,
          memoryOnly: mechanism === "memory",
        });
        expect(after.status).toBe("queued");
        expect(after.sent).toBe(0);
        // The person's retry lifts it, and the draft goes out once, as the last transaction that landed left it.
        await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
        await untilStatus(page, A, "acknowledged");
        expect(net.commands).toHaveLength(1);
        expect(net.commands[0]?.body).toContain('"label":"older-success"');
        expect(net.commands[0]?.body).not.toContain("unsaved");
        await untilWarning(page, false, false);
        expect(await markers(page)).toEqual([]);
      });

  for (const delayed of [true, false])
    test(`R50: ANOTHER page's stop: an older successful edit, its result ${delayed ? "delivered late" : "delivered in time (control)"}, does not end the marker the other page's facade recorded`, async ({
      context,
    }, info) => {
      const { net, page } = await boot(context);
      // R57, revision 33: the helper waits for the page's CAPTURED writer (its binding), not for a count of connections, and says what it found.
      const readiness: OutboxReadiness[] = [];
      const other = await withSettledOutboxPeers(
        () => anotherOutbox(context),
        [page],
        readiness,
      );
      recordEvidence(info, "peer-readiness", readiness);
      await context.setOffline(true);
      expect(await enqueue(page, A, "r", "original")).toMatchObject({
        kind: "queued",
      });
      // Revision 21 (R20-N1): delayed, the older edit and its held answer are owned by a scope (as above).
      const run = async (holds: HeldOperations | null) => {
        let older: HeldCall<unknown> | null = null;
        let hold: Hold | null = null;
        if (holds !== null) {
          hold = await holds.holdOutbox(page, "data.editQueuedDraft");
          older = holds.launch("the older edit", () =>
            editDraft(page, A, "r", "older-success"),
          );
          await hold.untilHeld();
          await untilLanded(page, "older-success");
        } else
          expect((await editDraft(page, A, "r", "older-success"))?.kind).toBe(
            "edited",
          );
        // The OTHER page's facade fails its own edit of the same draft, and so does the recording of that failure: its marker holds the stop.
        await arm(other, { id: A, armed: 1, counter: 1 });
        expect(await editDraft(other, A, "r", "unsaved")).toMatchObject({
          kind: "refused",
          reason: "storage",
        });
        await expect
          .poll(() => markers(page), { timeout: 10_000 })
          .toEqual([`draft:${A}`]);
        // The storage event reaches this page's facade: the warning is up before the older result is delivered.
        await untilWarning(page, true, false);
        const recorded = await markerValue(page);
        expect(recorded).not.toBeNull();
        if (hold !== null && older !== null) {
          await hold.release();
          expect(await older.settled()).toMatchObject({ kind: "edited" });
        }
        return recorded;
      };
      const recorded = delayed
        ? await withHeldOperations(run)
        : await run(null);
      await context.setOffline(false);
      await untilState(page, "stopped");
      await staysHeld(page, net);
      expect(await markers(page)).toEqual([`draft:${A}`]);
      expect(await markerValue(page)).toBe(recorded);
      expect(await warning(page)).toEqual({
        notResponding: true,
        memoryOnly: false,
      });
      expect(net.commands).toHaveLength(0);
      recordEvidence(info, `r50-cross-${delayed ? "late" : "timely"}`, {
        recorded,
        after: await markerValue(page),
        state: await outboxState(page),
      });
      await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
      await untilStatus(page, A, "acknowledged");
      expect(net.commands).toHaveLength(1);
      expect(net.commands[0]?.body).toContain('"label":"older-success"');
      expect(await markers(page)).toEqual([]);
    });

  test("R50: a stop that stood when the older write was issued, then ANOTHER page's NEWER failure of the same operation: the older result, delivered late, ends nothing (the newer instance stands)", async ({
    context,
  }, info) => {
    const { net, page } = await boot(context);
    // R57, revision 33: the helper waits for the page's CAPTURED writer (its binding), not for a count of connections, and says what it found.
    const readiness: OutboxReadiness[] = [];
    const other = await withSettledOutboxPeers(
      () => anotherOutbox(context),
      [page],
      readiness,
    );
    recordEvidence(info, "peer-readiness", readiness);
    await context.setOffline(true);
    expect(await enqueue(page, A, "r", "original")).toMatchObject({
      kind: "queued",
    });
    // This page's own failure: the marker names it. The older write is issued OVER that instance.
    await facadeStop(page, "marker", A, "r");
    const first = await markerValue(page);
    expect(first).not.toBeNull();
    // Revision 21 (R20-N1, the MU-990 case): the edit and its held answer are owned by a scope. When an assertion below fails while the
    // answer is held, the scope releases the hold by its own token and joins the edit before the failure is reported, so the case reports
    // that assertion alone (the edit's own failure, if it had one, is a separate error), never a pending `page.evaluate` ended by Playwright.
    const newer = await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const saved = holds.launch("the saved edit", () =>
        editDraft(page, A, "r", "saved"),
      );
      await hold.untilHeld();
      await untilLanded(page, "saved");
      // ANOTHER page's facade fails its own edit of the same draft and writes a NEW instance over the key.
      await arm(other, { id: A, armed: 1, counter: 1 });
      expect(await editDraft(other, A, "r", "unsaved-again")).toMatchObject({
        kind: "refused",
        reason: "storage",
      });
      await expect
        .poll(() => markerValue(page), { timeout: 10_000 })
        .not.toBe(first);
      // ADAPTED, revision 32 (R52): the other page's failure is a key of its own, beside this page's. The write that was issued over THIS
      // page's instance ends that one (its exact key) when its result is delivered; the other page's is the newer failure and stands.
      const newerOnly = (
        await markerInstances(page, ACCOUNT, `draft:${A}`)
      ).filter((name) => !(first ?? "").split(",").includes(name));
      expect(newerOnly).toHaveLength(1);
      const newer = newerOnly.join(",");
      await hold.release();
      expect(await saved.settled()).toMatchObject({ kind: "edited" });
      return newer;
    });
    await context.setOffline(false);
    await untilState(page, "stopped");
    await staysHeld(page, net);
    expect(await markerValue(page)).toBe(newer);
    expect(await warning(page)).toEqual({
      notResponding: true,
      memoryOnly: false,
    });
    expect(net.commands).toHaveLength(0);
    recordEvidence(info, "r50-cross-newer-instance", {
      first,
      newer,
      after: await markerValue(page),
    });
    await page.evaluate((id) => window.__atlasData?.retryOutbox(id), A);
    await untilStatus(page, A, "acknowledged");
    expect(net.commands).toHaveLength(1);
    expect(net.commands[0]?.body).toContain('"label":"saved"');
    expect(await markers(page)).toEqual([]);
  });

  test("R50 control: a stop recorded BEFORE the older write was issued is ended by its success, even when the result is delivered late; the draft is sent once, as saved", async ({
    context,
  }, info) => {
    const { net, page } = await boot(context);
    await context.setOffline(true);
    expect(await enqueue(page, A, "r", "original")).toMatchObject({
      kind: "queued",
    });
    await facadeStop(page, "marker", A, "r");
    // Revision 21 (R20-N1): the edit and its held answer are owned by a scope (as above).
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const saved = holds.launch("the saved edit", () =>
        editDraft(page, A, "r", "saved"),
      );
      await hold.untilHeld();
      await untilLanded(page, "saved");
      // Held: nothing has ended the stop yet.
      expect(await standing(page, A)).toEqual(STANDING("marker"));
      await hold.release();
      expect(await saved.settled()).toMatchObject({ kind: "edited" });
    });
    await untilWarning(page, false, false);
    expect(await markers(page)).toEqual([]);
    await context.setOffline(false);
    await untilStatus(page, A, "acknowledged");
    expect(net.commands).toHaveLength(1);
    expect(net.commands[0]?.body).toContain('"label":"saved"');
    recordEvidence(info, "r50-control-before", { sent: net.commands.length });
  });
});
