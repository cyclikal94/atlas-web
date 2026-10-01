/**
 * Combine two abort signals without relying on `AbortSignal.any`. The result aborts when either does; the listeners
 * are removed once it has aborted.
 */
export function combineSignals(
  first: AbortSignal,
  second: AbortSignal | undefined,
): AbortSignal {
  if (!second) return first;
  const controller = new AbortController();
  if (first.aborted) {
    controller.abort(first.reason);
    return controller.signal;
  }
  if (second.aborted) {
    controller.abort(second.reason);
    return controller.signal;
  }
  const onFirst = () => controller.abort(first.reason);
  const onSecond = () => controller.abort(second.reason);
  first.addEventListener("abort", onFirst, { once: true });
  second.addEventListener("abort", onSecond, { once: true });
  controller.signal.addEventListener(
    "abort",
    () => {
      first.removeEventListener("abort", onFirst);
      second.removeEventListener("abort", onSecond);
    },
    { once: true },
  );
  return controller.signal;
}
