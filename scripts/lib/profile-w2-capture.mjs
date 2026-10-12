// The W2 capture observation (WEB-09c revision 4; review 4 R2, design assessment A1-A4): what a captured `/sync` page must hold before
// it counts as the server-maximal dense batch the programme measures, derived from its BYTES and nothing else. One pure reader, shared by
// the integration writer (it asserts the capture before it records it), the evidence contract (scripts/lib/profile-contract.mjs, which
// reconciles the observation with the recorded metadata and both limits) and the device validator (it certifies a hand-over's capture
// before accepting its hash). It is kept out of the timed device processing path.
//
// A capture is valid only if every branch below holds; each failure is a named problem, never a skipped check:
//  - the bytes are UTF-8 and JSON, and the JSON is a sync PAGE: an object with exactly `phase`, `batches`, `next_cursor` and `has_more`
//    (a primitive, an array, `null` or an empty object is not one), `phase` "delta", `has_more` a boolean, `next_cursor` an opaque string
//    of 1-512 code points, at most `limit` (and at most 80) batches;
//  - every batch is an object with exactly `revision` (a non-negative integer, strictly increasing across the page) and `changes` (at most
//    800), and every change is a valid element of the pinned contract: `{kind: "remove", id}` or `{kind: "upsert", resource}` with a whole
//    projection (the keys the production decoder requires and allows, a UUID id, a known kind, a UUID or null parent, a 1-300 code point
//    label, an object or null value, a version >= 1, boolean can_edit and archived, an optional policy version >= 1);
//  - exactly one batch holds the SEEDED person, and that batch is the seed exactly: the person itself (kind `person`, no parent) and
//    199 DISTINCT checklist fields whose parent is that person, 200 changes and nothing else; every field's value is the dense checklist the
//    writer seeds: exactly `kind`, `items` and `checked`, 100 items of exactly a UUID `id` (all distinct) and the label "x", and 40 distinct
//    checked ids, each one of the field's own items.
// The production scanner and decoder are the structural reference; they cannot establish the density (an unregistered value kind is
// accepted by them), which is what this adds. Ordinary batches beside the target (a limit-80 page can carry them) stay legal when valid.
//
// Revision 5 (review 5 R2; design assessment DA-E1/DA-E2, A1/A3): the reference is no longer only restated. The checks above read a PARSED
// page, after `JSON.parse` has collapsed a duplicated page or batch key, re-spelt a revision such as `12e0` and the decoder has dropped a
// byte order mark, and none of them applied production's nesting, element-size or element-node gates. So every capture that reaches the
// page body is also put, as the bytes it is, through the candidate's own receive path (scripts/lib/production-page-reader.mjs: the
// response bound, the byte scan, every element's decoder and gates, companion batches included); its refusal is a problem of the capture,
// and a refused capture yields no target, no digest and no derived figure (nothing is derived from bytes production would not admit). The
// earlier refusals of bytes that are not UTF-8, not JSON or not a page object stay as they were (production refuses those too).
import { createHash } from "node:crypto";
import { productionRefusal } from "./production-page-reader.mjs";

/** The seed the integration writer makes (tests/integration/integration.profile-sync.spec.ts `seedDensePerson`, `denseChecklist`). */
export const W2_SEED = Object.freeze({
  fields: 199,
  items: 100,
  checked: 40,
  item_label: "x",
  changes: 200,
});

// The pinned contract's projection (src/data/scan/validate.ts) and resource kinds (src/data/model/types.ts), written out again;
// tests/profiling/profile-w2-capture.test.ts holds them equal to the production lists.
export const RESOURCE_KINDS = Object.freeze([
  "person",
  "field",
  "task",
  "execution",
  "occurrence",
  "progress",
  "list",
  "calendar_source",
  "event",
  "review",
  "reminder",
]);
export const PROJECTION_REQUIRED = Object.freeze([
  "id",
  "kind",
  "parent_id",
  "label",
  "value",
  "version",
  "can_edit",
  "archived",
]);
const PROJECTION_ALLOWED = new Set([...PROJECTION_REQUIRED, "policy_version"]);
const PAGE_KEYS = ["batches", "has_more", "next_cursor", "phase"];
const MAX_BATCHES = 80;
const MAX_CHANGES_PER_BATCH = 800;
const MAX_CURSOR = 512;
const MAX_PROBLEMS = 24;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const isVersion = (x) => Number.isSafeInteger(x) && x >= 1;
const codePoints = (text) => [...text].length;
const kindOf = (x) =>
  x === null
    ? "null"
    : Array.isArray(x)
      ? "an array"
      : typeof x === "object"
        ? "an object"
        : `a ${typeof x}`;
/** An object's own keys are exactly `keys` (an object cannot hold a key twice, so the count and membership settle it). */
const exactKeys = (x, keys) =>
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));

/** Canonical JSON (keys sorted at every level): the same resource reads the same whatever order its keys were written in. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObj(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Why one change element is not a valid element of the pinned contract (null: it is). */
export function changeProblem(change) {
  if (!isObj(change)) return `is ${kindOf(change)}, not a change object`;
  if (change.kind === "remove")
    return exactKeys(change, ["id", "kind"]) &&
      typeof change.id === "string" &&
      UUID.test(change.id)
      ? null
      : "is not a removal of exactly a UUID id";
  if (change.kind !== "upsert")
    return `has kind ${JSON.stringify(change.kind)}`;
  if (!exactKeys(change, ["kind", "resource"]) || !isObj(change.resource))
    return "is not an upsert of exactly one resource";
  const p = change.resource;
  const unknown = Object.keys(p).filter((k) => !PROJECTION_ALLOWED.has(k));
  if (unknown.length)
    return `has projection fields outside the contract (${unknown.join(", ")})`;
  const missing = PROJECTION_REQUIRED.filter((k) => !(k in p));
  if (missing.length) return `lacks projection fields (${missing.join(", ")})`;
  if (typeof p.id !== "string" || !UUID.test(p.id))
    return "has an id that is not a UUID";
  if (!RESOURCE_KINDS.includes(p.kind))
    return `has resource kind ${JSON.stringify(p.kind)}`;
  if (
    p.parent_id !== null &&
    (typeof p.parent_id !== "string" || !UUID.test(p.parent_id))
  )
    return "has a parent that is neither null nor a UUID";
  if (
    typeof p.label !== "string" ||
    codePoints(p.label) < 1 ||
    codePoints(p.label) > 300
  )
    return "has a label that is not 1-300 code points of text";
  if (p.value !== null && !isObj(p.value))
    return "has a value that is neither null nor an object";
  if (!isVersion(p.version)) return "has a version that is not an integer >= 1";
  if (typeof p.can_edit !== "boolean" || typeof p.archived !== "boolean")
    return "has can_edit or archived that is not a boolean";
  if ("policy_version" in p && !isVersion(p.policy_version))
    return "has a policy version that is not an integer >= 1";
  return null;
}

/** Why a field value is not the writer's dense checklist (null: it is): 100 distinct UUID items labelled "x", 40 distinct checked of them. */
export function denseChecklistProblem(value) {
  if (!isObj(value)) return `its value is ${kindOf(value)}, not a checklist`;
  if (
    !exactKeys(value, ["checked", "items", "kind"]) ||
    value.kind !== "checklist"
  )
    return "its value is not exactly a checklist's kind, items and checked";
  const { items, checked } = value;
  if (!Array.isArray(items) || items.length !== W2_SEED.items)
    return `it holds ${Array.isArray(items) ? items.length : "no"} items, not ${W2_SEED.items}`;
  const ids = new Set();
  for (const item of items) {
    if (!isObj(item) || !exactKeys(item, ["id", "label"]))
      return "an item is not exactly an id and a label";
    if (typeof item.id !== "string" || !UUID.test(item.id))
      return "an item's id is not a UUID";
    if (item.label !== W2_SEED.item_label)
      return `an item is labelled ${JSON.stringify(item.label)}, not "${W2_SEED.item_label}"`;
    ids.add(item.id);
  }
  if (ids.size !== items.length) return "its item ids are not distinct";
  if (!Array.isArray(checked) || checked.length !== W2_SEED.checked)
    return `it checks ${Array.isArray(checked) ? checked.length : "no"} items, not ${W2_SEED.checked}`;
  if (new Set(checked).size !== checked.length)
    return "its checked ids are not distinct";
  if (!checked.every((id) => typeof id === "string" && ids.has(id)))
    return "a checked id is not one of its own items";
  return null;
}

/**
 * Observes one W2 capture. `bytes`: the file as captured (a Buffer or Uint8Array); `person`: the seeded person's id the writer recorded;
 * `limit`: the page limit it was read with (1 or 80). Returns every `problems` found (empty: a valid W2 target capture), the `page` as read
 * (null when there is no page) and the `target` batch (null when there is none): its index, revision, the person, its distinct field ids
 * in order, the value size of its checklists and a digest of its canonical contents, for the cross-limit comparison. Revision 5: when the
 * production receive path refuses the bytes, `page` and `target` are both null and that refusal is one of the problems.
 */
export function observeW2Capture(bytes, { person, limit }) {
  const problems = [];
  const add = (message) => {
    if (problems.length < MAX_PROBLEMS) problems.push(message);
    else if (problems.length === MAX_PROBLEMS)
      problems.push("(further problems not listed)");
  };
  const out = { problems, page: null, target: null };
  if (typeof person !== "string" || !UUID.test(person))
    add("the seeded person's identity is not a recorded UUID");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    add("the capture is not UTF-8");
    return out;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    add(`the capture is not JSON: ${String(error.message).slice(0, 120)}`);
    return out;
  }
  if (!isObj(body)) {
    add(`the capture is ${kindOf(body)}, not a sync page`);
    return out;
  }
  if (!exactKeys(body, PAGE_KEYS)) {
    add(
      `the page's fields are [${Object.keys(body).sort().join(", ")}], not exactly [${PAGE_KEYS.join(", ")}]`,
    );
    return out;
  }
  if (body.phase !== "delta")
    add(`the page is phase ${JSON.stringify(body.phase)}, not a delta page`);
  if (typeof body.has_more !== "boolean") add("has_more is not a boolean");
  if (
    typeof body.next_cursor !== "string" ||
    codePoints(body.next_cursor) < 1 ||
    codePoints(body.next_cursor) > MAX_CURSOR
  )
    add("next_cursor is not an opaque string of 1-512 code points");
  if (!Array.isArray(body.batches)) {
    add(`batches is ${kindOf(body.batches)}, not an array`);
    return out;
  }
  const batches = body.batches;
  if (
    batches.length >
    Math.min(MAX_BATCHES, Number.isInteger(limit) ? limit : MAX_BATCHES)
  )
    add(`${batches.length} batches on a page read with limit ${limit}`);
  let previous = -1;
  let changes = 0;
  for (const [i, batch] of batches.entries()) {
    if (!isObj(batch) || !exactKeys(batch, ["changes", "revision"])) {
      add(`batch ${i + 1} is not exactly a revision and its changes`);
      continue;
    }
    if (!Number.isSafeInteger(batch.revision) || batch.revision < 0)
      add(`batch ${i + 1}'s revision is not a non-negative integer`);
    else if (batch.revision <= previous)
      add(`batch ${i + 1}'s revision does not follow the one before it`);
    else previous = batch.revision;
    if (!Array.isArray(batch.changes)) {
      add(`batch ${i + 1}'s changes are not an array`);
      continue;
    }
    if (batch.changes.length > MAX_CHANGES_PER_BATCH)
      add(`batch ${i + 1} holds more than ${MAX_CHANGES_PER_BATCH} changes`);
    changes += batch.changes.length;
    for (const [j, change] of batch.changes.entries()) {
      const why = changeProblem(change);
      if (why) add(`batch ${i + 1} change ${j + 1} ${why}`);
    }
  }
  out.page = {
    phase: body.phase,
    has_more: body.has_more,
    batches: batches.length,
    changes,
    revisions: batches.map((b) => (isObj(b) ? b.revision : null)),
  };
  // The bytes themselves through the production receive path (revision 5): a page production refuses is not a capture of what it would
  // process, whatever its parsed form looks like, and nothing is derived from it: no page figures (a caller would read the bytes again to
  // reconcile them; a byte order mark, for one, is dropped by this file's decoder but not by `Buffer#toString`) and no target.
  const refusal = productionRefusal(bytes, { limit });
  if (refusal) {
    add(refusal);
    out.page = null;
    return out;
  }

  // The target: the one batch that holds the seeded person, which must be the seed and nothing else.
  const holding = batches
    .map((b, i) => [b, i])
    .filter(
      ([b]) =>
        isObj(b) &&
        Array.isArray(b.changes) &&
        b.changes.some(
          (c) =>
            isObj(c) &&
            c.kind === "upsert" &&
            isObj(c.resource) &&
            c.resource.id === person,
        ),
    );
  if (holding.length !== 1) {
    add(
      holding.length === 0
        ? "no batch holds the seeded person: the capture is not the seeded dense batch"
        : `${holding.length} batches hold the seeded person: the seed is not one batch`,
    );
    return out;
  }
  const [target, index] = holding[0];
  const at = `the target batch (batch ${index + 1})`;
  if (target.changes.length !== W2_SEED.changes)
    add(
      `${at} holds ${target.changes.length} changes, not the seed's ${W2_SEED.changes} (the person and ${W2_SEED.fields} fields)`,
    );
  const persons = target.changes.filter(
    (c) => isObj(c) && isObj(c.resource) && c.resource.id === person,
  );
  if (persons.length !== 1)
    add(`${at} holds the seeded person ${persons.length} times`);
  const self = persons[0]?.resource;
  if (
    persons.length === 1 &&
    (persons[0].kind !== "upsert" ||
      self.kind !== "person" ||
      self.parent_id !== null)
  )
    add(`${at}'s resource with the seeded id is not a person without a parent`);
  const fieldIds = [];
  const sizes = new Set();
  let others = 0;
  for (const change of target.changes) {
    if (
      !isObj(change) ||
      !isObj(change.resource) ||
      change.resource.id === person
    )
      continue;
    const r = change.resource;
    if (
      change.kind !== "upsert" ||
      r.kind !== "field" ||
      r.parent_id !== person
    ) {
      others += 1;
      continue;
    }
    const why = denseChecklistProblem(r.value);
    if (why) add(`${at}: field ${r.id}: ${why}`);
    else sizes.add(Buffer.byteLength(JSON.stringify(r.value)));
    fieldIds.push(r.id);
  }
  if (others)
    add(
      `${at} holds ${others} change(s) that are not checklist fields of the seeded person`,
    );
  const distinct = new Set(fieldIds).size;
  if (distinct !== fieldIds.length)
    add(
      `${at}'s field ids are not distinct (${fieldIds.length - distinct} repeated)`,
    );
  if (distinct !== W2_SEED.fields)
    add(
      `${at} holds ${distinct} distinct fields of the seeded person, not ${W2_SEED.fields}`,
    );
  if (sizes.size > 1) add(`${at}'s checklist values differ in size`);
  out.target = {
    index,
    revision: target.revision,
    person,
    fields: distinct,
    field_ids: fieldIds,
    value_bytes: sizes.size === 1 ? [...sizes][0] : null,
    digest: createHash("sha256").update(canonical(target)).digest("hex"),
  };
  return out;
}

/** Why two limits' observations of one engine do not show the same seeded batch (the same revision and contents), or none. */
export function sameTargetProblems(a, b) {
  if (!a?.target || !b?.target) return [];
  const problems = [];
  if (a.target.revision !== b.target.revision)
    problems.push(
      `the seeded batch is revision ${a.target.revision} at one limit and ${b.target.revision} at the other`,
    );
  else if (a.target.digest !== b.target.digest)
    problems.push("the seeded batch's contents differ between the two limits");
  return problems;
}
