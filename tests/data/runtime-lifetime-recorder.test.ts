import { describe, expect, it } from "vitest";
import {
  createRuntimeLifetimeObserver,
  type ObservedRuntime,
  type ObservedService,
} from "../../src/fixture/data-harness/runtime-lifetime";

type Answer = Awaited<ReturnType<ObservedRuntime["open"]>>;
function deferred() {
  let resolve!: (answer: Answer) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Answer>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function world() {
  const closes = new Map<string, number>();
  class Service implements ObservedService {
    ended = false;
    get live() {
      return !this.ended;
    }
  }
  class Runtime implements ObservedRuntime {
    services = new Map<string, Service>();
    next: Promise<Answer> | null = null;
    calls = 0;
    disposals = 0;
    throwOnDispose = false;
    serviceFor(account: string) {
      const service = this.services.get(account);
      return service?.live ? service : null;
    }
    install(account: string) {
      const service = new Service();
      this.services.set(account, service);
      return service;
    }
    open(account: string): Promise<Answer> {
      this.calls += 1;
      return (
        this.next ??
        Promise.resolve({
          kind: "opened",
          service: this.serviceFor(account) ?? this.install(account),
        })
      );
    }
    dispose() {
      this.disposals += 1;
      for (const [account, service] of this.services) {
        if (service.live) {
          service.ended = true;
          closes.set(account, (closes.get(account) ?? 0) + 1);
        }
      }
      if (this.throwOnDispose) throw new Error("original disposal failed");
    }
  }
  const observer = createRuntimeLifetimeObserver(
    Runtime.prototype,
    (account) => closes.get(account) ?? 0,
    () => 7,
  );
  return { Runtime, observer, closes };
}

describe("R43 runtime lifetime recorder", () => {
  it("requires installation for the exact account; repeated watch does not wrap twice", async () => {
    const { Runtime, observer } = world();
    expect(() => observer.read("a")).toThrow(/not installed/);
    observer.watch("a");
    const method = Runtime.prototype.open;
    observer.watch("a");
    expect(Runtime.prototype.open).toBe(method);
    expect(() => observer.read("b")).toThrow(/not installed/);
    const runtime = new Runtime();
    await runtime.open("a");
    runtime.dispose();
    expect(runtime.calls).toBe(1);
    expect(runtime.disposals).toBe(1);
    expect(observer.read("a").opens).toHaveLength(1);
    expect(observer.read("a").disposals).toHaveLength(1);
  });

  it("detects a replaced recorder instead of returning apparently empty passing evidence", () => {
    const { Runtime, observer } = world();
    observer.watch("a");
    Runtime.prototype.dispose = () => undefined;
    expect(() => observer.read("a")).toThrow(/was replaced/);
  });

  it("uses distinct operation/runtime/service identities even when every timestamp is equal", async () => {
    const { Runtime, observer } = world();
    observer.watch("a");
    const first = new Runtime();
    const second = new Runtime();
    await first.open("a");
    await first.open("a");
    await second.open("a");
    const records = observer.read("a").opens;
    expect(records.map((entry) => entry.requested)).toEqual([7, 7, 7]);
    expect(new Set(records.map((entry) => entry.operation)).size).toBe(3);
    expect(records[0]?.runtime).toBe(records[1]?.runtime);
    expect(records[0]?.service).toBe(records[1]?.service);
    expect(records[2]?.runtime).not.toBe(records[0]?.runtime);
    expect(records[2]?.service).not.toBe(records[0]?.service);
    const identities = new Set([
      ...records.map((entry) => entry.operation),
      ...records.map((entry) => entry.runtime),
      ...records.map((entry) => entry.service),
    ]);
    expect(identities.size).toBe(7);
    expect(records[0]?.answeredOrder).toBeLessThan(
      records[1]?.requestedOrder ?? 0,
    );
  });

  it("keeps unrelated-account and harness opens separate from the disposed runtime", async () => {
    const { Runtime, observer } = world();
    observer.watch("a");
    const harness = new Runtime();
    const tree = new Runtime();
    await harness.open("b");
    await harness.open("a");
    await tree.open("a");
    tree.dispose();
    const facts = observer.read("a");
    expect(facts.opens).toHaveLength(2);
    expect(facts.disposals[0]?.runtime).toBe(facts.opens[1]?.runtime);
    expect(facts.disposals[0]?.service).toBe(facts.opens[1]?.service);
    expect(harness.serviceFor("a")?.live).toBe(true);
  });

  it("returns the original pending promise and does not infer installation from its late answer", async () => {
    const { Runtime, observer } = world();
    observer.watch("a");
    const runtime = new Runtime();
    const waiting = deferred();
    runtime.next = waiting.promise;
    const promise = runtime.open("a");
    expect(promise).toBe(waiting.promise);
    const service = runtime.install("a");
    runtime.dispose();
    const atDisposal = observer.read("a");
    expect(atDisposal.opens[0]?.answered).toBeNull();
    expect(atDisposal.disposals[0]?.live).toBe(true);
    expect(atDisposal.disposals[0]?.pending).toEqual([
      atDisposal.opens[0]?.operation,
    ]);
    waiting.resolve({ kind: "opened", service });
    await promise;
    const facts = observer.read("a");
    expect(facts.opens[0]).toMatchObject({
      outcome: "opened",
      liveAtAnswer: false,
      installedAtAnswer: false,
    });
    expect(facts.opens[0]?.answeredOrder).toBeGreaterThan(
      facts.disposals[0]?.order ?? 0,
    );
    expect(facts.disposals[0]).toMatchObject({
      live: true,
      closesBefore: 0,
      closesAfter: 1,
      service: facts.opens[0]?.service,
    });
  });

  it("records pending disposal with no service separately from a healthy replacement lifetime", async () => {
    const { Runtime, observer } = world();
    observer.watch("a");
    const old = new Runtime();
    const waiting = deferred();
    old.next = waiting.promise;
    const pending = old.open("a");
    old.dispose();
    const replacement = new Runtime();
    await replacement.open("a");
    waiting.resolve({ kind: "refused", reason: "abandoned" });
    await pending;
    replacement.dispose();
    const facts = observer.read("a");
    expect(facts.disposals.map((entry) => entry.live)).toEqual([false, true]);
    expect(facts.disposals.map((entry) => entry.closesAfter)).toEqual([0, 1]);
    expect(facts.opens[0]?.outcome).toBe("refused:abandoned");
    expect(facts.disposals[0]?.runtime).not.toBe(facts.disposals[1]?.runtime);
  });

  it("attributes closures per account and records idempotent repeated disposal without extra closure", async () => {
    const { Runtime, observer } = world();
    observer.watch("a");
    observer.watch("b");
    const runtime = new Runtime();
    await runtime.open("a");
    await runtime.open("b");
    runtime.dispose();
    runtime.dispose();
    for (const account of ["a", "b"]) {
      const facts = observer.read(account);
      expect(facts.disposals.map((entry) => entry.live)).toEqual([true, false]);
      expect(
        facts.disposals.map(
          (entry) => (entry.closesAfter ?? -1) - entry.closesBefore,
        ),
      ).toEqual([1, 0]);
    }
  });

  it("preserves the original rejection and records the failed answer without manufacturing a service", async () => {
    const { Runtime, observer } = world();
    observer.watch("a");
    const runtime = new Runtime();
    const waiting = deferred();
    runtime.next = waiting.promise;
    const answer = runtime.open("a");
    const expected = new Error("original open failed");
    waiting.reject(expected);
    await expect(answer).rejects.toBe(expected);
    expect(observer.read("a").opens[0]).toMatchObject({
      outcome: "threw",
      service: null,
    });
  });

  it("does not swallow original disposal errors and still completes the closure observation", () => {
    const { Runtime, observer } = world();
    observer.watch("a");
    const runtime = new Runtime();
    runtime.install("a");
    runtime.throwOnDispose = true;
    expect(() => runtime.dispose()).toThrow("original disposal failed");
    expect(observer.read("a").disposals[0]).toMatchObject({
      live: true,
      closesAfter: 1,
    });
  });

  it("returns detached evidence snapshots and retains the disposal caller", async () => {
    const { Runtime, observer } = world();
    observer.watch("a");
    const runtime = new Runtime();
    await runtime.open("a");
    runtime.dispose();
    const copied = observer.read("a");
    expect(copied.disposals[0]?.stack).toContain("runtime-lifetime-recorder");
    copied.opens.length = 0;
    copied.disposals[0]?.pending.push(999);
    expect(observer.read("a").opens).toHaveLength(1);
    expect(observer.read("a").disposals[0]?.pending).toEqual([]);
  });
});
