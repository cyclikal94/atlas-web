import type {
  DiscardResult,
  SaveResult,
} from "../../src/lib/form-recovery/port";
import {
  createRecoverableFormRegistry,
  type RecoverableFormRegistry,
} from "../../src/lib/form-recovery/registry";
import {
  type AppUpdateCoordinator,
  type ChannelLike,
  type ContainerLike,
  type PageSignal,
  type PortLike,
  type RegistrationLike,
  startAppUpdates,
  type UpdateCoordinatorDeps,
  type WorkerLike,
} from "../../src/lib/pwa/coordinator";
import type {
  ToWorker,
  UpdateChannelMessage,
} from "../../src/lib/pwa/protocol";
import type { AppUpdatesActions, UpdateState } from "../../src/lib/pwa/store";

/**
 * A deterministic world for the app-update coordinator (WEB-14a): a manual clock, a double of one origin's service-worker registration
 * as each tab sees it, MessagePorts, a BroadcastChannel bus between tabs, and recoverable forms. FIXTURE evidence: the real engines are
 * the `fixture.pwa-*` specs.
 */
export class Clock {
  time = 0;
  now = (): number => this.time;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private next = 1;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };
  /** Runs every timer due up to `now + ms`, in order, letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await flush();
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.fn();
    }
    this.time = target;
    await flush();
  }
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

type Listener = () => void;

export class FakeWorker implements WorkerLike {
  readonly messages: Array<{ message: ToWorker; transfer?: Transferable[] }> =
    [];
  private listeners = new Set<Listener>();
  constructor(
    public state: string,
    readonly name: string,
    private readonly origin: FakeOrigin,
  ) {}
  postMessage(message: ToWorker, transfer?: Transferable[]): void {
    this.messages.push(
      transfer === undefined ? { message } : { message, transfer },
    );
    this.origin.received(this, message, transfer);
  }
  addEventListener(_type: "statechange", listener: Listener): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "statechange", listener: Listener): void {
    this.listeners.delete(listener);
  }
  setState(state: string): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

export class FakeRegistration implements RegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  updates = 0;
  private listeners = new Set<Listener>();
  async update(): Promise<unknown> {
    this.updates += 1;
    return undefined;
  }
  addEventListener(_type: "updatefound", listener: Listener): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "updatefound", listener: Listener): void {
    this.listeners.delete(listener);
  }
  fireUpdateFound(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export class FakeContainer implements ContainerLike {
  readonly registrations: Array<{ url: string; options: unknown }> = [];
  private listeners = new Set<Listener>();
  constructor(
    public controller: FakeWorker | null,
    readonly registration: FakeRegistration,
  ) {}
  async register(
    url: string,
    options: { scope: string; updateViaCache: "none" },
  ): Promise<RegistrationLike> {
    this.registrations.push({ url, options });
    return this.registration;
  }
  addEventListener(_type: "controllerchange", listener: Listener): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "controllerchange", listener: Listener): void {
    this.listeners.delete(listener);
  }
  changeController(worker: FakeWorker | null): void {
    this.controller = worker;
    for (const listener of [...this.listeners]) listener();
  }
}

class FakePort implements PortLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
}

/**
 * The origin: which generation each worker serves, how reports are answered (`answer`), and the tabs. Each tab has its own container and
 * registration object, as each window has its own; `installNew` and `activate` change all of them, as the browser does.
 */
export class FakeOrigin {
  readonly clock = new Clock();
  readonly tabs: Tab[] = [];
  readonly bus = new Set<FakeChannel>();
  /** How a report is answered: by default with the reporting tab's generation and `newer` from the active worker's. */
  answer: "ack" | "silent" | "unknown" = "ack";
  private ports = new Map<Transferable, FakePort>();
  /** The generation each worker serves, and the order they were installed in. */
  private generations = new Map<FakeWorker, number>();
  active: FakeWorker;

  constructor() {
    this.active = this.worker("activated", 1);
  }

  worker(state: string, generation: number): FakeWorker {
    const worker = new FakeWorker(state, `gen-${generation}`, this);
    this.generations.set(worker, generation);
    return worker;
  }

  port(): { port: PortLike; transfer: Transferable } {
    const port = new FakePort();
    const transfer = {} as Transferable;
    this.ports.set(transfer, port);
    return { port, transfer };
  }

  received(
    worker: FakeWorker,
    message: ToWorker,
    transfer?: Transferable[],
  ): void {
    if (message.type !== "atlas:report") return;
    const port = transfer?.[0] ? this.ports.get(transfer[0]) : undefined;
    if (!port || this.answer === "silent") return;
    const tab = this.tabs.find(
      (candidate) => candidate.entry === message.entry,
    );
    const pageGeneration = tab?.generation ?? null;
    const active = this.generations.get(worker) ?? 0;
    void Promise.resolve().then(() =>
      port.onmessage?.({
        data: {
          type: "atlas:report-ack",
          nonce: message.nonce,
          generation:
            this.answer === "unknown" || pageGeneration === null
              ? null
              : `g${pageGeneration}`,
          active: `g${active}`,
          newer: pageGeneration !== null && active > pageGeneration,
        },
      }),
    );
  }

  /** A newer version is found and installed: it becomes the waiting worker of every tab's registration. */
  async installNew(generation: number): Promise<FakeWorker> {
    const worker = this.worker("installing", generation);
    for (const tab of this.tabs) {
      tab.registration.installing = worker;
      tab.registration.fireUpdateFound();
    }
    await flush();
    for (const tab of this.tabs) {
      tab.registration.installing = null;
      tab.registration.waiting = worker;
    }
    worker.setState("installed");
    await flush();
    return worker;
  }

  /** The waiting worker activates (some tab asked it to): it is every registration's active worker and every CONTROLLED tab's controller. */
  async activate(worker: FakeWorker): Promise<void> {
    worker.setState("activating");
    for (const tab of this.tabs) {
      tab.registration.waiting = null;
      tab.registration.active = worker;
    }
    this.active = worker;
    worker.setState("activated");
    for (const tab of this.tabs)
      if (tab.container.controller !== null)
        tab.container.changeController(worker);
    await flush();
  }

  tab(options: { controlled?: boolean; generation?: number } = {}): Tab {
    const tab = new Tab(this, options.controlled ?? true, options.generation);
    this.tabs.push(tab);
    return tab;
  }
}

export class FakeChannel implements ChannelLike {
  private listeners = new Set<(event: { data: unknown }) => void>();
  readonly sent: UpdateChannelMessage[] = [];
  closed = false;
  constructor(private readonly bus: Set<FakeChannel>) {
    bus.add(this);
  }
  postMessage(message: UpdateChannelMessage): void {
    this.sent.push(message);
    for (const other of this.bus)
      if (other !== this && !other.closed)
        void Promise.resolve().then(() => other.deliver(message));
  }
  deliver(data: unknown): void {
    for (const listener of [...this.listeners]) listener({ data });
  }
  addEventListener(
    _type: "message",
    listener: (event: { data: unknown }) => void,
  ): void {
    this.listeners.add(listener);
  }
  removeEventListener(
    _type: "message",
    listener: (event: { data: unknown }) => void,
  ): void {
    this.listeners.delete(listener);
  }
  close(): void {
    this.closed = true;
    this.bus.delete(this);
  }
}

/**
 * A recoverable form as the coordinator sees it (its registry handle). Revision 2: it behaves as the real form does in the two ways the
 * reload checkpoint reads: a save that lands makes it clean unless it was edited after the save captured it (`dirty = true` is an edit),
 * a discard that lands makes it clean, and every save, discard or `submit()` is OUTSTANDING (`settled`) until it settles.
 */
export class FakeForm {
  private edited = false;
  private edits = 0;
  get dirty(): boolean {
    return this.edited;
  }
  set dirty(value: boolean) {
    this.edited = value;
    if (value) this.edits += 1;
  }
  saves = 0;
  /** What each save answers; `hold` keeps it pending until `release`. */
  result: SaveResult | "hold" = "saved";
  private pending: Array<(result: SaveResult) => void> = [];
  private outstanding = new Set<Promise<unknown>>();
  constructor(readonly formContext: string) {}
  private track<T>(operation: Promise<T>): Promise<T> {
    this.outstanding.add(operation);
    const settle = () => this.outstanding.delete(operation);
    operation.then(settle, settle);
    return operation;
  }
  isDirty = () => this.dirty;
  flush = (): Promise<SaveResult> => {
    this.saves += 1;
    const captured = this.edits;
    const answer: Promise<SaveResult> =
      this.result === "hold"
        ? new Promise((resolve) => this.pending.push(resolve))
        : Promise.resolve(this.result);
    return this.track(
      answer.then((result) => {
        if (result === "saved" && this.edits === captured) this.edited = false;
        return result;
      }),
    );
  };
  release(result: SaveResult = "saved"): void {
    for (const resolve of this.pending.splice(0)) resolve(result);
  }
  /** Revision 1 (R6): what each discard answers, and how many were asked for. */
  discards = 0;
  discardResult: DiscardResult = "discarded";
  discard = (): Promise<DiscardResult> => {
    this.discards += 1;
    const result = this.discardResult;
    return this.track(
      Promise.resolve(result).then((answer) => {
        if (answer === "discarded") this.edited = false;
        return answer;
      }),
    );
  };
  /**
   * Revision 2 (R3): a submission sent before the person accepted, answered when the test says: `succeeded` discards the form's copies
   * (the form is then clean: it shows what was submitted), `failed` leaves it as it was.
   */
  submit(): { succeeded(): void; failed(): void } {
    let settle: () => void = () => undefined;
    this.track(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    return {
      succeeded: () => {
        void this.discard();
        settle();
      },
      failed: () => settle(),
    };
  }
  settled = (): Promise<void> | null =>
    this.outstanding.size === 0
      ? null
      : Promise.allSettled([...this.outstanding]).then(() => undefined);
  /** Revision 1 (R3): whether the form is frozen now, and how often it was. */
  frozen = false;
  freezes = 0;
  freeze = (): (() => void) => {
    this.frozen = true;
    this.freezes += 1;
    return () => {
      this.frozen = false;
    };
  };
}

export class Tab {
  readonly registration = new FakeRegistration();
  readonly container: FakeContainer;
  readonly channel: FakeChannel;
  readonly forms: RecoverableFormRegistry = createRecoverableFormRegistry();
  readonly states: UpdateState[] = [];
  actions: AppUpdatesActions | null = null;
  reloads = 0;
  visible = true;
  readonly entry: string;
  readonly generation: number;
  compatStatus = "supported";
  private compatListeners = new Set<Listener>();
  private signals = new Map<PageSignal, Set<Listener>>();
  private supersededListeners = new Set<Listener>();
  /** Revision 17 (R24): the coordinator's navigation listeners, and how often a check or a report followed (none may). */
  readonly navigationListeners = new Set<Listener>();
  coordinator: AppUpdateCoordinator | null = null;

  constructor(
    private readonly origin: FakeOrigin,
    controlled: boolean,
    generation?: number,
  ) {
    this.generation = generation ?? 1;
    this.entry = `/assets/index-g${this.generation}-${origin.tabs.length}.js`;
    this.registration.active = origin.active;
    this.container = new FakeContainer(
      controlled ? origin.active : null,
      this.registration,
    );
    this.channel = new FakeChannel(origin.bus);
  }

  /**
   * `production` (revision 17, R24): the page's real navigation signal instead of `navigate()`, and the real update store as well as
   * `states`, for a test that composes the coordinator with the router and the banner.
   */
  async start(
    production: Partial<
      Pick<UpdateCoordinatorDeps, "onNavigation" | "publish">
    > = {},
  ): Promise<this> {
    const origin = this.origin;
    this.coordinator = startAppUpdates({
      container: this.container,
      entry: this.entry,
      page: {
        on: (signal, listener) => {
          let set = this.signals.get(signal);
          if (!set) {
            set = new Set();
            this.signals.set(signal, set);
          }
          set.add(listener);
          return () => set?.delete(listener);
        },
        isVisible: () => this.visible,
      },
      clock: origin.clock,
      ids: { uuid: () => `id-${Math.random().toString(36).slice(2)}` },
      channel: () => this.channel,
      messageChannel: () => origin.port(),
      forms: this.forms,
      compat: {
        get: () => ({ status: this.compatStatus }),
        subscribe: (listener) => {
          this.compatListeners.add(listener);
          return () => this.compatListeners.delete(listener);
        },
      },
      onDataSuperseded: (listener) => {
        this.supersededListeners.add(listener);
        return () => this.supersededListeners.delete(listener);
      },
      onNavigation:
        production.onNavigation ??
        ((listener) => {
          this.navigationListeners.add(listener);
          return () => this.navigationListeners.delete(listener);
        }),
      reload: () => {
        this.reloads += 1;
      },
      publish: (state, actions) => {
        this.states.push(state);
        this.actions = actions;
        production.publish?.(state, actions);
      },
    });
    await this.coordinator.registration();
    await flush();
    return this;
  }

  get state(): UpdateState {
    return this.states.at(-1) ?? { kind: "none" };
  }
  emit(signal: PageSignal): void {
    for (const listener of [...(this.signals.get(signal) ?? [])]) listener();
  }
  setCompat(status: string): void {
    this.compatStatus = status;
    for (const listener of [...this.compatListeners]) listener();
  }
  supersede(): void {
    for (const listener of [...this.supersededListeners]) listener();
  }
  /** Revision 17 (R24): the router of this tab rendered another destination. */
  navigate(): void {
    for (const listener of [...this.navigationListeners]) listener();
  }
  form(context = "task-edit:/tasks/1"): FakeForm {
    const form = new FakeForm(context);
    this.forms.register(form);
    return form;
  }
}
