import type { TestInfo } from "@playwright/test";
import { writeEvidence } from "./evidence-run.ts";

/**
 * Real-engine evidence for WEB-09a (plan 9.4): an exclusive JSON file per test and engine in a fresh invocation directory.
 * The default parent is git-ignored. A file records what was OBSERVED in this engine on
 * this machine; it is never described as integration evidence, and it says nothing about real Safari or a device.
 */
export function recordEvidence(
  info: TestInfo,
  name: string,
  data: unknown,
): void {
  writeEvidence(info, name, {
    project: info.project.name,
    name,
    testId: info.testId,
    repeat: info.repeatEachIndex,
    retry: info.retry,
    at: new Date().toISOString(),
    data,
  });
}
