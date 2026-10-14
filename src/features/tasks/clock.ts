import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The clock of a task screen (R8, revision 2; design assessment C3): ONE sampled `now` that moves when a window boundary of the rows the
 * screen shows (or could show) is reached, so a result that depends on time (a window that closed, a day that opened) is evaluated again
 * without any data change or user action. Today and the task detail both use it; neither samples the time anywhere else for these results.
 *
 * - The wait is to the next boundary (plus 50 ms), capped at six hours; a capped wake that finds no boundary reached arms the next wait itself.
 * - A page that was hidden, a device that slept or a clock that was changed is re-read when the page is shown, focused or restored
 *   (`visibilitychange`, `focus`, `pageshow`): a timer does not run while a device sleeps.
 * - When the windows change (new data), a boundary that already passed is handled at once (a late answer can arrive after it).
 * - `epoch` moves only when a boundary was crossed or the clock went BACKWARDS: what a screen derived from the server for an earlier instant
 *   must then be asked again. Production durations are never shortened; tests drive the injected `read` or real short windows.
 * - `generation` moves only when the clock went BACKWARDS (a discontinuity: R2, revision 3; design assessment C1). It is readable at once
 *   (`generationNow`), so an answer can carry the generation it was DISPATCHED in and be refused, at publication and at every composition,
 *   once the clock has moved back since: comparing instants alone cannot see a clock that went back and returned to the same time.
 */
export interface BoundaryWindow {
  opens_at: number | null;
  closes_at: number | null;
}

export interface BoundaryClock {
  /** The sampled time (ms) the screen evaluates against. */
  now: number;
  /** Moves when a boundary was crossed or the clock moved back. */
  epoch: number;
  /** Moves when the clock moved back (the generation of `now`). */
  generation: number;
  /** The generation as of the last sample, read synchronously (an answer captures it at dispatch and compares it at publication). */
  generationNow(): number;
  /** Samples the clock now (for example when an answer is published) and returns the new time. */
  revalidate(): number;
}

const CAP = 6 * 3_600_000;

/** The distinct boundaries (seconds) of the windows, ascending. */
export function boundariesOf(windows: Iterable<BoundaryWindow>): number[] {
  const out = new Set<number>();
  for (const w of windows) {
    if (w.opens_at !== null) out.add(w.opens_at);
    if (w.closes_at !== null) out.add(w.closes_at);
  }
  return [...out].sort((a, b) => a - b);
}

/** Whether a boundary lies in `(fromMs, toMs]`. */
export function crossedBetween(
  boundaries: readonly number[],
  fromMs: number,
  toMs: number,
): boolean {
  return boundaries.some((b) => fromMs < b * 1000 && b * 1000 <= toMs);
}

export function useBoundaryClock(
  read: () => number,
  windows: Iterable<BoundaryWindow>,
): BoundaryClock {
  const boundaries = boundariesOf(windows);
  const key = boundaries.join(",");
  // The sampled state lives in a ref, so a sample and the generation it moved are known at once; the state only renders it.
  const sampled = useRef<{
    now: number;
    epoch: number;
    generation: number;
  } | null>(null);
  if (sampled.current === null)
    sampled.current = { now: read(), epoch: 0, generation: 0 };
  const [state, setState] = useState(sampled.current);
  const latest = useRef({ read, boundaries });
  latest.current = { read, boundaries };
  const revalidate = useCallback((): number => {
    const t = latest.current.read();
    const prev = sampled.current as NonNullable<typeof sampled.current>;
    if (t === prev.now) return t;
    const back = t < prev.now;
    const moved =
      back || crossedBetween(latest.current.boundaries, prev.now, t);
    const next = {
      now: t,
      epoch: moved ? prev.epoch + 1 : prev.epoch,
      generation: back ? prev.generation + 1 : prev.generation,
    };
    sampled.current = next;
    setState(next);
    return t;
  }, []);
  const generationNow = useCallback(
    (): number =>
      (sampled.current as NonNullable<typeof sampled.current>).generation,
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-armed when the set of boundaries changes (`key`)
  useEffect(() => {
    // New data may carry a boundary that has already passed: evaluate at once.
    revalidate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      const t = latest.current.read();
      const next = latest.current.boundaries.find((b) => b * 1000 > t);
      if (next === undefined) return;
      timer = setTimeout(
        () => {
          revalidate();
          arm();
        },
        Math.min(next * 1000 - t + 50, CAP),
      );
    };
    arm();
    const resume = () => {
      if (document.visibilityState !== "visible") return;
      revalidate();
      arm();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [key, revalidate]);
  return {
    now: state.now,
    epoch: state.epoch,
    generation: state.generation,
    generationNow,
    revalidate,
  };
}
