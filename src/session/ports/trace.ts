/**
 * Test instrumentation behind a port. Production supplies a no-op. The fake world records each event so the
 * property checkers (V1 to V5, W1 to W3, P-A to P-F) can be evaluated on the logs after every scenario.
 */
export interface Trace {
  emit(event: string, data?: Record<string, unknown>): void;
}
export const noopTrace: Trace = { emit() {} };
