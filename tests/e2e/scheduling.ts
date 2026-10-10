/** Only these independent UI files may use the bounded fast lane. Browser contexts
 * are isolated; timing, multi-tab, backend and profiling files stay serial. Every
 * other file remains in the complement, so new tests cannot silently disappear. */
export const PARALLEL_UI =
  /(?:^|[/\\])fixture\.(?:appearance|chip|controls|scroll|shell)\.spec\.ts$/;
