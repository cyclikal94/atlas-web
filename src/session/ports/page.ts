export type PageEvent =
  | "visible"
  | "hidden"
  | "pageshow"
  | "pagehide"
  | "focus"
  | "resume"
  | "online"
  | "offline";

export interface PageEnv {
  /** A random UUID from the moment the script starts. */
  readonly bootId: string;
  isVisible(): boolean;
  isOnline(): boolean;
  on(event: PageEvent, listener: () => void): () => void;
  /**
   * The render scheduler: `act` runs in a task queued here (production: a macrotask; tests: the fake world's D3).
   * The task is queued, never run inline, so the tree mount and the lock release stay one synchronous step.
   */
  queueTask(task: () => void): void;
}
