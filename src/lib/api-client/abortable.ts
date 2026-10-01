/**
 * An abort the page can rely on. The protocol treats an aborted request as "outcome unknown" and moves on (an activation is
 * then resolved by `activate/cancel`; a stamped request fails clean), so the page must move on the moment it aborts, not when
 * the engine gets round to rejecting the pending `fetch`. Playwright's WebKit was seen to leave a `fetch` pending after
 * `AbortController.abort()` (an activation aborted because the page became hidden, response not yet received), which kept
 * `atlas-auth` and `atlas-attempt-<epoch>` held and the attempt in `activating`. This module makes the settlement ours.
 *
 * A request that the engine did send is still in flight after this rejects, exactly as with a native abort that arrives too
 * late: the server may have acted, which the attempt and lease records already account for. A response that arrives
 * afterwards is discarded and its body cancelled.
 */
type Send = (request: Request) => Promise<Response>;

const reasonOf = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

/** Settles with `promise`, or rejects with the signal's reason as soon as the signal aborts, whichever comes first. */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  discard?: (late: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let over = false;
    const giveUp = () => {
      over = true;
      reject(reasonOf(signal));
    };
    if (signal.aborted) giveUp();
    else signal.addEventListener("abort", giveUp, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", giveUp);
        if (over) discard?.(value);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", giveUp);
        if (!over) reject(error);
      },
    );
  });
}

/** Wraps a platform send so its promise settles at the request signal's abort. The underlying call is made synchronously. */
export const abortable =
  (send: Send): Send =>
  (request) =>
    raceAbort(send(request), request.signal, (late) => {
      late.body?.cancel().catch(() => undefined);
    });
