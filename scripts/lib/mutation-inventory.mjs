// The unit-mutant INVENTORY (WEB-10a revision 11, R24; design assessment C5/Q7). PURE: no file, process or test runner, so it can be
// shown to fail cheaply (tests/static/mutation-inventory.test.ts) and run BEFORE any control or mutant.
//
// The runner keeps an independent expected count of the catalogue (EXPECTED_UNIT): a catalogue that silently lost or gained an entry
// must not pass. Revision 10 added ten mutants without moving that count, and the only check of it ran at the END of a full campaign
// (a patch-only `--check` exits before it, a `--only` run skips it), so a fully successful default run would have failed on arithmetic
// alone. Now the catalogue is checked first (in every mode), and the completion is checked by MEMBERSHIP, not by a total: each mutant
// selected is accounted for exactly once (run or failed to apply), so a missing and a duplicate entry cannot cancel each other out.

/** What is wrong with the catalogue itself: empty, duplicate or malformed ids, and a count other than the one expected. */
export function catalogueProblems(catalogue, expected, name = "unit") {
  const problems = [];
  const seen = new Set();
  for (const [index, mutant] of catalogue.entries()) {
    const id = mutant?.id;
    if (typeof id !== "string" || !/^MU-(?:\d+|8C-[A-Z]*\d+[a-z]?)$/.test(id))
      problems.push(
        `${name} catalogue entry ${index} has no numeric or WEB-08c MU id`,
      );
    else if (seen.has(id))
      problems.push(`${name} mutant ${id} is listed twice`);
    else seen.add(id);
  }
  if (catalogue.length !== expected)
    problems.push(
      `${name} catalogue has ${catalogue.length} mutants, expected ${expected} (update the expected count with the catalogue)`,
    );
  return problems;
}

/** What is wrong with a selection (`--only`): ids that are not in the catalogue, or named twice. Empty: the whole catalogue. */
export function selectionProblems(catalogue, only) {
  const known = new Set(catalogue.map((mutant) => mutant.id));
  const problems = [];
  const seen = new Set();
  for (const id of only) {
    if (!known.has(id))
      problems.push(`--only names ${id}, which is not a unit mutant`);
    else if (seen.has(id)) problems.push(`--only names ${id} twice`);
    seen.add(id);
  }
  return problems;
}

/**
 * Whether the run accounted for exactly what was selected: every selected id once among `ran` (mutants whose tests ran) and
 * `unapplied` (patches that failed, themselves failures of the run), none twice, none unknown. With no selection, the selection is the
 * whole catalogue, which must also have the expected count.
 */
export function completionProblems({
  catalogue,
  expected,
  only,
  ran,
  unapplied,
}) {
  const problems =
    only.length === 0 ? catalogueProblems(catalogue, expected) : [];
  const selected =
    only.length === 0 ? catalogue.map((mutant) => mutant.id) : only;
  const wanted = new Set(selected);
  const counted = new Map();
  for (const id of [...ran, ...unapplied])
    counted.set(id, (counted.get(id) ?? 0) + 1);
  for (const id of wanted)
    if (!counted.has(id))
      problems.push(
        `selected mutant ${id} was neither run nor reported unapplied`,
      );
  for (const [id, times] of counted) {
    if (!wanted.has(id)) problems.push(`mutant ${id} was run but not selected`);
    else if (times > 1)
      problems.push(`mutant ${id} is accounted for ${times} times`);
  }
  return problems;
}
