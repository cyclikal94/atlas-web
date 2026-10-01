import { createHash } from "node:crypto";
import type { Clock, Ids } from "../../../src/session/ports/clock";
import type { PageEnv, PageEvent } from "../../../src/session/ports/page";
import type { ProtectedSurface } from "../../../src/session/ports/surface";
import type { Trace } from "../../../src/session/ports/trace";
import type { World } from "./world";

export const EPOCH_BASE = Date.UTC(2026, 8, 30, 12, 0, 0);

/** Fake time: every timer is a world event; nothing reads the real clock. */
export class FakeClock implements Clock {
  private counter = 0;
  private cancelled = new Set<number>();
  constructor(
    private readonly world: World,
    private readonly page: string,
  ) {}
  now(): number {
    return EPOCH_BASE + this.world.time;
  }
  iso(): string {
    return new Date(this.now()).toISOString();
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.counter;
    this.world.schedule(
      "timer",
      this.page,
      { timer: id },
      () => {
        if (!this.cancelled.has(id)) fn();
      },
      ms,
    );
    return id;
  }
  clearTimeout(id: number): void {
    this.cancelled.add(id);
  }
  abortAfter(ms: number): AbortSignal {
    const controller = new AbortController();
    this.setTimeout(
      () => controller.abort(new DOMException("timed out", "TimeoutError")),
      ms,
    );
    return controller.signal;
  }
}

/** A seeded PRNG (mulberry32): deterministic ids, the only randomness in the fake world. */
export class Prng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = Math.floor(this.next() * 256);
    return out;
  }
}

export const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const sha256Base64url = (text: string): string =>
  base64url(createHash("sha256").update(text, "ascii").digest());

export class FakeIds implements Ids {
  constructor(private readonly prng: Prng) {}
  uuid(): string {
    const b = this.prng.bytes(16);
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  verifier(): string {
    return base64url(this.prng.bytes(32));
  }
  async challenge(verifier: string): Promise<string> {
    return sha256Base64url(verifier);
  }
}

/** One page: visibility and connectivity flags, listeners, and the render scheduler (delay knob D3). */
export class FakePageEnv implements PageEnv {
  visible = true;
  online = true;
  private listeners = new Map<PageEvent, Set<() => void>>();
  constructor(
    private readonly world: World,
    readonly id: string,
    readonly bootId: string,
  ) {}
  isVisible(): boolean {
    return this.visible;
  }
  isOnline(): boolean {
    return this.online;
  }
  on(event: PageEvent, listener: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
  emit(event: PageEvent): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
  private taskSeq = 0;
  queueTask(task: () => void): void {
    this.world.schedule("D3", this.id, { task: ++this.taskSeq }, task);
  }
  clearListeners(): void {
    this.listeners.clear();
  }
}

/** Records every gate primitive so the property checkers can see them. */
export class FakeSurface implements ProtectedSurface {
  level0 = true;
  mounted: { account: string; epoch: number } | null = null;
  saved: { account: string; epoch: number } | null = null;
  /** Depth of `act` for this page, from the kernel's trace events (property P-C). */
  actDepth = 0;
  attachCount = 0;
  constructor(
    private readonly world: World,
    private readonly page: string,
  ) {}
  applyLevel0(): void {
    this.level0 = true;
    this.world.log({ type: "surface.level0", page: this.page });
  }
  unmountTree(): void {
    this.mounted = null;
    this.level0 = true;
    this.world.log({ type: "surface.unmount", page: this.page });
  }
  attachTree(account: string, epoch: number): "mounted" | "lifted" {
    const result: "mounted" | "lifted" =
      this.mounted !== null && this.mounted.account === account
        ? "lifted"
        : "mounted";
    this.mounted = { account, epoch };
    this.level0 = false;
    this.attachCount += 1;
    this.world.log({
      type: "surface.attach",
      page: this.page,
      account,
      epoch,
      result,
      inAct: this.actDepth > 0,
    });
    return result;
  }
  saveFocusAndScroll(account: string, epoch: number): void {
    this.saved = { account, epoch };
    this.world.log({ type: "surface.save", page: this.page, account, epoch });
  }
  discardSavedPosition(): void {
    this.saved = null;
    this.world.log({ type: "surface.discard", page: this.page });
  }
}

export class FakeTrace implements Trace {
  constructor(
    private readonly world: World,
    private readonly page: string,
    private readonly surface: FakeSurface,
  ) {}
  emit(event: string, data?: Record<string, unknown>): void {
    if (event === "act.begin") this.surface.actDepth += 1;
    this.world.log({ type: `trace.${event}`, page: this.page, ...data });
    if (event === "act.end") this.surface.actDepth -= 1;
  }
}
