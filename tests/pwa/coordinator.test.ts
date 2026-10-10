// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  ACTIVATION_FALLBACK_MS,
  FLUSH_MAX_MS,
  FLUSH_START_GRACE_MS,
  REPORT_ACK_TIMEOUT_MS,
  REPORT_RETRY_INITIAL_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_UNSUPPORTED_MIN_MS,
  UPDATE_CHECK_VISIBLE_MIN_MS,
} from "../../src/lib/pwa/coordinator";
import { FakeOrigin, flush } from "./coordinator-world";

/**
 * WEB-14a D-P4/D-P5: the app-update coordinator of each tab, over a double of the registration (capability rows 400 and 473; WEB-04 8;
 * wireframe 6; Q4). Production constants on a manual clock.
 */
const reports = (worker: { messages: Array<{ message: { type: string } }> }) =>
  worker.messages.filter((m) => m.message.type === "atlas:report").length;
const skipWaitings = (worker: {
  messages: Array<{ message: { type: string } }>;
}) =>
  worker.messages.filter((m) => m.message.type === "atlas:skip-waiting").length;

describe("registration and the banner", () => {
  test("registers /sw.js at the root, bypassing the HTTP cache for the script; nothing to say yet", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    expect(tab.container.registrations).toEqual([
      { url: "/sw.js", options: { scope: "/", updateViaCache: "none" } },
    ]);
    expect(tab.state).toEqual({ kind: "none" });
    // It reports which build it runs.
    expect(reports(origin.active)).toBe(1);
  });

  test("an installed newer version shows `available` in EVERY tab, including tabs that did not check, and nothing reloads", async () => {
    const origin = new FakeOrigin();
    const tabs = [
      await origin.tab().start(),
      await origin.tab().start(),
      await origin.tab({ controlled: false }).start(),
    ];
    await origin.installNew(2);
    for (const tab of tabs) {
      expect(tab.state).toEqual({ kind: "available", dismissed: false });
      expect(tab.reloads).toBe(0);
    }
    await origin.clock.advance(3_600_000 * 3);
    for (const tab of tabs) expect(tab.reloads).toBe(0);
  });

  test("a version already waiting when the page loads is shown at once", async () => {
    const origin = new FakeOrigin();
    const first = await origin.tab().start();
    const waiting = await origin.installNew(2);
    const late = origin.tab();
    late.registration.waiting = waiting;
    await late.start();
    expect(late.state).toEqual({ kind: "available", dismissed: false });
    expect(first.reloads + late.reloads).toBe(0);
  });

  test("dismissed until the next return to the page; the update is never cancelled", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    await origin.installNew(2);
    tab.actions?.notNow();
    expect(tab.state).toEqual({ kind: "available", dismissed: true });
    for (const signal of ["focus", "visible", "pageshow"] as const) {
      tab.actions?.notNow();
      tab.emit(signal);
      expect(tab.state).toEqual({ kind: "available", dismissed: false });
    }
  });
});

describe("accepting in one tab (row 400: only that tab reloads)", () => {
  test("a clean tab: the waiting worker (and only it) is told to skip waiting; the tab reloads when the controller changes, not before", async () => {
    const origin = new FakeOrigin();
    const acting = await origin.tab().start();
    const other = await origin.tab().start();
    const waiting = await origin.installNew(2);
    acting.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(skipWaitings(waiting)).toBe(1);
    expect(skipWaitings(origin.tabs[0]?.registration.active as never)).toBe(0);
    expect(acting.reloads).toBe(0);
    expect(acting.state).toEqual({ kind: "reloading" });
    await origin.activate(waiting);
    expect(acting.reloads).toBe(1);
    // The other tab is told it was updated elsewhere, and does not reload.
    expect(other.state).toEqual({
      kind: "updated_elsewhere",
      dismissed: false,
    });
    expect(other.reloads).toBe(0);
    // "Reload here" reloads that tab only, at once (nothing to skip).
    other.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(other.reloads).toBe(1);
    expect(skipWaitings(waiting)).toBe(1);
  });

  test("a controlled tab reloads on the controller change even when the worker's statechange never reaches it", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(skipWaitings(waiting)).toBe(1);
    // The activation as this tab sees it: its registration and controller change; the worker's own state change is not delivered here.
    tab.registration.waiting = null;
    tab.registration.active = waiting;
    waiting.state = "activated";
    tab.container.changeController(waiting);
    await flush();
    expect(tab.reloads).toBe(1);
  });

  test("an uncontrolled tab (first visit) reloads when the waiting worker is activated", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab({ controlled: false }).start();
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(tab.reloads).toBe(0);
    await origin.activate(waiting);
    expect(tab.reloads).toBe(1);
  });

  test("activation that never happens: the tab reloads after ACTIVATION_FALLBACK_MS, not before", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    await origin.installNew(2);
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.clock.advance(ACTIVATION_FALLBACK_MS - 1);
    expect(tab.reloads).toBe(0);
    await origin.clock.advance(1);
    expect(tab.reloads).toBe(1);
    await origin.clock.advance(ACTIVATION_FALLBACK_MS * 2);
    expect(tab.reloads).toBe(1);
  });

  test("two tabs accept at once: both ask the waiting worker (harmless) and each reloads only itself, once", async () => {
    const origin = new FakeOrigin();
    const a = await origin.tab().start();
    const b = await origin.tab().start();
    const waiting = await origin.installNew(2);
    a.actions?.accept();
    b.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(a.reloads).toBe(1);
    expect(b.reloads).toBe(1);
  });
});

describe("unfinished forms (Q4 and the fresh-identifier flush)", () => {
  test("a dirty form is saved before anything else; a failed save keeps the form, shows retry or discard, and the update stays pending", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const form = tab.form();
    form.dirty = true;
    form.result = "failed";
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_MAX_MS * 2);
    expect(form.saves).toBe(1);
    expect(tab.state).toEqual({ kind: "save_failed", refused: false });
    expect(skipWaitings(waiting)).toBe(0);
    expect(tab.reloads).toBe(0);
    // Retry succeeds: the update is applied.
    form.result = "saved";
    tab.actions?.retrySave();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(form.saves).toBe(2);
    expect(skipWaitings(waiting)).toBe(1);
    await origin.activate(waiting);
    expect(tab.reloads).toBe(1);
  });

  test("signing out (refused): can't save; only 'Discard and reload anyway', which reloads without saving", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const form = tab.form();
    form.dirty = true;
    form.result = "refused";
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await flush();
    expect(tab.state).toEqual({ kind: "save_failed", refused: true });
    tab.actions?.discardAndReload();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(form.saves).toBe(1);
    expect(skipWaitings(waiting)).toBe(1);
    await origin.activate(waiting);
    expect(tab.reloads).toBe(1);
  });

  test("while saving, the state says so; a clean form is not saved", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const clean = tab.form("clean");
    const dirty = tab.form("dirty");
    dirty.dirty = true;
    dirty.result = "hold";
    await origin.installNew(2);
    tab.actions?.accept();
    await flush();
    expect(tab.state).toEqual({ kind: "saving" });
    expect(clean.saves).toBe(0);
    dirty.release("saved");
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(tab.state).toEqual({ kind: "reloading" });
  });

  test("another tab's dirty form is saved before the update is applied; that tab never reloads and keeps its form", async () => {
    const origin = new FakeOrigin();
    const acting = await origin.tab().start();
    const other = await origin.tab().start();
    const form = other.form();
    form.dirty = true;
    form.result = "hold";
    const waiting = await origin.installNew(2);
    acting.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    // The other tab answered that it is saving: the acting tab waits for it.
    expect(form.saves).toBe(1);
    expect(skipWaitings(waiting)).toBe(0);
    form.release("saved");
    await flush();
    expect(skipWaitings(waiting)).toBe(1);
    await origin.activate(waiting);
    expect(other.reloads).toBe(0);
    expect(other.state).toEqual({
      kind: "updated_elsewhere",
      dismissed: false,
    });
  });

  test("a tab that never finishes saving delays the update by FLUSH_MAX_MS at most", async () => {
    const origin = new FakeOrigin();
    const acting = await origin.tab().start();
    const other = await origin.tab().start();
    const form = other.form();
    form.dirty = true;
    form.result = "hold";
    const waiting = await origin.installNew(2);
    acting.actions?.accept();
    await origin.clock.advance(FLUSH_MAX_MS - 1);
    expect(skipWaitings(waiting)).toBe(0);
    await origin.clock.advance(1);
    expect(skipWaitings(waiting)).toBe(1);
  });

  test("no other tab answers: the acting tab waits only FLUSH_START_GRACE_MS", async () => {
    const origin = new FakeOrigin();
    const acting = await origin.tab().start();
    const waiting = await origin.installNew(2);
    acting.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS - 1);
    expect(skipWaitings(waiting)).toBe(0);
    await origin.clock.advance(1);
    expect(skipWaitings(waiting)).toBe(1);
  });

  test("a tab that learns it was updated elsewhere saves its dirty forms as a precaution, and does not reload", async () => {
    const origin = new FakeOrigin();
    const acting = await origin.tab().start();
    const other = await origin.tab().start();
    // The other tab misses the broadcast (its channel is closed while frozen).
    other.channel.close();
    const form = other.form();
    form.dirty = true;
    const waiting = await origin.installNew(2);
    acting.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(form.saves).toBe(0);
    await origin.activate(waiting);
    expect(form.saves).toBe(1);
    expect(other.reloads).toBe(0);
  });
});

describe("updated elsewhere, and the first install", () => {
  test("the first controllerchange from no controller is not 'updated elsewhere'", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab({ controlled: false }).start();
    tab.container.changeController(origin.active);
    await flush();
    expect(tab.state).toEqual({ kind: "none" });
  });

  test("a frozen tab that missed the change finds out by reporting when it comes back (the active generation is newer)", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab({ controlled: false }).start();
    const waiting = await origin.installNew(2);
    // Activated by another tab while this one could not hear anything: it is uncontrolled, so no controllerchange reaches it.
    tab.registration.waiting = null;
    tab.registration.active = waiting;
    origin.active = waiting;
    waiting.state = "activated";
    expect(tab.state.kind).toBe("available");
    tab.emit("visible");
    await flush();
    expect(tab.state).toEqual({ kind: "updated_elsewhere", dismissed: false });
    expect(tab.reloads).toBe(0);
  });
});

describe("reports (live-generation retention)", () => {
  test("an unacknowledged report is sent again with back-off until acknowledged", async () => {
    const origin = new FakeOrigin();
    origin.answer = "unknown";
    const tab = await origin.tab().start();
    expect(reports(origin.active)).toBe(1);
    await origin.clock.advance(REPORT_RETRY_INITIAL_MS);
    expect(reports(origin.active)).toBe(2);
    await origin.clock.advance(2 * REPORT_RETRY_INITIAL_MS - 1);
    expect(reports(origin.active)).toBe(2);
    await origin.clock.advance(1);
    expect(reports(origin.active)).toBe(3);
    origin.answer = "ack";
    await origin.clock.advance(4 * REPORT_RETRY_INITIAL_MS);
    const settled = reports(origin.active);
    await origin.clock.advance(600_000);
    // Only the hourly update checks run now; no more reports.
    expect(reports(origin.active)).toBe(settled);
    expect(tab.reloads).toBe(0);
  });

  test("a worker that never answers: the report times out and is sent again", async () => {
    const origin = new FakeOrigin();
    origin.answer = "silent";
    await origin.tab().start();
    await origin.clock.advance(REPORT_ACK_TIMEOUT_MS - 1);
    expect(reports(origin.active)).toBe(1);
    await origin.clock.advance(1 + REPORT_RETRY_INITIAL_MS);
    expect(reports(origin.active)).toBe(2);
  });
});

describe("update checks", () => {
  test("on online; on a return to the page at most every 15 min; hourly while visible", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const updates = () => tab.registration.updates;
    tab.emit("online");
    await flush();
    expect(updates()).toBe(1);
    tab.emit("visible");
    await flush();
    expect(updates()).toBe(1);
    await origin.clock.advance(UPDATE_CHECK_VISIBLE_MIN_MS);
    tab.emit("visible");
    await flush();
    expect(updates()).toBe(2);
    await origin.clock.advance(
      UPDATE_CHECK_INTERVAL_MS - UPDATE_CHECK_VISIBLE_MIN_MS,
    );
    expect(updates()).toBe(3);
    tab.visible = false;
    await origin.clock.advance(UPDATE_CHECK_INTERVAL_MS);
    expect(updates()).toBe(3);
  });

  test("an unsupported server asks for a newer client at once, at most every 60 s", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    tab.setCompat("unsupported");
    await flush();
    expect(tab.registration.updates).toBe(1);
    tab.setCompat("unsupported");
    await origin.clock.advance(UPDATE_CHECK_UNSUPPORTED_MIN_MS - 1);
    tab.setCompat("unsupported");
    await flush();
    expect(tab.registration.updates).toBe(1);
    await origin.clock.advance(1);
    tab.setCompat("unsupported");
    await flush();
    expect(tab.registration.updates).toBe(2);
    tab.setCompat("missing");
    await flush();
    expect(tab.registration.updates).toBe(2);
  });
});

test("an unsupported answer that came before the registration asks for a newer client once registered", async () => {
  const origin = new FakeOrigin();
  const tab = origin.tab();
  tab.compatStatus = "unsupported";
  await tab.start();
  expect(tab.registration.updates).toBe(1);
});

describe("the data layer superseded (D-P8)", () => {
  test("shows data_superseded; 'Reload here' saves (and a failure is shown), never reloads unasked", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    tab.supersede();
    expect(tab.state).toEqual({ kind: "data_superseded" });
    await origin.clock.advance(60_000);
    expect(tab.reloads).toBe(0);
    const form = tab.form();
    form.dirty = true;
    form.result = "failed";
    tab.actions?.accept();
    await flush();
    expect(tab.state).toEqual({ kind: "save_failed", refused: false });
    tab.actions?.discardAndReload();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(tab.reloads).toBe(1);
  });
});

describe("it never reloads unprompted", () => {
  test("through every event without an action", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const other = await origin.tab().start();
    const form = tab.form();
    form.dirty = true;
    const waiting = await origin.installNew(2);
    tab.emit("visible");
    tab.emit("online");
    tab.setCompat("unsupported");
    other.actions?.accept();
    await origin.clock.advance(FLUSH_MAX_MS);
    await origin.activate(waiting);
    tab.supersede();
    await origin.clock.advance(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(tab.reloads).toBe(0);
    expect(other.reloads).toBe(1);
  });
});

/**
 * Revision 1, R3: from the moment the person accepts until the page reloads, every form of the acting tab is frozen, so nothing can be
 * typed after the last save and lost by the reload (the waits for the other tabs and for the activation can last seconds). A form that
 * mounts during the waits is frozen as it registers. A failed save releases the forms: the person keeps working.
 */
describe("the acting tab's forms are frozen through the reload (R3)", () => {
  test("frozen from accept, through the other tabs' saves and the activation, until the reload", async () => {
    const origin = new FakeOrigin();
    const acting = await origin.tab().start();
    const other = await origin.tab().start();
    const mine = acting.form();
    mine.dirty = true;
    const theirs = other.form();
    theirs.dirty = true;
    theirs.result = "hold";
    const waiting = await origin.installNew(2);
    acting.actions?.accept();
    // Synchronously, before the save reads the form.
    expect(mine.frozen).toBe(true);
    expect(mine.saves).toBe(1);
    await origin.clock.advance(FLUSH_MAX_MS - 1);
    expect(mine.frozen).toBe(true);
    // A form that mounts while the tab waits is frozen too.
    const late = acting.form("task-edit:/tasks/2");
    expect(late.frozen).toBe(true);
    await origin.clock.advance(1);
    expect(skipWaitings(waiting)).toBe(1);
    expect(mine.frozen).toBe(true);
    await origin.clock.advance(ACTIVATION_FALLBACK_MS - 1);
    expect(acting.reloads).toBe(0);
    expect(mine.frozen).toBe(true);
    await origin.activate(waiting);
    expect(acting.reloads).toBe(1);
    // The page goes with its forms still frozen; the other tab's form was never frozen.
    expect(mine.frozen).toBe(true);
    expect(theirs.frozen).toBe(false);
    expect(theirs.freezes).toBe(0);
  });

  test("a failed save releases the forms (the person keeps working); a retry freezes them again", async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const form = tab.form();
    form.dirty = true;
    form.result = "failed";
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    expect(form.frozen).toBe(true);
    await flush();
    expect(tab.state).toEqual({ kind: "save_failed", refused: false });
    expect(form.frozen).toBe(false);
    form.result = "saved";
    tab.actions?.retrySave();
    expect(form.frozen).toBe(true);
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(skipWaitings(waiting)).toBe(1);
    expect(form.freezes).toBe(2);
  });

  test("a tab told by another tab to save is never frozen and never reloads", async () => {
    const origin = new FakeOrigin();
    const acting = await origin.tab().start();
    const other = await origin.tab().start();
    const theirs = other.form();
    theirs.dirty = true;
    const waiting = await origin.installNew(2);
    acting.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    await origin.activate(waiting);
    expect(theirs.saves).toBeGreaterThanOrEqual(1);
    expect(theirs.freezes).toBe(0);
    expect(other.reloads).toBe(0);
  });
});

/**
 * Revision 1, R6: "Discard and reload anyway" discards the copies of the dirty forms (the copy saved earlier and the one a form was restored
 * from would otherwise come back after the reload). A discard that does not land says so and reloads nothing; the person tries again or
 * chooses to reload anyway. A refusal while signing out is not a failure (the database goes with every copy in it).
 */
describe("'Discard and reload anyway' discards (R6)", () => {
  const failedSave = async () => {
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const form = tab.form();
    form.dirty = true;
    form.result = "failed";
    const waiting = await origin.installNew(2);
    tab.actions?.accept();
    await flush();
    expect(tab.state).toEqual({ kind: "save_failed", refused: false });
    return { origin, tab, form, waiting };
  };

  test("the dirty form's copies are discarded before the reload", async () => {
    const { origin, tab, form, waiting } = await failedSave();
    tab.actions?.discardAndReload();
    expect(form.frozen).toBe(true);
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(form.discards).toBe(1);
    expect(skipWaitings(waiting)).toBe(1);
    await origin.activate(waiting);
    expect(tab.reloads).toBe(1);
  });

  test("a discard that fails: discard_failed, nothing reloads, the form is released; 'Try again' then 'Reload anyway'", async () => {
    const { origin, tab, form, waiting } = await failedSave();
    form.discardResult = "failed";
    tab.actions?.discardAndReload();
    await flush();
    expect(tab.state).toEqual({ kind: "discard_failed" });
    expect(form.frozen).toBe(false);
    await origin.clock.advance(ACTIVATION_FALLBACK_MS * 2);
    expect(skipWaitings(waiting)).toBe(0);
    expect(tab.reloads).toBe(0);
    // "Try again" discards again (and fails again).
    tab.actions?.discardAndReload();
    await flush();
    expect(form.discards).toBe(2);
    expect(tab.state).toEqual({ kind: "discard_failed" });
    // "Reload anyway": the person knows the copy may come back.
    tab.actions?.reloadAnyway();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(form.discards).toBe(2);
    expect(skipWaitings(waiting)).toBe(1);
    await origin.activate(waiting);
    expect(tab.reloads).toBe(1);
  });

  test("a discard refused while signing out proceeds (the database is deleted with every copy)", async () => {
    const { origin, tab, form, waiting } = await failedSave();
    form.discardResult = "refused";
    tab.actions?.discardAndReload();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
    expect(skipWaitings(waiting)).toBe(1);
    expect(form.discards).toBe(1);
  });
});
