/**
 * FIXTURE ONLY (never packaged; `check-no-fixture`). The cold observation of one profiled `/sync` page (`engine-state-log/3`), shared by
 * the desktop cold runs (tests/e2e/profile-cold-outcome.ts hands `observeColdOutcome` to Playwright, which serialises it into the page)
 * and the device profiling page (profile-page.ts calls it with its harness). Both functions must therefore refer to nothing outside their
 * own bodies; the shared rules that judge what they return are scripts/lib/profile-outcome-rules.mjs.
 *
 * The witness names the page instance and the one engine start it observed, and retains every state published since the mark and every
 * commit/step-end trace event from the mark to the observation's end. The measured attempt is the step that published the first
 * `running` after the mark (the request served the measured body); it ends at the first `data.sync_next` or `data.sync_step_failed` after
 * that publication, and its commit is the first `data.sync_commit` before that end. Revision 12 (review 12's R2 follow-up, design
 * assessment DA-C1/DA-D1): only a measured page that was WRITTEN (applied and committed) continues past a `running` end (`has_more`); an
 * attempt that wrote nothing and asked again (a lapsed hold, a dropped or unestablished admission) completes the observation there, so a
 * later response's idle never stands for it. A failed step's stop is waited for; a reload, another engine start or another engine's
 * publication while observing throws (an error, never a verdict).
 */

/** The harness fields the observation reads (`src/fixture/data-harness/main.ts`). */
export interface ObservedHarnessLog {
  page: string;
  engineStates: Array<{
    run: number;
    generation: number;
    at: number;
    trace: number;
    state: { kind: string; [key: string]: unknown };
  }>;
  engineEpochs: Array<{ generation: number; run?: number; trace: number }>;
  engineTrace: string[];
}

/** Where an observation begins: the page instance, and the lengths of its state log and trace and its engine starts so far. */
export interface ObservationMark {
  page: string;
  states: number;
  trace: number;
  generation: number;
}

export interface ColdWitness {
  method: "engine-state-log/3";
  page: string;
  mark: ObservationMark;
  generation: number;
  epochs: Array<{ generation: number; run?: number; trace: number }>;
  published: Array<{
    index: number;
    generation: number;
    at: number;
    trace: number;
    state: { kind: string; [key: string]: unknown };
  }>;
  events: Array<{
    trace: number;
    event: string;
    payload: Record<string, unknown> | null;
  }>;
  request: { index: number; at: number; trace: number };
  terminal: {
    index: number;
    at: number;
    trace: number;
    state: { kind: string; [key: string]: unknown };
  };
  step_end: { trace: number; event: string; recorded: string | null };
  commits: Array<Record<string, unknown>>;
}

/** Where this observation begins (taken before the engine is started). `given` is the harness; in a serialised call, the page's. */
export function observationMark(given?: unknown): ObservationMark | null {
  // (`unknown`: Playwright hands a page function no argument when it is evaluated without one.)
  const data =
    (given as ObservedHarnessLog | undefined) ??
    (window as unknown as { __atlasData?: ObservedHarnessLog }).__atlasData;
  if (!data) return null;
  return {
    page: data.page,
    states: data.engineStates.length,
    trace: data.engineTrace.length,
    generation: data.engineEpochs.at(-1)?.generation ?? 0,
  };
}

/** The witness once the measured attempt (and any continuation of a written page) has ended, or null (the caller polls again). */
export function observeColdOutcome(
  mark: ObservationMark,
  given?: ObservedHarnessLog,
): ColdWitness | null {
  const data =
    given ??
    (window as unknown as { __atlasData?: ObservedHarnessLog }).__atlasData;
  if (!data) return null;
  if (data.page !== mark.page)
    throw new Error(
      "observation identity: the page was replaced (a reload) while observing",
    );
  const epochs = data.engineEpochs
    .filter((e) => e.generation > mark.generation)
    .map((e) => ({ generation: e.generation, run: e.run, trace: e.trace }));
  if (epochs.length > 1)
    throw new Error(
      "observation identity: the engine was started again while observing",
    );
  const epoch = epochs[0];
  if (!epoch) return null;
  const all = data.engineStates.slice(mark.states).map((e, index) => ({
    index,
    generation: e.generation,
    at: e.at,
    trace: e.trace,
    state: e.state,
  }));
  if (all.some((e) => e.generation !== epoch.generation))
    throw new Error(
      "observation identity: another engine published while observing",
    );
  const trace = data.engineTrace;
  const begin = all.findIndex((e) => e.state.kind === "running");
  if (begin < 0) return null;
  const request = all[begin];
  if (!request) return null;
  const payload = (line: string): Record<string, unknown> | null => {
    const at = line.indexOf("{");
    if (at < 0) return null;
    try {
      const value = JSON.parse(line.slice(at)) as unknown;
      return typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const eventOf = (line: string): string | null => {
    const parts = line.split(" ");
    const name = parts[1] ?? "";
    return name === "data.sync_commit" ||
      name === "data.sync_next" ||
      name === "data.sync_step_failed"
      ? name
      : null;
  };
  // The measured attempt's commit (the first commit after the request, before the attempt's end) and whether it wrote its page.
  let attemptEnded = false;
  let measured: Record<string, unknown> | null = null;
  for (let t = request.trace; t < trace.length; t += 1) {
    const line = trace[t] ?? "";
    const event = eventOf(line);
    if (event === "data.sync_commit") {
      // Only the first commit of the measured attempt is the measured page's.
      if (!attemptEnded && measured === null) measured = payload(line) ?? {};
      continue;
    }
    if (event !== "data.sync_next" && event !== "data.sync_step_failed")
      continue;
    const failed = event === "data.sync_step_failed";
    const recorded = failed ? null : payload(line)?.state;
    const first = !attemptEnded;
    attemptEnded = true;
    const written =
      measured?.kind === "applied" && measured?.value === "committed";
    // A written page with has_more: the engine asks for the next page at once; the operation continues. A measured attempt that wrote
    // nothing and asked again is complete here (the rules name it); a later attempt's `running` end is followed as before.
    if (recorded === "running" && (!first || written)) continue;
    let end = -1;
    for (let i = begin + 1; i < all.length; i += 1) {
      const entry = all[i];
      if (!entry) continue;
      // After a failed step the engine publishes its stop after the trace line; otherwise the step's state was published before it.
      if (failed ? entry.trace > t : entry.trace <= t) {
        end = i;
        if (failed) break;
      }
    }
    // A failed step's stop is not published yet: polled again. A normal end with nothing published since the request is returned with
    // the request itself as its terminal, and the rules refuse it as the contradiction it is.
    if (end < 0) {
      if (failed) return null;
      end = begin;
    }
    const terminal = all[end];
    if (!terminal) return null;
    const events: Array<{
      trace: number;
      event: string;
      payload: Record<string, unknown> | null;
    }> = [];
    for (let c = mark.trace; c <= t; c += 1) {
      const kept = trace[c] ?? "";
      const name = eventOf(kept);
      if (name) events.push({ trace: c, event: name, payload: payload(kept) });
    }
    return {
      method: "engine-state-log/3",
      page: data.page,
      mark,
      generation: epoch.generation,
      epochs,
      published: all.slice(0, end + 1),
      events,
      request: { index: begin, at: request.at, trace: request.trace },
      terminal: {
        index: end,
        at: terminal.at,
        trace: terminal.trace,
        state: terminal.state,
      },
      step_end: {
        trace: t,
        event,
        recorded: typeof recorded === "string" ? recorded : null,
      },
      commits: events
        .filter(
          (e) =>
            e.event === "data.sync_commit" &&
            e.trace >= request.trace &&
            e.trace < t,
        )
        .map((e) => e.payload ?? {}),
    };
  }
  return null;
}
