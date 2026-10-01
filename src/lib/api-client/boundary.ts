import { abortable } from "./abortable";
import type { IssueStep, IssueTransport } from "./transport";
import { decorate } from "./wire";

/**
 * THE SEND BOUNDARY (matrix 3.6.2 step 1; lint rule R7). This file and unstamped.ts are the only places that may
 * call `fetch`. `issue` is ONE synchronous function: the guard, the call to `fetch` and the release of the request's
 * issue lock happen in a single step, with nothing awaited or read between them. It contains no `await`, no
 * `.then`, and no call that touches a lock or the store.
 */
export type FetchLike = (request: Request) => Promise<Response>;

function issue(fetch: FetchLike, step: IssueStep): Promise<Response> | null {
  if (step.refuses()) {
    step.releaseIssueLock();
    return null;
  }
  step.markIssued();
  try {
    return fetch(
      decorate(step.request, {
        csrf: step.csrf,
        identityRead: step.identityRead,
        signal: step.signal,
      }),
    );
  } finally {
    step.releaseIssueLock();
  }
}

/**
 * Production passes no argument and uses the platform's `fetch`, made to settle at its signal's abort whatever the engine
 * does (abortable.ts); tests pass a fake.
 */
export function createIssueTransport(
  fetch: FetchLike = abortable(globalThis.fetch.bind(globalThis)),
): IssueTransport {
  return { issue: (step) => issue(fetch, step) };
}
