// What a step does with a wake that arrives while it runs (R22, revision 10).
//
// Both engines run ONE step at a time (`busy`), and a wake that arrives while a step runs cannot start a second one. Dropping it is
// right only if the step observed what the wake announced. A step reads its facts (the service, the identity, connectivity, the
// durable queue) at its start and decides on them, then waits for a response or a commit; a wake that arrives after that read is
// news the step does not have, and a step that ends `when: "event"` sleeps until the next event: if the dropped wake was the last
// one, the engine never evaluates again (an enqueue that arrived during an empty read; an identity that moved during a response's
// decode). The revision-9 `rerun` flag was the opposite mistake: it re-ran the step whatever it had decided, which skipped a
// back-off and asked again at once. The rule here is narrower, and the CALLER applies it (see `settle` in each engine):
//
//   * a wake that arrives while a step runs is REMEMBERED, not acted on;
//   * when the step ends, the engine re-evaluates only where the step left nothing scheduled for itself (a back-off, an idle poll
//     and a paced retry are deadlines, and they stand), and the re-evaluation is an ordinary step: it starts from a clean latch,
//     so nothing but a NEW wake can ask for another one (no loop, one request in flight, one request per `online`).
//
// Two kinds of wake are told apart, because only one of them can be repeated by the step's own work:
//
//   * `signal`: an explicit act (work was saved, `online` arrived, "Retry now" was pressed, a receipt was recorded). It happened,
//     and it counts every time.
//   * `notify`: a NOTIFICATION that eligibility may have changed (the session's view, the identity store, visibility, the API
//     compatibility store). Notifications are republished freely (the session publishes a new identity object at every evaluation),
//     and the step's own request may be what causes one, so a notification counts only if what the step reads is DIFFERENT from what
//     it last saw: the `signature` of its eligibility. An unchanged signature is not news, and cannot feed itself.
//
// The latch holds a boolean and one string: it cannot grow, and it never reads or writes anything durable. It needs no reset for a stop
// or a start: every step begins by clearing it (`begin`), so an earlier run's wake is never a later run's.

export interface PendingWake {
  /** A step begins: nothing is pending, and `signature` is what it is about to read. */
  begin(signature: string): void;
  /** An explicit act arrived while a step runs. */
  signal(): void;
  /** A notification arrived while a step runs: it counts only if the signature is not the one last seen. */
  notify(signature: string): void;
  /** The step ended: whether a meaningful wake arrived during it. Forgets it. */
  take(): boolean;
}

export function createPendingWake(): PendingWake {
  let pending = false;
  let seen: string | null = null;
  return {
    begin(signature) {
      pending = false;
      seen = signature;
    },
    signal() {
      pending = true;
    },
    notify(signature) {
      if (signature === seen) return;
      seen = signature;
      pending = true;
    },
    take() {
      const was = pending;
      pending = false;
      return was;
    },
  };
}
