// One stack's resources, from the first acquisition to verified disposal (WEB-08d review r6, H4a).
//
// A resource's disposal is registered BEFORE the resource is created (`defer`), and every step that can create resources runs as a
// tracked producer (`run`). `close()` closes admission (no producer starts, `check()` throws), aborts the producers' signal, waits
// for every producer to settle, and only then disposes what was registered, last first. So a producer that was part-way through a
// creation when a signal arrived finishes (or gives up) first, and whatever it created was already registered and is disposed: a
// completed disposal can never be followed by a resource nobody owns. `close()` is memoised around that whole protocol, so the
// signal path and the stack's own end share one disposal. A registration after disposal has run (a producer that outlived the
// bounded wait) is disposed at once and recorded as late: the result is then not ok.
import { Cancelled } from "./ownership.mjs";

export function createScope(name, { settleMs = 90_000 } = {}) {
  const controller = new AbortController();
  const disposers = [];
  const producers = new Map(); // tracked promise -> label
  const late = [];
  let reason = null;
  let closing = null;
  let disposed = false;

  async function dispose(entry) {
    const startedAt = Date.now();
    try {
      const result = (await entry.fn()) ?? { ok: true };
      return {
        label: entry.label,
        ok: result.ok !== false,
        ms: Date.now() - startedAt,
        result,
      };
    } catch (error) {
      return {
        label: entry.label,
        ok: false,
        ms: Date.now() - startedAt,
        error: String(error?.message ?? error),
      };
    }
  }

  const scope = {
    name,
    get signal() {
      return controller.signal;
    },
    get reason() {
      return reason;
    },
    get stopped() {
      return reason !== null;
    },
    /** Close admission (first reason wins) and abort every producer's signal. Disposal is `close()`. */
    stop(why) {
      reason ??= why;
      if (!controller.signal.aborted) controller.abort(new Cancelled(reason));
      return reason;
    },
    check() {
      if (reason !== null) throw new Cancelled(reason);
    },
    /**
     * Register how to dispose of a resource, before creating it. Always registered, even once stopping (the creation it precedes may
     * already be under way); after disposal has run it is disposed at once and recorded as late.
     */
    defer(label, fn) {
      const entry = { label, fn };
      if (disposed) {
        const done = dispose(entry).then((step) => {
          late.push(step);
          return step;
        });
        late.pending = (late.pending ?? Promise.resolve()).then(() => done);
        return entry;
      }
      disposers.push(entry);
      return entry;
    },
    /** A step that may create resources: refused once stopping, and waited for by `close()` before anything is disposed. */
    async run(label, fn) {
      scope.check();
      const task = Promise.resolve().then(() => fn(controller.signal));
      const tracked = task.then(
        () => undefined,
        () => undefined,
      );
      producers.set(tracked, label);
      try {
        return await task;
      } finally {
        producers.delete(tracked);
      }
    },
    /** Stop, wait (bounded) for every producer, dispose everything registered (last first) and return what happened. */
    close(why = "the stack ended") {
      closing ??= (async () => {
        scope.stop(why);
        const startedAt = Date.now();
        const waiting = [...producers.keys()];
        let timer;
        const settled = await Promise.race([
          Promise.all(waiting).then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), settleMs);
          }),
        ]);
        clearTimeout(timer);
        const unsettled = settled ? [] : [...producers.values()];
        const steps = [];
        while (disposers.length > 0) steps.push(await dispose(disposers.pop()));
        disposed = true;
        return {
          scope: name,
          reason,
          producers_settled: settled,
          unsettled_producers: unsettled,
          waited_ms: Date.now() - startedAt,
          steps,
          late,
          get ok() {
            return (
              settled && late.length === 0 && steps.every((step) => step.ok)
            );
          },
        };
      })();
      return closing;
    },
    get closing() {
      return closing !== null;
    },
  };
  return scope;
}
