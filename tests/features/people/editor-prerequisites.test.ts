import { describe, expect, test } from "vitest";
import type { Loadable } from "../../../src/data";
import { editorReads } from "../../../src/features/people/field/prerequisites";
import type { ChainResult } from "../../../src/features/people/reads";

/**
 * Review 9, finding 2: what the field editor's reads establish (`field/prerequisites.ts`). A failed read is said at once (never hidden
 * behind another read still loading) and never read as "nothing there"; loading and an incomplete chain are not "none"; the cap is its own
 * state; only `read` lets the editor look at the rows. Every combination of the three reads' states.
 */
const READY: Loadable<unknown> = { status: "ready", value: null };
const LOADING: Loadable<unknown> = { status: "loading" };
const ERROR: Loadable<unknown> = { status: "unavailable", reason: "error" };
const CLOSED: Loadable<unknown> = { status: "unavailable", reason: "closed" };
const ABSENT: Loadable<unknown> = { status: "unavailable", reason: "absent" };
const RESOURCES = { READY, LOADING, ERROR, CLOSED, ABSENT };

const chain = (over: Partial<ChainResult<unknown>>): ChainResult<unknown> => ({
  status: "ready",
  rows: [],
  capped: false,
  complete: true,
  ...over,
});
const CHAINS = {
  complete: chain({}),
  loading: chain({ status: "loading", complete: false }),
  laterWindowLoading: chain({ complete: false }),
  failed: chain({ status: "failed", complete: false }),
  capped: chain({ capped: true, complete: false }),
  absent: chain({ status: "absent", complete: false }),
};

const failed = (l: Loadable<unknown>) =>
  l.status === "unavailable" && l.reason !== "absent";

describe("editorReads", () => {
  for (const [personName, person] of Object.entries(RESOURCES))
    for (const [fieldName, field] of [
      ...Object.entries(RESOURCES),
      ["none (a new field)", null] as const,
    ])
      for (const [chainName, outstanding] of Object.entries(CHAINS))
        test(`person ${personName}, field ${fieldName}, chain ${chainName}`, () => {
          const got = editorReads(person, field, outstanding);
          const expected = failed(person)
            ? { kind: "failed", read: "person" }
            : field !== null && failed(field)
              ? { kind: "failed", read: "field" }
              : outstanding.status === "failed"
                ? { kind: "failed", read: "changes" }
                : person.status === "loading" ||
                    field?.status === "loading" ||
                    chainName === "loading" ||
                    chainName === "laterWindowLoading"
                  ? { kind: "loading" }
                  : chainName === "capped"
                    ? { kind: "capped" }
                    : { kind: "read" };
          expect(got).toEqual(expected);
        });

  test("a failure is said even while every other read still loads", () => {
    expect(editorReads(LOADING, ERROR, CHAINS.loading)).toEqual({
      kind: "failed",
      read: "field",
    });
    expect(editorReads(LOADING, LOADING, CHAINS.failed)).toEqual({
      kind: "failed",
      read: "changes",
    });
  });

  test("a closed database is a failed read, an absent one is read (it holds nothing)", () => {
    expect(editorReads(READY, CLOSED, CHAINS.complete).kind).toBe("failed");
    expect(editorReads(ABSENT, ABSENT, CHAINS.absent).kind).toBe("read");
  });
});
