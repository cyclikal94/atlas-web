// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  catalogueProblems,
  completionProblems,
  selectionProblems,
} from "../../scripts/lib/mutation-inventory.mjs";
import { ENGINE, UNIT } from "../../scripts/mutation/data-catalogue.mjs";
import {
  EXPECTED_ENGINE,
  EXPECTED_UNIT,
} from "../../scripts/mutation/expected.mjs";

/**
 * WEB-10a revision 11 (R24, `task-mutation-catalogue-count`; design assessment C5/Q7/S16): the unit-mutant inventory, checked without
 * running a mutant. Revision 10 added ten mutants without moving the expected count, and the only check of it ran after a full campaign,
 * so a fully successful default run would have ended `count_ok: false`. The maintained catalogue now agrees with its expected count (here,
 * in the ordinary unit suite), the runner checks it before anything runs in every mode, and a completion is judged by membership.
 */
const ids = (catalogue: Array<{ id: string }>) => catalogue.map((m) => m.id);
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("the maintained catalogue agrees with its independent expected counts", () => {
  test("unit and engine catalogues: unique MU ids, the expected number of each", () => {
    expect(catalogueProblems(UNIT, EXPECTED_UNIT)).toEqual([]);
    expect(catalogueProblems(ENGINE, EXPECTED_ENGINE, "engine")).toEqual([]);
  });

  test("a fully successful default run is accounted for (count_ok), and revision 10's stale count would not be", () => {
    const full = {
      catalogue: UNIT,
      only: [],
      ran: ids(UNIT),
      unapplied: [],
    };
    expect(completionProblems({ ...full, expected: EXPECTED_UNIT })).toEqual(
      [],
    );
    // Review 11's arithmetic: the catalogue as it was then (1,279) against the count it kept (1,269).
    const then = UNIT.slice(0, 1279);
    expect(
      completionProblems({
        ...full,
        catalogue: then,
        ran: ids(then),
        expected: 1269,
      }),
    ).toEqual([
      "unit catalogue has 1279 mutants, expected 1269 (update the expected count with the catalogue)",
    ]);
  });
});

describe("completion is judged by membership: every selected mutant exactly once", () => {
  const catalogue = [{ id: "MU-1" }, { id: "MU-2" }, { id: "MU-3" }];
  const full = { catalogue, expected: 3, only: [] as string[] };

  test("a missing and a duplicate entry do not cancel out", () => {
    expect(
      completionProblems({
        ...full,
        ran: ["MU-1", "MU-2", "MU-2"],
        unapplied: [],
      }),
    ).toEqual([
      "selected mutant MU-3 was neither run nor reported unapplied",
      "mutant MU-2 is accounted for 2 times",
    ]);
  });

  test("an unknown mutant, and one counted as both run and unapplied, are problems", () => {
    expect(
      completionProblems({
        ...full,
        ran: ["MU-1", "MU-2", "MU-3", "MU-9"],
        unapplied: ["MU-1"],
      }),
    ).toEqual([
      "mutant MU-1 is accounted for 2 times",
      "mutant MU-9 was run but not selected",
    ]);
  });

  test("an unapplied patch is accounted for (it fails the run on its own, as a patch failure)", () => {
    expect(
      completionProblems({
        ...full,
        ran: ["MU-1", "MU-3"],
        unapplied: ["MU-2"],
      }),
    ).toEqual([]);
  });

  test("a selection (--only) is judged against itself, not the catalogue's total", () => {
    const only = ["MU-1", "MU-3"];
    expect(
      completionProblems({
        ...full,
        only,
        ran: ["MU-3", "MU-1"],
        unapplied: [],
      }),
    ).toEqual([]);
    expect(
      completionProblems({ ...full, only, ran: ["MU-1"], unapplied: [] }),
    ).toEqual(["selected mutant MU-3 was neither run nor reported unapplied"]);
    expect(selectionProblems(catalogue, ["MU-1", "MU-7", "MU-1"])).toEqual([
      "--only names MU-7, which is not a unit mutant",
      "--only names MU-1 twice",
    ]);
  });

  test("the catalogue check: duplicate and malformed ids, and a count other than expected", () => {
    expect(
      catalogueProblems(
        [{ id: "MU-1" }, { id: "MU-1" }, { id: "x" }] as Array<{ id: string }>,
        2,
      ),
    ).toEqual([
      "unit mutant MU-1 is listed twice",
      "unit catalogue entry 2 has no MU-<n> id",
      "unit catalogue has 3 mutants, expected 2 (update the expected count with the catalogue)",
    ]);
  });
});

describe("the runner checks the inventory before anything runs, in every mode (no vitest is started here)", () => {
  const runner = (args: string[]) => {
    const out = mkdtempSync(join(tmpdir(), "atlas-inventory-"));
    made.push(out);
    return spawnSync(
      process.execPath,
      ["scripts/run-data-mutants.mjs", ...args, "--out", out],
      { encoding: "utf8", timeout: 120_000 },
    );
  };

  test("--check with a selection applies only those patches", () => {
    const run = runner(["--check", "--only", "MU-2223,MU-2224"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("2 of 2 patches apply.");
  });

  test("an unknown --only id fails before any patch is applied (it used to select nothing and pass)", () => {
    const run = runner(["--check", "--only", "MU-2223,MU-99999"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "INVENTORY --only names MU-99999, which is not a unit mutant",
    );
    expect(run.stdout).not.toContain("patches apply");
  });
});
