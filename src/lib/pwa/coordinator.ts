import type { DiscardResult, SaveResult } from "../form-recovery/port";
import {
  discardDirty,
  flushDirty,
  type RecoverableFormHandle,
  type RecoverableFormRegistry,
} from "../form-recovery/registry";
import {
  parseChannelMessage,
  parseReportAck,
  type ReportAck,
  type ToWorker,
  type UpdateChannelMessage,
} from "./protocol";
import type { AppUpdatesActions, UpdateState } from "./store";

/**
 * THE APP-UPDATE COORDINATOR of one tab (WEB-14a, D-P4 and D-P5; WEB-04 8 and wireframe 6; Q4). Loaded lazily after the session has
 * started, in builds that ship the service worker. It registers `/sw.js`, follows the registration, derives this tab's update state, and
 * applies an update ONLY when the person asks, and only in this tab:
 *
 *  - A newer version installed and waiting shows "available" in every tab (each tab follows its own registration object, and a tab that
 *    saw it says so on the channel).
 *  - "Reload" saves this tab's unfinished forms first (Q4: a failure keeps the form open with "Retry save" / "Discard and reload anyway",
 *    and the update stays pending), asks every other tab to save theirs and waits for them (bounded), then tells the WAITING worker to
 *    skip waiting and reloads when the new worker is active (or after `ACTIVATION_FALLBACK_MS`, against whatever is active then).
 *  - A tab whose version another tab replaced shows "updated in another tab": a controller change it did not ask for, or a report
 *    answered with a newer active generation (which also covers a frozen tab that missed both, when it comes back).
 *  - From the moment the person accepts until the page reloads, every form of this tab is FROZEN (revision 1, R3): the waits for the
 *    other tabs and the activation can last seconds, and input typed after the last save would be lost by the reload. The freeze is also
 *    the forms' LOCK (revision 2, R3): the recovery actions that would change a form (another copy, "Discard instead", a new submission)
 *    are refused while it stands. A failure (a save or a discard that did not land) releases them: the person keeps working.
 *  - A RELOAD NEEDS A CHECKPOINT (revision 2, R3). Every way to the reload (the activation, the controller change, the fallback, no
 *    waiting worker, a refused skip-waiting message) goes through ONE check, made in the same step as the reload: nothing of this tab's
 *    forms is outstanding (a save, a discard, a submission sent before the person accepted), every form is held still, and none is dirty
 *    (in a discard, none still holds input that was not discarded). Work that arrived during the waits (a form mounted again with its
 *    input, a submission that succeeded) is settled first; what cannot be settled stops this tab's reload and is shown, never lost.
 *  - "Discard and reload anyway" DISCARDS the copies of the dirty forms (revision 1, R6: the copy saved earlier and the one a form was
 *    restored from would otherwise come back after the reload); a discard that does not land says so (`discard_failed`) and reloads nothing.
 *  - It NEVER reloads on its own: only `accept`, `retrySave`, `discardAndReload` and `reloadAnyway` lead to `reload()`.
 *
 * It also checks for updates: at start (registration), on `online`, on a return to the page at most every `UPDATE_CHECK_VISIBLE_MIN_MS`,
 * every `UPDATE_CHECK_INTERVAL_MS` while visible, and when the server's API version is `unsupported` (at most every
 * `UPDATE_CHECK_UNSUPPORTED_MIN_MS`): a newer client may be what the server needs. Every timing below is a production constant.
 */
export const UPDATE_CHECK_VISIBLE_MIN_MS = 15 * 60_000;
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000;
export const UPDATE_CHECK_UNSUPPORTED_MIN_MS = 60_000;
/** How long the acting tab waits for other tabs to say they are saving. */
export const FLUSH_START_GRACE_MS = 500;
/** The longest the acting tab waits for other tabs' saves, in all. */
export const FLUSH_MAX_MS = 5_000;
/** After skip-waiting, the reload happens at activation, or after this long whatever happened. */
export const ACTIVATION_FALLBACK_MS = 10_000;
/** An unanswered or unacknowledged report is sent again, from this pace doubling to the maximum. */
export const REPORT_RETRY_INITIAL_MS = 1_000;
export const REPORT_RETRY_MAX_MS = 60_000;
/** A report with no answer in this long is unacknowledged. */
export const REPORT_ACK_TIMEOUT_MS = 5_000;

export interface WorkerLike {
  readonly state: string;
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  addEventListener(type: "statechange", listener: () => void): void;
  removeEventListener(type: "statechange", listener: () => void): void;
}
export interface RegistrationLike {
  readonly installing: WorkerLike | null;
  readonly waiting: WorkerLike | null;
  readonly active: WorkerLike | null;
  update(): Promise<unknown>;
  addEventListener(type: "updatefound", listener: () => void): void;
  removeEventListener(type: "updatefound", listener: () => void): void;
}
export interface ContainerLike {
  readonly controller: WorkerLike | null;
  register(
    url: string,
    options: { scope: string; updateViaCache: "none" },
  ): Promise<RegistrationLike>;
  addEventListener(type: "controllerchange", listener: () => void): void;
  removeEventListener(type: "controllerchange", listener: () => void): void;
}
export interface PortLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}
export interface ChannelLike {
  postMessage(message: UpdateChannelMessage): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  close(): void;
}
export type PageSignal = "visible" | "focus" | "pageshow" | "online";

export interface UpdateCoordinatorDeps {
  /** The page's service-worker container; null where there is none (no worker: the forms and supersession still work). */
  container: ContainerLike | null;
  /** This page's own hashed entry-script path (`/assets/index-<hash>.js`), or null. */
  entry: string | null;
  page: {
    on(signal: PageSignal, listener: () => void): () => void;
    isVisible(): boolean;
  };
  clock: {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  ids: { uuid(): string };
  /** Opens the channel to the other tabs; null where there is none. */
  channel(): ChannelLike | null;
  /** A pair of ports for a report's answer; null where there is none. */
  messageChannel(): { port: PortLike; transfer: Transferable } | null;
  forms: RecoverableFormRegistry;
  /** The session's API compatibility (only `unsupported` is read here). */
  compat: {
    get(): { status: string };
    subscribe(listener: () => void): () => void;
  };
  /** The data layer's supersession signal (D-P8). */
  onDataSuperseded(listener: () => void): () => void;
  reload(): void;
  publish(state: UpdateState, actions: AppUpdatesActions): void;
}

export interface AppUpdateCoordinator {
  dispose(): void;
  registration(): Promise<RegistrationLike | null>;
}

type Mode = "save" | "discard" | "anyway";

/** How many times the forms are settled before a reload is given up (work keeps arriving): each round waits for what is outstanding. */
const SETTLE_ROUNDS = 3;

type Busy =
  | { kind: "saving" }
  | { kind: "save_failed"; refused: boolean }
  | { kind: "discard_failed" }
  | { kind: "reloading" };

const verdict = (results: readonly SaveResult[]): Busy | null =>
  results.includes("refused")
    ? { kind: "save_failed", refused: true }
    : results.includes("failed")
      ? { kind: "save_failed", refused: false }
      : null;

export function startAppUpdates(
  deps: UpdateCoordinatorDeps,
): AppUpdateCoordinator {
  const { clock } = deps;
  let disposed = false;
  const offs: Array<() => void> = [];
  const timers = new Set<unknown>();
  const after = (ms: number, fn: () => void): unknown => {
    const handle = clock.setTimeout(() => {
      timers.delete(handle);
      if (!disposed) fn();
    }, ms);
    timers.add(handle);
    return handle;
  };
  const cancel = (handle: unknown): void => {
    if (handle === null || handle === undefined) return;
    timers.delete(handle);
    clock.clearTimeout(handle);
  };

  // ---- the facts this tab's state is derived from -------------------------------------------------------------------------------
  let registration: RegistrationLike | null = null;
  let elsewhere = false;
  let superseded = false;
  let dismissed = false;
  let busy: Busy | null = null;
  /** The reload has been asked for: nothing else is ever done again. */
  let reloaded = false;

  const derive = (): UpdateState => {
    if (busy) return busy;
    if (superseded) return { kind: "data_superseded" };
    if (elsewhere) return { kind: "updated_elsewhere", dismissed };
    if (registration?.waiting) return { kind: "available", dismissed };
    return { kind: "none" };
  };
  let published: string | null = null;
  const publish = (): void => {
    if (disposed) return;
    const state = derive();
    const key = JSON.stringify(state);
    if (key === published) return;
    published = key;
    deps.publish(state, actions);
  };

  /** The act this tab's reload is for (revision 2): what the checkpoint asks of the forms. */
  let mode: Mode = "save";
  /** The forms whose discard was refused in this act (the account is being signed out: the database goes with every copy). */
  let refused = new Set<RecoverableFormHandle>();
  /** Whether the reload may happen NOW (R3): read in the same step as the reload, never across an await. */
  const sealed = (): boolean => {
    if (mode === "anyway") return true;
    const forms = deps.forms;
    if (forms.pending() > 0 || forms.unheld() > 0) return false;
    return forms.dirty().every((form) => refused.has(form));
  };
  let resealing = false;
  /** The ONLY way to `deps.reload()`: checked and done in one step; otherwise this tab's forms are settled again first. */
  const reload = (): void => {
    if (reloaded || disposed) return;
    if (!sealed()) {
      void reseal();
      return;
    }
    reloaded = true;
    busy = { kind: "reloading" };
    publish();
    deps.reload();
  };
  /** Work arrived after the forms were settled (a remount, a submission's success): settled again, then the check; or this tab stays. */
  const reseal = async (): Promise<void> => {
    if (resealing) return;
    resealing = true;
    const settledAgain = await settleForms(mode);
    resealing = false;
    if (disposed || reloaded) return;
    if (settledAgain && sealed()) {
      reload();
      return;
    }
    // This tab does not reload: the person keeps working (a worker may have activated for the other tabs; this tab's input is not lost).
    stopAccepting();
    if (!busy || busy.kind === "reloading" || busy.kind === "saving")
      busy = { kind: "save_failed", refused: false };
    publish();
    unfreeze();
  };

  // ---- other tabs ----------------------------------------------------------------------------------------------------------------
  const channel = deps.channel();
  /** The acting tab's wait for the other tabs' saves: `started` ids answered within the grace, `done` ids that finished. */
  let collecting: {
    id: string;
    started: Set<string>;
    done: Set<string>;
    settle: () => void;
  } | null = null;
  const onChannel = (event: { data: unknown }): void => {
    const message = parseChannelMessage(event.data);
    if (!message || disposed) return;
    switch (message.type) {
      case "flush-request": {
        // Another tab is applying an update: save this tab's input (a copy only) and say so. Never reload.
        const dirty = deps.forms.dirty().length;
        const responder = deps.ids.uuid();
        channel?.postMessage({
          type: "flush-started",
          id: `${message.id}:${responder}`,
          dirty,
        });
        void flushDirty(deps.forms).then((results) => {
          channel?.postMessage({
            type: "flush-done",
            id: `${message.id}:${responder}`,
            failed: results.filter((result) => result !== "saved").length,
          });
        });
        return;
      }
      case "flush-started":
      case "flush-done": {
        const wait = collecting;
        if (!wait || !message.id.startsWith(`${wait.id}:`)) return;
        (message.type === "flush-started" ? wait.started : wait.done).add(
          message.id,
        );
        wait.settle();
        return;
      }
      case "update-available":
        // Another tab saw an installed version. This tab's registration says the same, or is asked.
        if (registration && !registration.waiting) void checkForUpdate(true);
        publish();
        return;
    }
  };
  if (channel) {
    channel.addEventListener("message", onChannel);
    offs.push(() => {
      channel.removeEventListener("message", onChannel);
      channel.close();
    });
  }

  /** Asks every other tab to save its input, and waits: for the tabs that answer within the grace, until they have finished, bounded. */
  const flushOthers = (): Promise<void> =>
    new Promise((resolve) => {
      if (!channel) {
        resolve();
        return;
      }
      const id = deps.ids.uuid();
      let graceOver = false;
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        cancel(grace);
        cancel(bound);
        collecting = null;
        resolve();
      };
      const wait = {
        id,
        started: new Set<string>(),
        done: new Set<string>(),
        settle: () => {
          if (!graceOver) return;
          for (const started of wait.started)
            if (!wait.done.has(started)) return;
          finish();
        },
      };
      collecting = wait;
      const grace = after(FLUSH_START_GRACE_MS, () => {
        graceOver = true;
        wait.settle();
      });
      const bound = after(FLUSH_MAX_MS, finish);
      channel.postMessage({ type: "flush-request", id });
    });

  // ---- reports and the generations -----------------------------------------------------------------------------------------------
  let reporting = false;
  let reportAgain = false;
  let reportStep = 0;
  let reportRetry: unknown = null;
  const target = (): WorkerLike | null =>
    deps.container?.controller ?? registration?.active ?? null;
  const onAck = (ack: ReportAck | null): void => {
    reporting = false;
    if (ack?.generation) {
      reportStep = 0;
      cancel(reportRetry);
      reportRetry = null;
      if (ack.newer) noteElsewhere();
    } else scheduleReport();
    if (reportAgain) {
      reportAgain = false;
      report();
    }
  };
  const scheduleReport = (): void => {
    if (reportRetry !== null) return;
    const wait = Math.min(
      REPORT_RETRY_MAX_MS,
      REPORT_RETRY_INITIAL_MS * 2 ** reportStep,
    );
    reportStep += 1;
    reportRetry = after(wait, () => {
      reportRetry = null;
      report();
    });
  };
  /** Tells the worker which build this page runs (retention), and learns whether a newer one is active. One at a time. */
  const report = (): void => {
    if (disposed || reloaded || deps.entry === null) return;
    if (reporting) {
      reportAgain = true;
      return;
    }
    const worker = target();
    const pair = deps.messageChannel();
    if (!worker || !pair) {
      scheduleReport();
      return;
    }
    reporting = true;
    const nonce = deps.ids.uuid();
    let answered = false;
    const timeout = after(REPORT_ACK_TIMEOUT_MS, () => {
      if (answered) return;
      answered = true;
      pair.port.close();
      onAck(null);
    });
    pair.port.onmessage = (event) => {
      const ack = parseReportAck(event.data);
      if (answered || !ack || ack.nonce !== nonce) return;
      answered = true;
      cancel(timeout);
      pair.port.close();
      if (!disposed) onAck(ack);
    };
    try {
      worker.postMessage({ type: "atlas:report", entry: deps.entry, nonce }, [
        pair.transfer,
      ]);
    } catch {
      answered = true;
      cancel(timeout);
      pair.port.close();
      onAck(null);
    }
  };

  /** Another tab applied a newer version: this tab says so, and saves its input as a precaution (a copy; nothing reloads). */
  const noteElsewhere = (): void => {
    if (elsewhere) return;
    elsewhere = true;
    dismissed = false;
    publish();
    void flushDirty(deps.forms);
  };

  // ---- the registration ----------------------------------------------------------------------------------------------------------
  let lastCheck = Number.NEGATIVE_INFINITY;
  let lastUnsupportedCheck = Number.NEGATIVE_INFINITY;
  const checkForUpdate = async (force = false): Promise<void> => {
    if (!registration || disposed) return;
    if (!force && clock.now() - lastCheck < UPDATE_CHECK_VISIBLE_MIN_MS) return;
    lastCheck = clock.now();
    try {
      await registration.update();
    } catch {
      // Offline, or the script could not be fetched: the next trigger asks again.
    }
  };

  /** Follows one worker's state: installed (waiting) shows the banner; activated (by any tab) is reported again. */
  const followed = new Set<WorkerLike>();
  const follow = (worker: WorkerLike | null): void => {
    if (!worker || followed.has(worker)) return;
    followed.add(worker);
    const onState = (): void => {
      if (worker.state === "installed") {
        channel?.postMessage({ type: "update-available" });
        dismissed = false;
      }
      if (worker.state === "activated") {
        if (accepting) reload();
        else report();
      }
      publish();
    };
    worker.addEventListener("statechange", onState);
    offs.push(() => worker.removeEventListener("statechange", onState));
  };
  const onUpdateFound = (): void => {
    follow(registration?.installing ?? null);
    publish();
  };

  /** The controller this page had before the latest change: a change from a real controller that this tab did not ask for is another tab's. */
  let controller = deps.container?.controller ?? null;
  let accepting = false;
  const onControllerChange = (): void => {
    const previous = controller;
    controller = deps.container?.controller ?? null;
    if (accepting) {
      reload();
      return;
    }
    // A first install never claims a page (the worker calls no `clients.claim()`), so a change from no controller is not "another tab".
    if (previous !== null) noteElsewhere();
    report();
  };

  const ready: Promise<RegistrationLike | null> = (async () => {
    const container = deps.container;
    if (!container) return null;
    container.addEventListener("controllerchange", onControllerChange);
    offs.push(() =>
      container.removeEventListener("controllerchange", onControllerChange),
    );
    try {
      const registered = await container.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });
      if (disposed) return registered;
      registration = registered;
      lastCheck = clock.now();
      registered.addEventListener("updatefound", onUpdateFound);
      offs.push(() =>
        registered.removeEventListener("updatefound", onUpdateFound),
      );
      follow(registered.installing);
      follow(registered.waiting);
      publish();
      report();
      // An answer that came before the registration could not ask for a newer client: it asks now.
      checkIfUnsupported();
      return registered;
    } catch {
      // No worker this time (an engine without one, a failed fetch of the script): the next page load registers again.
      return null;
    }
  })();

  // ---- the person's actions ------------------------------------------------------------------------------------------------------
  /**
   * Settles this tab's forms for the act (revision 2, R3): waits for what is outstanding (a save, a discard, a submission sent before the
   * person accepted), then saves (or, in a discard, discards) every form that still needs it, until the checkpoint holds; `true` when it
   * does. A save or discard that does not land is shown (`save_failed`, `discard_failed`) and nothing reloads.
   */
  const settleForms = async (act: Mode): Promise<boolean> => {
    if (act === "anyway") return true;
    for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
      if (deps.forms.pending() > 0) {
        busy = { kind: "saving" };
        publish();
        await deps.forms.settled();
        if (disposed) return false;
        // What settled may have started more (a submission's success discards the copies): that is waited for first.
        if (deps.forms.pending() > 0) continue;
      }
      if (sealed()) return true;
      if (act === "save") {
        if (deps.forms.dirty().length > 0) {
          busy = { kind: "saving" };
          publish();
          const failed = verdict(await flushDirty(deps.forms));
          if (disposed) return false;
          if (failed) {
            busy = failed;
            publish();
            return false;
          }
        }
      } else {
        const forms = deps.forms.dirty().filter((form) => !refused.has(form));
        const results: DiscardResult[] = await discardDirty(deps.forms, forms);
        if (disposed) return false;
        if (results.includes("failed")) {
          busy = { kind: "discard_failed" };
          publish();
          return false;
        }
        forms.forEach((form, index) => {
          if (results[index] === "refused") refused.add(form);
        });
      }
      if (sealed()) return true;
    }
    if (deps.forms.pending() > 0) await deps.forms.settled();
    if (disposed) return false;
    if (sealed()) return true;
    // Work kept arriving (or a form cannot be held still): this tab does not reload, and says it could not save.
    busy = { kind: "save_failed", refused: false };
    publish();
    return false;
  };

  /** The fallback of the act waiting for the activation; cancelled when the act stops. */
  let fallback: unknown = null;
  const stopAccepting = (): void => {
    accepting = false;
    cancel(fallback);
    fallback = null;
  };

  /** The other tabs save, then this tab moves onto the newer version: the waiting worker is activated, or (another tab's) the page reloads. */
  const apply = async (): Promise<void> => {
    busy = { kind: "reloading" };
    publish();
    const wasElsewhere = elsewhere;
    await flushOthers();
    if (disposed || reloaded) return;
    const waiting = registration?.waiting ?? null;
    if (wasElsewhere || !waiting) {
      reload();
      return;
    }
    accepting = true;
    follow(waiting);
    fallback = after(ACTIVATION_FALLBACK_MS, () => {
      fallback = null;
      if (accepting) reload();
    });
    try {
      waiting.postMessage({ type: "atlas:skip-waiting" });
    } catch {
      reload();
      return;
    }
    // Activated before this listener could see it (another tab accepted too): nothing more will change.
    if (waiting.state === "activated" || waiting.state === "redundant")
      reload();
  };

  /** The freeze in force while this tab acts (R3), released when the act ends without a reload. */
  let frozen: (() => void) | null = null;
  const unfreeze = (): void => {
    frozen?.();
    frozen = null;
  };
  offs.push(unfreeze);

  let acting = false;
  const act = async (next: Mode): Promise<void> => {
    if (acting || accepting || resealing || reloaded || disposed) return;
    acting = true;
    mode = next;
    refused = new Set();
    // Synchronously, before the save reads the forms: nothing typed from now on could be saved before the reload.
    frozen ??= deps.forms.freeze();
    try {
      if (!(await settleForms(next))) return;
      await apply();
    } finally {
      acting = false;
      // The reload has been asked for (the page goes with its forms frozen), or the act stopped: the person keeps working.
      if (!reloaded && !accepting && !resealing) unfreeze();
    }
  };

  /** The server's API version is outside this client's range: a newer client may be what it needs (at most every 60 s, once registered). */
  function checkIfUnsupported(): void {
    if (!registration || deps.compat.get().status !== "unsupported") return;
    if (clock.now() - lastUnsupportedCheck < UPDATE_CHECK_UNSUPPORTED_MIN_MS)
      return;
    lastUnsupportedCheck = clock.now();
    void checkForUpdate(true);
  }

  const actions: AppUpdatesActions = {
    accept: () => void act("save"),
    retrySave: () => void act("save"),
    discardAndReload: () => void act("discard"),
    reloadAnyway: () => void act("anyway"),
    notNow: () => {
      if (busy) return;
      dismissed = true;
      publish();
    },
  };

  // ---- triggers ------------------------------------------------------------------------------------------------------------------
  const returned = (): void => {
    // A dismissed banner reappears on the next return to the page; a frozen tab that missed the change finds out by reporting.
    if (dismissed) {
      dismissed = false;
      publish();
    }
    report();
    void checkForUpdate();
  };
  offs.push(
    deps.page.on("visible", returned),
    deps.page.on("focus", returned),
    deps.page.on("pageshow", returned),
    deps.page.on("online", () => void checkForUpdate(true)),
    deps.onDataSuperseded(() => {
      if (superseded) return;
      superseded = true;
      publish();
    }),
    deps.compat.subscribe(checkIfUnsupported),
  );
  const hourly = (): void => {
    after(UPDATE_CHECK_INTERVAL_MS, () => {
      if (deps.page.isVisible()) void checkForUpdate(true);
      hourly();
    });
  };
  hourly();
  publish();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const handle of [...timers]) cancel(handle);
      for (const off of offs.splice(0)) off();
    },
    registration: () => ready,
  };
}
