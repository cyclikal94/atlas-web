// The durable effects of a profiled page (WEB-09c revision 12; review 12's R2 follow-up, design assessment DA-D1 and invariant 5;
// family profiling-evidence-completeness). Dependency-free, so the same derivation runs in Node (the evidence contract, the device
// results reader, the cold-run writers) and in the fixture-only device page.
//
// A committed page leaves the cache it was applied to changed by its changes IN ORDER (src/data/plans/commit-page.ts: a run of upserts is
// one bulkPut, a run of removes one bulkDelete, the order is preserved, nothing compares versions): an upsert replaces the row, a remove
// deletes it, the last write wins. Every profiled cold run and device engine run starts from a NEW, empty database (a new browser context,
// or a new profiling account), and every later request of the run is answered with an empty page, so the cache a run leaves is exactly
// the served page applied to an empty cache. The ENTRIES are the sorted `id@version` of the rows: their count is the number of distinct
// surviving ids (W4's 800 changes leave 80), never the number of changes, and their digest also shows which write survived.
//
// The digest is the caller's: SHA-256 of `effectsText(entries)` (Node's crypto, or Web Crypto in the page).

export const EFFECTS_METHOD = "cache-rows/1";

const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);

/** The sorted entries of a set of cache rows (`id@version`), or null with the reason when a row is not a cache row. */
export function entriesOfRows(rows) {
  if (!Array.isArray(rows))
    return { entries: null, problem: "not a list of rows" };
  const entries = [];
  for (const row of rows) {
    if (
      !isObj(row) ||
      typeof row.id !== "string" ||
      !Number.isInteger(row.version)
    )
      return {
        entries: null,
        problem: "a cache row without its id and version",
      };
    entries.push(`${row.id}@${row.version}`);
  }
  return { entries: entries.sort(), problem: null };
}

/**
 * The entries a sync page leaves when applied in order to an empty cache, from the page's text (the exact served bytes, decoded as UTF-8).
 * Returns `{ entries, problem }`; a body that is not a page (a negative control) has no entries.
 */
export function entriesOfPage(text) {
  let page;
  try {
    page = JSON.parse(text);
  } catch {
    return { entries: null, problem: "the served body is not JSON" };
  }
  if (!isObj(page) || !Array.isArray(page.batches))
    return { entries: null, problem: "the served body is not a sync page" };
  const rows = new Map();
  for (const batch of page.batches) {
    if (!isObj(batch) || !Array.isArray(batch.changes))
      return { entries: null, problem: "a batch without its changes" };
    for (const change of batch.changes) {
      if (isObj(change) && change.kind === "upsert" && isObj(change.resource)) {
        const { id, version } = change.resource;
        if (typeof id !== "string" || !Number.isInteger(version))
          return {
            entries: null,
            problem: "an upsert without its id and version",
          };
        rows.set(id, version);
      } else if (
        isObj(change) &&
        change.kind === "remove" &&
        typeof change.id === "string"
      )
        rows.delete(change.id);
      else
        return {
          entries: null,
          problem: "a change that is neither an upsert nor a remove",
        };
    }
  }
  return {
    entries: [...rows].map(([id, version]) => `${id}@${version}`).sort(),
    problem: null,
  };
}

/** The text the digest is taken of. */
export const effectsText = (entries) => entries.join("\n");

/**
 * The problems of a run's recorded effects against the expected ones (`{ rows, entries_sha256 }`, derived by the reader from the served
 * bytes). `effects` is what the run recorded: `{ method, rows, entries_sha256 }`.
 */
export function effectsProblems(effects, expected) {
  if (!isObj(effects)) return ["the cache the run left was not recorded"];
  const problems = [];
  if (effects.method !== EFFECTS_METHOD)
    problems.push(
      `the effects method ${String(effects.method)} is not ${EFFECTS_METHOD}`,
    );
  if (!Number.isInteger(effects.rows) || effects.rows < 0)
    problems.push("the effects do not record the cache's row count");
  if (
    typeof effects.entries_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(effects.entries_sha256)
  )
    problems.push("the effects do not record the cache's digest");
  if (
    !isObj(expected) ||
    !Number.isInteger(expected.rows) ||
    typeof expected.entries_sha256 !== "string"
  )
    return [...problems, "the served page's effects are not known"];
  if (problems.length) return problems;
  if (effects.rows !== expected.rows)
    problems.push(
      `the cache holds ${effects.rows} rows; the served page leaves ${expected.rows}`,
    );
  else if (effects.entries_sha256 !== expected.entries_sha256)
    problems.push("the cache's rows are not the ones the served page leaves");
  return problems;
}
