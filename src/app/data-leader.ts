import {
  type DataLeaderHandle,
  markLeaderStarted,
  startDataLeader,
} from "../data";
import type { Session, Trace } from "../session";

/**
 * WEB-09b (P-3, P-13): the boot composition's two calls into production leadership. `announce` runs BEFORE the session starts (the
 * protected tree may be mounted during `start`, and its provider must then wait for the page's runtime instead of building its own);
 * `start` runs after it. Both are static and tiny: the leader itself is a dynamic import inside `startDataLeader`.
 */
export const dataLeader = {
  announce: (): void => markLeaderStarted(),
  start: (session: Session, trace?: Trace): DataLeaderHandle =>
    startDataLeader(session, trace ? { trace } : {}),
};
export type { DataLeaderHandle };
