import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { DEXIE_SCHEMA, STORE_NAMES } from "../../src/data/model/schema";
import "../../src/data/plans/commit-page";
import "../../src/data/plans/epoch";
import "../../src/data/plans/fence";
import "../../src/data/plans/form-recovery";
import "../../src/data/plans/outbox";
import "../../src/data/plans/profile";
import "../../src/data/plans/retry-state";
import "../../src/data/plans/sync-writers";
import { listPlans } from "../../src/data/plans/registry";

/**
 * docs/data-layer.md is checked against the code it describes (plan S-8: every statement of behaviour was checked against the code and
 * a test; this keeps the checkable ones checked): the residual-window statement is reproduced verbatim and the commit guard is never
 * described as inside the atomic commit, every constant in the table exists in the config, every store and writer named exists.
 */
const doc = readFileSync("docs/data-layer.md", "utf8");

describe("docs/data-layer.md", () => {
  it("reproduces the residual-window statement verbatim", () => {
    expect(doc).toContain(
      "> A response decoded under `(A, e)` may still be applied to A's own database after another page has committed a transition away from `(A, e)`, **if and only if** no page of this browser has yet (a) closed A's connection (the identity left A), or (b) published the new epoch to A's database (the epoch changed within A), and this page has not yet been told. The window ends at the earliest of: this page's notice, the next page's observation, the data transaction's own guard reads.",
    );
  });

  it("never describes the commit guard as inside the atomic commit", () => {
    for (const match of doc.matchAll(/inside the atomic commit/gi)) {
      const around = doc.slice(Math.max(0, match.index - 60), match.index);
      expect(around, "a use of the phrase must be a negation").toMatch(
        /not (be )?\*{0,2}$|\*\*not\*\* $/i,
      );
    }
  });

  it("names every constant of the table, and every one exists in the config", () => {
    const section = doc.slice(doc.indexOf("## Provisional constants"));
    const names = [...section.matchAll(/^\| `([A-Za-z]+)`/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names)
      expect(
        name !== undefined &&
          (name in DATA_CONFIG || name === "maxResponseBytesFor"),
        String(name),
      ).toBe(true);
  });

  it("names every store and its indexes as the schema declares them", () => {
    for (const store of STORE_NAMES) expect(doc).toContain(store);
    expect(DEXIE_SCHEMA.drafts).toContain("*index_targets");
    expect(doc).toContain("`*index_targets`");
  });

  it("lists every writer W-number that a registered plan declares", () => {
    const declared = new Set(listPlans().map((plan) => plan.writer));
    for (const writer of declared)
      expect(doc, `${writer} is in the writer table`).toMatch(
        new RegExp(`\\| ${writer} \\|`),
      );
  });
});
