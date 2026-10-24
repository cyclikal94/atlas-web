// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  type EnqueueRequest,
  OutboxRequestError,
  type TargetSpec,
  validateRequest,
} from "../../src/data/model/outbox";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * `TargetSpec.reviewedBase` (WEB-10a R5, revision 1): the version a person reviewed in WF-QUEUE-02's authorised current read is the base of
 * that target, ahead of the local record and the cache, and the record is raised from it. Through the PRODUCTION enqueue plan.
 */
const edit = (over: Partial<TargetSpec> = {}): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [
    {
      resourceId: "r",
      role: "primary",
      basis: "resource",
      versionChecked: true,
      ...over,
    },
  ],
  build: (bases) => ({ command: { kind: "edit", base: bases.r as number } }),
});

describe("reviewedBase", () => {
  test("it is the base of its target, ahead of the record and the cache; the record is raised from it", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 3 })]);
    w.put("resource_versions", [
      { resource_id: "r", locally_assumed_version: 4, basis: "resource" },
    ]);
    const first = await w.outbox.enqueue(edit({ reviewedBase: 9 }));
    expect(first.kind).toBe("queued");
    const second = await w.outbox.enqueue(edit());
    expect(second.kind).toBe("queued");
    const drafts = w.drafts().sort((a, b) => a.created_seq - b.created_seq);
    expect(drafts.map((d) => d.expected_version)).toEqual([9, 10]);
    expect(
      w.versions().find((v) => v.resource_id === "r")?.locally_assumed_version,
    ).toBe(11);
  });

  test("control: without it the record (then the cache) is the base", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 3 })]);
    w.put("resource_versions", [
      { resource_id: "r", locally_assumed_version: 4, basis: "resource" },
    ]);
    await w.outbox.enqueue(edit());
    expect(w.drafts()[0]?.expected_version).toBe(4);
  });

  test("it must be a whole version of at least 1", () => {
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(() => validateRequest(edit({ reviewedBase: bad }))).toThrow(
        OutboxRequestError,
      );
    expect(() => validateRequest(edit({ reviewedBase: 1 }))).not.toThrow();
  });
});
