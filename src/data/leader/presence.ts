/**
 * Whether a production leader was started on this page (P-3): set by the boot shim before its chunk loads, read by the provider, which
 * then WAITS for the page runtime the leader composes rather than building one of its own (a runtime the tree owned would close the
 * page's connections, the leader's included, at every fence). Tiny and dependency-free: it is in the initial chunk.
 */
let started = false;
export const markLeaderStarted = (): void => {
  started = true;
};
export const leaderStarted = (): boolean => started;
/** Tests only. */
export const resetLeaderStarted = (): void => {
  started = false;
};
