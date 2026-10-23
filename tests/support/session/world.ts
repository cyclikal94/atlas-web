/**
 * A deterministic simulated world (plan section 13.1). The production kernel runs UNCHANGED on fake ports; nothing
 * sleeps, nothing is random except a seeded PRNG, and every delivery of an asynchronous completion is an explicit
 * event with a delay knob. `unbounded` holds a delivery until the test releases it.
 */
export type DeliveryKind =
  | "store_start"
  | "D0" // a store transaction's `complete` event, delivered to the page
  | "D1" // publication of a lock release
  | "D2" // delivery of a broadcast hint
  | "D3" // the render task that runs `act`
  | "Da" // the server's answer reaching the page
  | "Db" // the body of that answer reaching the page (headers first, body later: decoding is asynchronous)
  | "lock_grant"
  | "timer"
  | "misc";

export type Knob = number | "unbounded";

export interface EventMeta {
  page?: string | null;
  [key: string]: unknown;
}

interface WorldEvent {
  id: number;
  time: number;
  seq: number;
  kind: DeliveryKind;
  page: string | null;
  meta: EventMeta;
  run: () => void;
}

export interface LogEntry {
  seq: number;
  t: number;
  type: string;
  page?: string | null;
  [key: string]: unknown;
}

export interface KnobRule {
  kind: DeliveryKind;
  match?: (meta: EventMeta) => boolean;
  value: Knob;
}

interface PageState {
  destroyed: boolean;
  frozen: boolean;
}

const flushTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

export class World {
  time = 0;
  readonly logs: LogEntry[] = [];
  private seq = 0;
  private nextId = 1;
  private queue: WorldEvent[] = [];
  private held: WorldEvent[] = [];
  private knobs: KnobRule[] = [];
  private pages = new Map<string, PageState>();
  /** Set while an event's `run` is executing, so tests can attribute log entries. */
  current: WorldEvent | null = null;
  /** When true, the fake fetch logs every read of a response body (`text`, `json`, `clone`, `arrayBuffer`). */
  spyBodies = false;

  registerPage(id: string): void {
    this.pages.set(id, { destroyed: false, frozen: false });
  }
  isDestroyed(id: string | null | undefined): boolean {
    return id != null && (this.pages.get(id)?.destroyed ?? false);
  }
  isFrozen(id: string | null | undefined): boolean {
    return id != null && (this.pages.get(id)?.frozen ?? false);
  }
  markDestroyed(id: string): void {
    const state = this.pages.get(id);
    if (state) state.destroyed = true;
    this.wake();
  }
  setFrozen(id: string, frozen: boolean): void {
    const state = this.pages.get(id);
    if (state) state.frozen = frozen;
    this.wake();
  }

  private wakers = new Set<() => void>();
  /**
   * Run `waker` synchronously whenever the queue may have gained deliverable work: an event scheduled or released, a page thawed or
   * destroyed (R30/DA-H1, revision 25). An automatic driver parks on it instead of polling a queue that holds only future, frozen or
   * cancelled work. Returns the unsubscribe.
   */
  onWake(waker: () => void): () => void {
    this.wakers.add(waker);
    return () => {
      this.wakers.delete(waker);
    };
  }
  private wake(): void {
    if (this.wakers.size === 0) return;
    for (const waker of [...this.wakers]) waker();
  }

  /** Add a delay rule. The first matching rule wins; later `setKnob` calls take priority over earlier ones. */
  setKnob(
    kind: DeliveryKind,
    value: Knob,
    match?: (meta: EventMeta) => boolean,
  ): void {
    this.knobs.unshift({ kind, match, value });
  }
  clearKnobs(): void {
    this.knobs = [];
  }

  private delayFor(kind: DeliveryKind, meta: EventMeta): Knob {
    for (const rule of this.knobs) {
      if (rule.kind === kind && (!rule.match || rule.match(meta)))
        return rule.value;
    }
    return 0;
  }

  private watchers: Array<(entry: LogEntry) => void> = [];
  /** Run `callback` synchronously for every log entry from now on (scenario code reacts to protocol events). */
  onLog(callback: (entry: LogEntry) => void): void {
    this.watchers.push(callback);
  }

  /**
   * A runaway loop becomes a diagnosable failure instead of a hang. Exceeding the limit HALTS the world (nothing more is
   * scheduled or delivered, so every chain of promises parks) and marks it `livelocked`; the property checkers report
   * that as a violation. It does not throw: the loop runs inside the kernel's un-awaited promise chains, where a throw
   * would surface as an unhandled rejection of the whole test run rather than as a finding about one scenario.
   */
  maxLogs = 60_000;
  livelocked = false;

  log(entry: Omit<LogEntry, "seq" | "t">): LogEntry {
    if (this.logs.length > this.maxLogs) this.livelocked = true;
    const full = { ...entry, seq: this.logs.length, t: this.time } as LogEntry;
    if (this.livelocked) return full;
    this.logs.push(full);
    for (const watcher of this.watchers) watcher(full);
    return full;
  }

  /**
   * Schedule a delivery. `page` is the destination; a destroyed page never receives it, a frozen page later. Returns the event's id,
   * which `cancel` takes (0 when the world is halted and nothing was scheduled).
   */
  schedule(
    kind: DeliveryKind,
    page: string | null,
    meta: EventMeta,
    run: () => void,
    explicitDelay?: Knob,
  ): number {
    if (this.livelocked) return 0;
    const fullMeta = { ...meta, page };
    const delay = explicitDelay ?? this.delayFor(kind, fullMeta);
    const event: WorldEvent = {
      id: this.nextId++,
      time: this.time + (delay === "unbounded" ? 0 : delay),
      seq: this.seq++,
      kind,
      page,
      meta: fullMeta,
      run,
    };
    if (delay === "unbounded") this.held.push(event);
    else {
      this.insert(event);
      this.wake();
    }
    return event.id;
  }

  /**
   * Withdraw a scheduled delivery that has not run (a cleared timer), queued or held: as `clearTimeout` does, it is gone, not
   * delivered later as a no-op. Returns whether it was still pending.
   */
  cancel(id: number): boolean {
    for (const list of [this.queue, this.held]) {
      const index = list.findIndex((event) => event.id === id);
      if (index >= 0) {
        list.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  private insert(event: WorldEvent): void {
    let index = this.queue.length;
    while (index > 0 && (this.queue[index - 1] as WorldEvent).time > event.time)
      index -= 1;
    this.queue.splice(index, 0, event);
  }

  /** Release held deliveries (all, or those of one kind and filter). Returns the number released. */
  release(kind?: DeliveryKind, filter?: (meta: EventMeta) => boolean): number {
    const keep: WorldEvent[] = [];
    let count = 0;
    for (const event of this.held) {
      if ((!kind || event.kind === kind) && (!filter || filter(event.meta))) {
        event.time = this.time;
        this.insert(event);
        count += 1;
      } else keep.push(event);
    }
    this.held = keep;
    if (count > 0) this.wake();
    return count;
  }
  heldCount(
    kind?: DeliveryKind,
    filter?: (meta: EventMeta) => boolean,
  ): number {
    return this.held.filter(
      (event) =>
        (!kind || event.kind === kind) && (!filter || filter(event.meta)),
    ).length;
  }
  /** Drop held deliveries (a completion that never arrives). */
  dropHeld(kind?: DeliveryKind, filter?: (meta: EventMeta) => boolean): number {
    const before = this.held.length;
    this.held = this.held.filter(
      (event) =>
        !((!kind || event.kind === kind) && (!filter || filter(event.meta))),
    );
    return before - this.held.length;
  }

  /** The index of the next deliverable event (pruning destroyed pages' events on the way), or -1. */
  private findNext(maxTime: number | null, includeTimers: boolean): number {
    for (let index = 0; index < this.queue.length; index += 1) {
      const event = this.queue[index] as WorldEvent;
      if (maxTime !== null && event.time > maxTime) return -1;
      if (event.kind === "timer" && !includeTimers && event.time > this.time)
        continue;
      if (this.isDestroyed(event.page)) {
        this.queue.splice(index, 1);
        index -= 1;
        continue;
      }
      if (this.isFrozen(event.page)) continue;
      return index;
    }
    return -1;
  }

  private takeNext(
    maxTime: number | null,
    includeTimers: boolean,
  ): WorldEvent | null {
    const index = this.findNext(maxTime, includeTimers);
    if (index < 0) return null;
    return this.queue.splice(index, 1)[0] as WorldEvent;
  }

  /**
   * Whether `runUntilIdle` would deliver anything now. Pending is not runnable: a timer still in the future, an event for a frozen
   * page and a held delivery are all pending and none is deliverable (R30/DA-H1, revision 25). False once the world is halted.
   */
  hasRunnable(): boolean {
    return !this.livelocked && this.findNext(null, false) >= 0;
  }

  /** Deliver one event, then let every resulting microtask run. Returns false when nothing was deliverable. */
  async step(
    options: { maxTime?: number; timers?: boolean } = {},
  ): Promise<boolean> {
    if (this.livelocked) return false;
    const event = this.takeNext(
      options.maxTime ?? null,
      options.timers ?? false,
    );
    if (!event) return false;
    if (event.time > this.time) this.time = event.time;
    this.current = event;
    try {
      event.run();
    } finally {
      this.current = null;
    }
    await flushTurn();
    return true;
  }

  /** Let microtasks settle without delivering anything. */
  async settle(): Promise<void> {
    await flushTurn();
  }

  /**
   * Deliver every deliverable event. Timers are delivered only when they are due at the current world time; a
   * timer that is still in the future needs `advance`. Held events stay held.
   */
  async runUntilIdle(limit = 20_000): Promise<number> {
    await flushTurn();
    let steps = 0;
    while (steps < limit && (await this.step())) steps += 1;
    if (steps >= limit) throw new Error("world did not reach idle");
    return steps;
  }

  /** Advance fake time by `ms`, delivering every event (timers included) that falls due on the way. */
  async advance(ms: number, limit = 200_000): Promise<number> {
    const target = this.time + ms;
    let steps = 0;
    await flushTurn();
    while (
      steps < limit &&
      (await this.step({ maxTime: target, timers: true }))
    )
      steps += 1;
    if (steps >= limit) throw new Error("world did not reach the target time");
    if (this.time < target) this.time = target;
    await flushTurn();
    return steps;
  }

  pendingCount(): number {
    return this.queue.length;
  }
}
