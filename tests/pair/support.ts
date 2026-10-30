import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import {
  SCHEMA,
  validateInterval,
} from "../../scripts/integration/pair-evidence.mjs";
import {
  CASES,
  designedSkipReason,
} from "../../scripts/integration/pair-matrix.mjs";
import {
  BACKEND,
  challengeFor,
  expect,
  exposeSession,
  freshVerifier,
  ORIGIN,
  paceSignIn,
  proxy,
  raw,
  test,
} from "../integration/helpers";

/**
 * WEB-09c (R23-PAIR): the support of the development-pair journey (pair.development.spec.ts). Everything here talks to the REAL backend the
 * runner (scripts/integration/run-development-pair.mjs) started, through public routes, except where a name says otherwise:
 *   - `insertSyntheticBatch` writes ONE notice row into the disposable SQLite database (W-synthetic, labelled synthetic, as the backend's
 *     pinned dense fixture does);
 *   - `tap.fault` arms a one-shot, labelled alteration of ONE answer in the tap (scripts/integration/pair-tap.mjs);
 *   - the delaying proxy's rules hold, drop or replace answers (tests/integration/helpers.ts `proxy`).
 * The browser runs the PRODUCTION composition (the session harness page with `?leader=production`: the election, the engine, the recovery job,
 * production quota, session persistence) and is told only that its server segments (`?segmented=capable`), a DIAGNOSTIC boot option.
 */

export const PAIR_BACKEND = process.env.ATLAS_PAIR_BACKEND ?? "";
const TAP = process.env.ATLAS_PAIR_TAP ?? "";
const BODIES = process.env.ATLAS_PAIR_BODIES ?? "";
const EVIDENCE = process.env.ATLAS_PAIR_EVIDENCE ?? "";
const DATABASE = process.env.ATLAS_PAIR_DATABASE ?? "";
export const SELECTION_SHA256 = process.env.ATLAS_PAIR_SELECTION_SHA256 ?? "";
export const API_VERSION = process.env.ATLAS_PAIR_API_VERSION ?? "";
export const RELEASED_VERSION = process.env.ATLAS_PAIR_RELEASED_VERSION ?? "";
const SYNC = "/api/experimental/v1/sync";

export interface PairAccount {
  username: string;
  password: string;
  account_id: string;
}
const ACCOUNTS: Record<string, PairAccount> = JSON.parse(
  process.env.ATLAS_INTEGRATION_ACCOUNTS ?? "{}",
);
export function accountFor(name: string): PairAccount {
  const account = ACCOUNTS[name];
  if (!account) throw new Error(`the runner created no account ${name}`);
  return account;
}
export const readerOf = (id: string) => accountFor(`pair-${id.toLowerCase()}`);
export const writerAccount = () => accountFor("pair-writer");

/**
 * The case's matrix row. Not run without the pair runner; skipped BY DESIGN (the reason the runner's judge requires) when the case is not
 * executable on the selected backend.
 */
export function caseRow(id: string) {
  const row = CASES.find((c) => c.id === id);
  if (!row) throw new Error(`${id} is not in the matrix`);
  test.skip(
    !PAIR_BACKEND,
    "not run: scripts/integration/run-development-pair.mjs did not start the pair",
  );
  test.skip(
    !(row.backends as readonly string[]).includes(PAIR_BACKEND),
    designedSkipReason(PAIR_BACKEND),
  );
  return row;
}

// ---- the tap -------------------------------------------------------------------------------------------------------------------------
export interface TapRecord {
  seq: number;
  label: string | null;
  method: string;
  path: string;
  query?: {
    cursor: string | null;
    limit: string | null;
    max_changes: string | null;
  };
  status: number | null;
  bytes?: number;
  sha256?: string;
  body_file?: string;
  phase?: string | null;
  batches?: number | null;
  changes?: number | null;
  revision?: number | null;
  last_revision?: number | null;
  segment?: { index: number; last: boolean } | null;
  has_more?: boolean | null;
  next_cursor?: string | null;
  code?: string | null;
  t_request: number;
  t_upstream_end: number | null;
  t_delivered: number | null;
  client_gone?: boolean;
  /** The tap destroyed the connection instead of answering (the server HAS answered): the client received nothing. */
  dropped?: string;
  delivered?: {
    injected: string;
    status: number;
    bytes: number;
    sha256: string;
    body_file: string;
    revision: number | null;
    last_revision: number | null;
    segment: { index: number; last: boolean } | null;
    has_more: boolean | null;
    next_cursor: string | null;
  };
}
export interface TapFault {
  id: string;
  kind: string;
  afterIndex?: number;
  value?: string;
  delta?: number;
  fired: number | null;
  error?: string;
}
async function tapCall<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${TAP}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      `tap ${method} ${path}: ${response.status} ${await response.text()}`,
    );
  return (await response.json()) as T;
}
export const tap = {
  label: (label: string | null) =>
    tapCall<{ label: string | null; seq: number }>("POST", "/label", { label }),
  log: async (since = 0) =>
    (
      await tapCall<{ dropped: number; records: TapRecord[] }>(
        "GET",
        `/log?since=${since}`,
      )
    ).records,
  fault: (spec: Omit<TapFault, "id" | "fired">) =>
    tapCall<TapFault>("POST", "/fault", spec),
  faults: () => tapCall<TapFault[]>("GET", "/faults"),
  flush: () => tapCall("POST", "/flush"),
  reset: () => tapCall<{ unfired: string[]; seq: number }>("POST", "/reset"),
};
export const bodyOf = (file: string): Buffer =>
  readFileSync(join(BODIES, file));
export const syncRecords = (records: TapRecord[]) =>
  records.filter((r) => r.method === "GET" && r.path.endsWith("/sync"));
/** What the CLIENT received: the injected answer when one was, else the server's. */
export const seen = (r: TapRecord) => ({
  status: r.dropped ? null : r.delivered ? r.delivered.status : r.status,
  revision: r.delivered ? r.delivered.revision : (r.revision ?? null),
  last_revision: r.delivered
    ? r.delivered.last_revision
    : (r.last_revision ?? null),
  segment: r.delivered ? r.delivered.segment : (r.segment ?? null),
  has_more: r.delivered ? r.delivered.has_more : (r.has_more ?? null),
  next_cursor: r.delivered ? r.delivered.next_cursor : (r.next_cursor ?? null),
});

// ---- accounts and sessions -----------------------------------------------------------------------------------------------------------
export interface RawPairSession {
  cookie: string;
  csrf: string;
  sessionId: string;
  accountId: string;
  deviceId: string;
}
/** A raw, independent session of `account` on `deviceId` (no browser), through the preview origin as a browser's request would go. */
export async function rawSignInAs(
  account: PairAccount,
  deviceId = `raw-${freshVerifier().slice(0, 10)}`,
): Promise<RawPairSession> {
  await paceSignIn(account.username);
  const verifier = freshVerifier();
  const exchange = await raw("POST", "/browser-sessions", {
    body: {
      username: account.username,
      password: account.password,
      attempt_challenge: await challengeFor(verifier),
      device_id: deviceId,
    },
  });
  if (exchange.status !== 200)
    throw new Error(`raw exchange for ${account.username}: ${exchange.status}`);
  const activated = await raw("POST", "/browser-sessions/activate", {
    body: { grant: (exchange.json as { grant: string }).grant, verifier },
  });
  if (activated.status !== 200)
    throw new Error(
      `raw activate for ${account.username}: ${activated.status}`,
    );
  const [pair] = (activated.setCookie[0] ?? "").split(";");
  const cookie = pair ?? "";
  const current = await raw("GET", "/browser-sessions/current", {
    cookie,
    headers: { "x-atlas-session": "1" },
  });
  const body = current.json as {
    csrf_token: string;
    session_id: string;
    account_id: string;
  };
  return {
    cookie,
    csrf: body.csrf_token,
    sessionId: body.session_id,
    accountId: body.account_id,
    deviceId,
  };
}

/**
 * A `/sync` read of a RAW session sent DIRECTLY to the backend (not through the delaying proxy or the tap, so it is never held and never
 * labelled with the browser's interval): the foreign continuations of PAIR-B2/B3 and the backend capability probe of PAIR-P0.
 */
export async function rawSyncDirect(session: RawPairSession, query: string) {
  const response = await fetch(`${BACKEND}/api/experimental/v1/sync${query}`, {
    headers: {
      origin: ORIGIN,
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
      "x-atlas-session": "1",
    },
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return {
    status: response.status,
    json: json as {
      next_cursor?: string;
      has_more?: boolean;
      code?: string;
      batches?: Array<{
        revision: number;
        segment?: { index: number; last: boolean };
      }>;
    } | null,
  };
}
/** The raw session's delta cursor at the live edge (its snapshot, then deltas), read directly from the backend. */
export async function headOf(session: RawPairSession): Promise<string> {
  let query = "";
  for (let pages = 0; pages < 400; pages += 1) {
    const r = await rawSyncDirect(session, query);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const cursor = r.json?.next_cursor as string;
    if (!r.json?.has_more) return cursor;
    query = `?cursor=${encodeURIComponent(cursor)}`;
  }
  throw new Error("the raw session did not reach the live edge in 400 pages");
}

/** A writer: one idempotency key per logical write; a 503 (capacity) is asked again with the SAME key, so no retry creates twice. */
export async function writerFor(account: PairAccount) {
  const session = await rawSignInAs(account);
  const send = async (path: string, body: unknown) => {
    const key = randomUUID();
    for (let attempt = 0; ; attempt += 1) {
      const r = await raw("POST", path, {
        cookie: session.cookie,
        headers: { "x-csrf-token": session.csrf, "idempotency-key": key },
        body,
      });
      if (r.status !== 503 || attempt >= 5) return r;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  return { session, send };
}
export type Writer = Awaited<ReturnType<typeof writerFor>>;

/** The page: the session harness with the PRODUCTION leader, told (or not) that its server segments; its composition is verified. */
export async function pairPage(
  context: BrowserContext,
  maxChanges: number | null,
  existing?: Page,
): Promise<Page> {
  const page = existing ?? (await context.newPage());
  const query =
    maxChanges === null ? "" : `&segmented=capable&maxChanges=${maxChanges}`;
  await page.goto(`/__session?route=%2Ftoday&leader=production${query}`);
  await exposeSession(page);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  const pairing = await page.evaluate(
    () => window.__atlasFixture?.session?.pairing ?? null,
  );
  expect(pairing, "the page's diagnostic composition").toEqual(
    maxChanges === null
      ? null
      : { segmentedCapable: true, segmentedMaxChanges: maxChanges },
  );
  return page;
}

/** A password sign-in in the page (paced: the backend allows 10 per account per minute). */
export async function signInAs(page: Page, account: PairAccount) {
  await paceSignIn(account.username);
  const result = await page.evaluate(
    async (c) => {
      const begun = await window.__s.attempts.begin("password");
      if (begun.kind !== "started") return { kind: `begin:${begun.kind}` };
      return (await window.__s.attempts.signInWithPassword(
        begun.handle,
        c,
      )) as { kind: string };
    },
    { username: account.username, password: account.password },
  );
  expect(result.kind, "the password sign-in settles").toBe("settled");
}
export const nudge = (page: Page) =>
  page.evaluate(() => window.__atlasFixture?.session?.leaderNudge());
export const leaderOf = (page: Page) =>
  page.evaluate(() => window.__atlasFixture?.session?.leader() ?? null);

// ---- seeding through public routes ---------------------------------------------------------------------------------------------------
/** WEB-03's dense checklist (100 one-character items, 40 checked), fresh ids: the value every W-real and W-synthetic field carries. */
export const denseChecklist = () => {
  const items = Array.from({ length: 100 }, () => ({
    id: randomUUID(),
    label: "x",
  }));
  return {
    kind: "checklist",
    items,
    checked: items.slice(0, 40).map((i) => i.id),
  };
};

export interface SeededField {
  id: string;
  label: string;
  value: ReturnType<typeof denseChecklist>;
}
export interface Seeded {
  person: string;
  name: string;
  fields: SeededField[];
}
async function policyVersion(w: Writer, person: string): Promise<number> {
  const read = await raw("GET", `/people/${person}`, {
    cookie: w.session.cookie,
    headers: { "x-csrf-token": w.session.csrf },
  });
  expect(read.status, JSON.stringify(read.json)).toBe(200);
  return (read.json as { person: { policy_version: number } }).person
    .policy_version;
}
/** One public access command on `person` for `account` (grant read, or revoke); the answer is asserted. */
export async function access(
  w: Writer,
  kind: "grant" | "revoke",
  person: string,
  account: string,
) {
  const version = await policyVersion(w, person);
  const answer = await w.send("/access-commands", {
    commands: [
      {
        kind,
        id: person,
        expected_version: version,
        account_id: account,
        ...(kind === "grant" ? { edit: false } : {}),
      },
    ],
  });
  expect(answer.status, `${kind}: ${JSON.stringify(answer.json)}`).toBe(200);
}
/**
 * A person of the writer, granted to each of `readers`, holding `fields` dense checklist fields shared with them at creation (put_field,
 * one public command each). Every answer is asserted with the server's own body.
 */
export async function seedPerson(
  w: Writer,
  readers: string[],
  fields: number,
  name: string,
): Promise<Seeded> {
  const person = randomUUID();
  const created = await w.send("/commands", {
    commands: [
      {
        kind: "create_person",
        id: person,
        name,
        initial_policy: { grants: [], exclude_accounts: [] },
      },
    ],
  });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  for (const reader of readers) await access(w, "grant", person, reader);
  const out: SeededField[] = [];
  for (let i = 0; i < fields; i += 1) {
    const field = {
      id: randomUUID(),
      label: `Dense ${i}`,
      value: denseChecklist(),
    };
    const put = await w.send("/task-access-commands", {
      command: {
        kind: "put_field",
        id: field.id,
        parent_id: person,
        expected_version: null,
        label: field.label,
        value: field.value,
        initial_policy: {
          grants: readers.map((id) => ({ kind: "account", id, edit: false })),
          exclude_accounts: [],
        },
      },
    });
    expect(
      put.status,
      `put_field ${i + 1} of ${fields}: ${JSON.stringify(put.json)}`,
    ).toBe(200);
    out.push(field);
  }
  return { person, name, fields: out };
}
/** W-real (BE-Q23's pinned dense fixture, through public routes): a person + 199 dense fields, revoked so the reader sees none of it. */
export async function seedWReal(w: Writer, readers: string[]): Promise<Seeded> {
  const seeded = await seedPerson(w, readers, 199, "W-real");
  for (const reader of readers)
    await access(w, "revoke", seeded.person, reader);
  return seeded;
}
/** Sentinels: a visible person with two fields, unrelated to the workload, so an empty-cache shortcut cannot pass the oracle. */
export const seedSentinel = (w: Writer, reader: string) =>
  seedPerson(w, [reader], 2, "Sentinel");

/**
 * W-synthetic, LABELLED SYNTHETIC (the backend's pinned dense fixture, `insert_synthetic`): ONE stored batch naming the person and every
 * field, inserted DIRECTLY into the disposable database the runner created, as the next revision. The server then answers it like any batch
 * (re-resolved, re-authorised): 800 upserts of resources the reader already holds. Never a real writer's revision (real publication caps a
 * revision at 200 changes).
 */
export async function insertSyntheticBatch(
  reader: string,
  seeded: Seeded,
): Promise<void> {
  if (!DATABASE)
    throw new Error("no disposable database (ATLAS_PAIR_DATABASE)");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(DATABASE, { timeout: 30_000 } as never);
  try {
    const payload = JSON.stringify([
      { id: seeded.person, resource_kind: "person" },
      ...seeded.fields.map((f) => ({ id: f.id, resource_kind: "field" })),
    ]);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE sync_clock SET revision=revision+1 WHERE id=1").run();
    db.prepare(
      "INSERT INTO sync_batches(account_id,revision,payload,created_at) SELECT ?,revision,?,? FROM sync_clock WHERE id=1",
    ).run(reader, payload, Math.floor(Date.now() / 1000));
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

// ---- what the browser stores: raw IndexedDB, one read-only transaction ---------------------------------------------------------------
export interface CacheLike {
  id: string;
  kind: string;
  parent_id: string | null;
  label: string;
  value: unknown;
  version: number;
}
export interface Stored {
  cursor: string | null;
  phase: string | null;
  cache_status: string | null;
  applied_revision: number | null;
  page_seq: number | null;
  request_seq: number | null;
  composition_seq: number;
  delta_stage: {
    revision: number;
    next_index: number;
    boundary_cursor: string;
    cursor: string;
  } | null;
  staged: number;
  drafts: number;
  /** The live cache's identity: sorted id:version pairs, hashed in the page (never the values, so the read stays small). */
  cache_digest: string;
  cache_count: number;
  rows?: CacheLike[];
}
/**
 * The account database read with RAW IndexedDB in ONE read-only transaction (a connection opened without a version, closed at once): the
 * harness's Dexie reads may lag the engine's commit (WEB-09c revision 20). Null while the database does not exist (it is never created
 * here: `indexedDB.databases()` is asked first).
 */
export const stored = (
  page: Page,
  account: string,
  withRows = false,
): Promise<Stored | null> =>
  page.evaluate(
    async ({ name, rows }) => {
      const names = (await indexedDB.databases()).map((d) => d.name);
      if (!names.includes(name)) return null;
      return new Promise<Stored | null>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const wanted = ["sync_state", "cache", "delta_staging", "drafts"];
          if (!wanted.every((s) => db.objectStoreNames.contains(s))) {
            db.close();
            resolve(null);
            return;
          }
          const tx = db.transaction(wanted, "readonly");
          const sync = tx.objectStore("sync_state").get("singleton");
          const cache = tx.objectStore("cache").getAll();
          const staged = tx.objectStore("delta_staging").count();
          const drafts = tx.objectStore("drafts").count();
          tx.oncomplete = async () => {
            db.close();
            const row = (sync.result ?? {}) as Record<string, unknown>;
            const all = cache.result as Array<Record<string, unknown>>;
            const pairs = all
              .map((r) => `${String(r.id)}:${String(r.version)}`)
              .sort()
              .join("\n");
            const digest = Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(pairs),
                ),
              ),
            )
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
            resolve({
              cursor: (row.cursor as string | null) ?? null,
              phase: (row.phase as string | null) ?? null,
              cache_status: (row.cache_status as string | null) ?? null,
              applied_revision: (row.applied_revision as number | null) ?? null,
              page_seq: (row.page_seq as number | null) ?? null,
              request_seq: (row.request_seq as number | null) ?? null,
              composition_seq: (row.composition_seq as number | undefined) ?? 0,
              delta_stage: (row.delta_stage as Stored["delta_stage"]) ?? null,
              staged: staged.result,
              drafts: drafts.result,
              cache_digest: digest,
              cache_count: all.length,
              ...(rows
                ? {
                    rows: all.map((r) => ({
                      id: r.id as string,
                      kind: r.kind as string,
                      parent_id: (r.parent_id as string | null) ?? null,
                      label: r.label as string,
                      value: r.value,
                      version: r.version as number,
                    })),
                  }
                : {}),
            });
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { name: `atlas-${account}`, rows: withRows },
  );

/** Polls (from Node: an async page predicate would resolve at once) until `predicate` holds; throws with the last state. */
export async function until(
  read: () => Promise<Stored | null>,
  predicate: (s: Stored) => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<Stored> {
  const deadline = Date.now() + timeoutMs;
  let last: Stored | null = null;
  for (;;) {
    last = await read();
    if (last && predicate(last)) return last;
    if (Date.now() > deadline)
      throw new Error(
        `${what}: not reached in ${timeoutMs} ms; last ${JSON.stringify({ ...last, rows: undefined })}`,
      );
    await new Promise((r) => setTimeout(r, 25));
  }
}
/** The complete old state: a valid delta cache at the live edge, nothing staged, the engine idle. */
export async function untilComplete(
  page: Page,
  account: string,
  timeoutMs = 120_000,
): Promise<Stored> {
  return until(
    async () => {
      const s = await stored(page, account);
      if (!s) return null;
      const leader = (await leaderOf(page)) as {
        engine?: { kind?: string };
      } | null;
      return leader?.engine?.kind === "idle" ? s : null;
    },
    (s) =>
      s.phase === "delta" &&
      s.cache_status === "valid" &&
      s.cursor !== null &&
      s.delta_stage === null &&
      s.staged === 0,
    "the complete state at the live edge",
    timeoutMs,
  );
}

// ---- the independent content oracle --------------------------------------------------------------------------------------------------
/** JSON with object keys sorted at every level: the comparison of two values that differ only in member order (the server sorts them). */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );

/**
 * The final cache against what the writer wrote, never against the trace: the old rows unchanged (the sentinels and anything else the reader
 * held), plus exactly the workload's person and fields with their written labels and values (W-real), or the old rows exactly (W-synthetic,
 * whose batch re-sends what the reader holds), or the old rows exactly WITHOUT any of the workload (revoked).
 */
export function oracle(
  old: CacheLike[],
  final: CacheLike[],
  expect_: { add?: Seeded; absent?: Seeded; sentinel: Seeded },
): { verdict: "match" | "mismatch"; problems: string[] } {
  const problems: string[] = [];
  const byId = new Map(final.map((r) => [r.id, r]));
  const workload = new Set([
    ...(expect_.add
      ? [expect_.add.person, ...expect_.add.fields.map((f) => f.id)]
      : []),
    ...(expect_.absent
      ? [expect_.absent.person, ...expect_.absent.fields.map((f) => f.id)]
      : []),
  ]);
  for (const row of old) {
    if (workload.has(row.id)) continue;
    const now = byId.get(row.id);
    if (!now) problems.push(`old row ${row.id} is gone`);
    else if (canonical(now) !== canonical(row))
      problems.push(`old row ${row.id} changed`);
  }
  for (const id of [
    expect_.sentinel.person,
    ...expect_.sentinel.fields.map((f) => f.id),
  ])
    if (!byId.has(id)) problems.push(`sentinel ${id} missing`);
  if (expect_.add) {
    const person = byId.get(expect_.add.person);
    if (person?.kind !== "person")
      problems.push("the workload person is not in the cache as a person");
    for (const field of expect_.add.fields) {
      const row = byId.get(field.id);
      if (!row) problems.push(`field ${field.id} missing`);
      else {
        if (row.kind !== "field" || row.parent_id !== expect_.add.person)
          problems.push(`field ${field.id}: kind/parent`);
        if (row.label !== field.label)
          problems.push(`field ${field.id}: label ${row.label}`);
        if (canonical(row.value) !== canonical(field.value))
          problems.push(`field ${field.id}: value differs`);
        if (!(Number.isInteger(row.version) && row.version > 0))
          problems.push(`field ${field.id}: version ${row.version}`);
      }
    }
  }
  if (expect_.absent)
    for (const id of [
      expect_.absent.person,
      ...expect_.absent.fields.map((f) => f.id),
    ])
      if (byId.has(id)) problems.push(`revoked ${id} is still cached`);
  const allowed = new Set([...old.map((r) => r.id), ...workload]);
  for (const row of final)
    if (!allowed.has(row.id)) problems.push(`unexpected row ${row.id}`);
  if (
    expect_.absent &&
    final.length !== old.filter((r) => !workload.has(r.id)).length
  )
    problems.push("row count differs");
  return {
    verdict: problems.length === 0 ? "match" : "mismatch",
    problems: problems.slice(0, 20),
  };
}

// ---- the client's continuity rule, modelled independently of the client ---------------------------------------------------------------
/**
 * What the client must store after receiving `r` (BE-Q23 contract §4.3; W27/W1): a model kept by the spec from the tap's records, against
 * which the stored state is checked at every barrier. `restarted` counts broken chains (a gap, a repeat, another revision): the stage is
 * discarded and the cursor goes back to the boundary.
 */
export interface ChainModel {
  cursor: string;
  boundary: string | null;
  stage: { revision: number; next_index: number } | null;
  activated: number | null;
  restarted: number;
}
export function advance(model: ChainModel, r: TapRecord): ChainModel {
  const s = seen(r);
  if (s.status !== 200) return model;
  const segment = s.segment;
  if (!segment) {
    if (model.stage)
      return {
        ...model,
        stage: null,
        cursor: model.boundary ?? model.cursor,
        boundary: null,
        restarted: model.restarted + 1,
      };
    return {
      ...model,
      cursor: s.next_cursor ?? model.cursor,
      activated: s.last_revision,
    };
  }
  const broken =
    model.stage === null
      ? segment.index !== 0
      : s.revision !== model.stage.revision ||
        segment.index !== model.stage.next_index ||
        (!segment.last && s.has_more !== true);
  if (broken) {
    if (model.stage === null)
      return { ...model, restarted: model.restarted + 1 };
    return {
      ...model,
      stage: null,
      cursor: model.boundary ?? model.cursor,
      boundary: null,
      restarted: model.restarted + 1,
    };
  }
  if (segment.last)
    return {
      ...model,
      stage: null,
      boundary: null,
      cursor: s.next_cursor ?? model.cursor,
      activated: s.revision,
    };
  return {
    ...model,
    boundary: model.stage === null ? model.cursor : model.boundary,
    stage: { revision: s.revision as number, next_index: segment.index + 1 },
    cursor: s.next_cursor ?? model.cursor,
  };
}

// ---- the interval -------------------------------------------------------------------------------------------------------------------
export interface Barrier {
  name: string;
  at: number;
  detail?: unknown;
}
export interface Interval {
  id: string;
  caseId: string;
  engine: string;
  since: number;
  barriers: Barrier[];
  piecesPersisted: number;
  heap: {
    stop(): Promise<number[]>;
    kind: string | null;
    reason: string | null;
  };
}
async function heapSampler(
  page: Page,
  engine: string,
): Promise<Interval["heap"]> {
  if (engine !== "chromium")
    return {
      kind: null,
      reason: `${engine}: no supported per-page heap counter here; native IndexedDB transaction memory is unmeasured in every engine`,
      stop: async () => [],
    };
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  const samples: number[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const { metrics } = await client.send("Performance.getMetrics");
        const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value;
        if (typeof used === "number" && used > 0) samples.push(used);
      } catch {
        // the page may be navigating: the gap is visible as fewer samples
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
  return {
    kind: "chromium_cdp_js_heap_used",
    reason: null,
    stop: async () => {
      running = false;
      await loop;
      return samples;
    },
  };
}
/** Begins the interval: the tap labels every later exchange with it; memory sampling starts (Chromium only). */
export async function beginInterval(
  page: Page,
  caseId: string,
  engine: string,
): Promise<Interval> {
  const id = `${caseId}:${engine}:${randomUUID()}`;
  const { seq } = await tap.label(id);
  return {
    id,
    caseId,
    engine,
    since: seq,
    barriers: [],
    piecesPersisted: 0,
    heap: await heapSampler(page, engine),
  };
}
export const barrier = (iv: Interval, name: string, detail?: unknown) => {
  iv.barriers.push({
    name,
    at: Date.now(),
    ...(detail === undefined ? {} : { detail }),
  });
};

/** Counts per response: changes, and how many are the workload person repeated as an ancestor (ancestor overhead). */
export function overheadOf(records: TapRecord[], person: string) {
  return syncRecords(records)
    .filter((r) => r.status === 200 && r.body_file)
    .map((r) => {
      const page = JSON.parse(
        bodyOf(r.body_file as string).toString("utf8"),
      ) as {
        batches: Array<{
          changes: Array<{
            kind: string;
            id?: string;
            resource?: { id: string };
          }>;
        }>;
      };
      const changes = page.batches.flatMap((b) => b.changes);
      return {
        seq: r.seq,
        bytes: r.bytes,
        changes: changes.length,
        person_upserts: changes.filter(
          (c) => c.kind === "upsert" && c.resource?.id === person,
        ).length,
        removals: changes.filter((c) => c.kind === "remove").length,
        server_ms:
          r.t_upstream_end === null
            ? null
            : Math.round((r.t_upstream_end - r.t_request) * 1000) / 1000,
      };
    });
}

/**
 * Ends the interval: the tap's exchanges of this interval, the kernel trace's commit lines inside it, memory, the oracle; the record is
 * written and VALIDATED (pair-evidence.mjs) before the caller asserts anything else. Returns the record.
 */
export async function endInterval(
  page: Page,
  iv: Interval,
  details: {
    backend: string;
    workload: "W-real" | "W-synthetic";
    preGrantCursor: string;
    terminal: "activated" | "recovered";
    oracle: { verdict: "match" | "mismatch"; problems: string[] };
    barriered: boolean;
    person: string;
    injectedOutsideTap?: string;
    extra?: Record<string, unknown>;
  },
) {
  const samples = await iv.heap.stop();
  await tap.flush();
  const records = (await tap.log(iv.since)).filter((r) => r.label === iv.id);
  const trace = (
    (await page
      .evaluate(() => window.__atlasFixture?.session?.trace ?? [])
      .catch(() => [])) as Array<{
      at: number;
      event: string;
      data?: Record<string, unknown>;
    }>
  ).filter(
    (e) =>
      (e.event === "data.sync_commit" ||
        e.event === "data.recovery_commit" ||
        e.event === "request.issued") &&
      e.at >= (iv.barriers[0]?.at ?? 0),
  );
  const syncs = syncRecords(records);
  const record = {
    schema: SCHEMA,
    interval: iv.id,
    case: iv.caseId,
    engine: iv.engine,
    backend: details.backend,
    selection_manifest_sha256: SELECTION_SHA256 || null,
    api_version: API_VERSION,
    workload: details.workload,
    synthetic: details.workload === "W-synthetic",
    pre_grant_cursor: details.preGrantCursor,
    requests: syncs,
    other_requests: records
      .filter((r) => !syncs.includes(r))
      .map((r) => ({
        seq: r.seq,
        method: r.method,
        path: r.path,
        status: r.status,
      })),
    unaltered:
      syncs.every((r) => !r.delivered && !r.dropped) &&
      details.injectedOutsideTap === undefined,
    ...(details.injectedOutsideTap
      ? { injected_outside_tap: details.injectedOutsideTap }
      : {}),
    barriers: iv.barriers,
    barriered: details.barriered,
    pieces_persisted: iv.piecesPersisted,
    terminal: { kind: details.terminal },
    oracle: details.oracle,
    overhead: overheadOf(records, details.person),
    totals: {
      requests: syncs.length,
      bytes: syncs.reduce((n, r) => n + (r.bytes ?? 0), 0),
      max_bytes: Math.max(0, ...syncs.map((r) => r.bytes ?? 0)),
      wall_ms_grant_to_activation:
        (iv.barriers.find((b) => b.name === "activation_complete")?.at ??
          Number.NaN) -
        (iv.barriers.find((b) => b.name === "grant_complete")?.at ??
          Number.NaN),
      wall_resolution:
        "Node polling of raw IndexedDB every 25 ms (an upper bound on the moment, not the commit's own time)",
    },
    browser_trace: trace,
    memory:
      iv.heap.kind === null
        ? { kind: null, reason: iv.heap.reason }
        : samples.length === 0
          ? {
              kind: null,
              reason:
                "chromium: no heap sample was obtained during the interval",
            }
          : {
              kind: iv.heap.kind,
              scope:
                "whole-page JS heap, sampled every 25 ms: not native IndexedDB transaction memory, not per-segment, not process RSS",
              samples,
              min: Math.min(...samples),
              max: Math.max(...samples),
            },
    ...(details.extra ? { extra: details.extra } : {}),
  };
  if (EVIDENCE) {
    mkdirSync(join(EVIDENCE, "intervals"), { recursive: true });
    writeFileSync(
      join(EVIDENCE, "intervals", `${iv.caseId}.${iv.engine}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }
  await tap.label(null);
  expect(
    validateInterval(record, { readBody: bodyOf }),
    "the interval record is valid evidence",
  ).toEqual([]);
  return record;
}
export const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

// ---- the per-piece barrier driver ---------------------------------------------------------------------------------------------------
export interface HeldStep {
  record: TapRecord;
  model: ChainModel;
  before: Stored;
  index: number;
  /** Releases the held answer NOW (a hook that navigates the page away first, so the answer reaches nobody). */
  release(): Promise<void>;
}
export interface HookAnswer {
  /** false: the held answer must not reach the client (the hook reloaded or closed the page); it is released to nobody. */
  delivered?: boolean;
  /** Stop driving: the case continues by itself (a 410 recovery, a replaced page). */
  stop?: boolean;
}
/**
 * Holds EVERY `/sync` answer at the delaying proxy (`hold`: the backend has answered; the tap has recorded the exact body) and, at each one:
 * reads the stored state in one transaction; checks it against the chain model (the client asks from the cursor it stored; a piece it
 * received is persisted as the stage's next index; a broken chain restarted at the boundary) and against the old live state (nothing of the
 * revision is visible before the final piece is released); then lets the case act (`onHeld`) and releases it. After the final piece it
 * waits for the activation (applied revision, no stage, nothing staged) and records the barriers.
 */
export async function drivePieces(options: {
  page: () => Page;
  account: string;
  iv: Interval;
  old: Stored;
  model: ChainModel;
  /** Runs once the hold is in force and before the engine is nudged: the grant (or the synthetic batch), and any fault to arm. */
  start: () => Promise<void>;
  onHeld?: (step: HeldStep) => Promise<HookAnswer | undefined>;
  maxSteps?: number;
}): Promise<{
  model: ChainModel;
  steps: TapRecord[];
  final: Stored | null;
  stoppedAt: TapRecord | null;
}> {
  const { account, iv, old } = options;
  let model = options.model;
  const rule = await proxy.addRule({
    method: "GET",
    path: SYNC,
    action: "hold",
  });
  const ruleId = rule.id;
  const steps: TapRecord[] = [];
  let lastSeq = iv.since;
  let finalised = false;
  try {
    await options.start();
    barrier(iv, "grant_complete");
    await nudge(options.page());
    for (let index = 0; index < (options.maxSteps ?? 600); index += 1) {
      // The next held answer, and the tap's record of it (the newest completed /sync exchange after the last one handled).
      let record: TapRecord | undefined;
      const deadline = Date.now() + 90_000;
      for (;;) {
        const held = (await proxy.held())[ruleId] ?? 0;
        if (held > 0) {
          const fresh = syncRecords(await tap.log(lastSeq)).filter(
            (r) => r.label === iv.id && r.status !== null && !r.dropped,
          );
          record = fresh.at(-1);
          if (record) break;
        }
        if (Date.now() > deadline)
          throw new Error(
            `no /sync answer was held within 90 s (after step ${index})`,
          );
        await new Promise((r) => setTimeout(r, 25));
      }
      lastSeq = record.seq;
      steps.push(record);
      const before = (await stored(options.page(), account)) as Stored;
      // The client asks from the cursor it stored, and has stored what the model says.
      expect(
        record.query?.cursor ?? null,
        `step ${index}: the request carries the stored cursor`,
      ).toBe(model.cursor);
      expect(before.cursor, `step ${index}: stored cursor`).toBe(model.cursor);
      expect(
        before.delta_stage?.next_index ?? null,
        `step ${index}: stored stage`,
      ).toBe(model.stage?.next_index ?? null);
      if (model.stage && index > 0) {
        iv.piecesPersisted += 1;
        barrier(iv, "piece_persisted", {
          next_index: model.stage.next_index,
          seq: record.seq,
        });
      }
      // Nothing of the revision is visible before its final piece is released (I3): the live cache and its bookkeeping are the old ones.
      if (model.activated === null) {
        expect(before.cache_digest, `step ${index}: live cache unchanged`).toBe(
          old.cache_digest,
        );
        expect(
          before.applied_revision,
          `step ${index}: applied revision unchanged`,
        ).toBe(old.applied_revision);
        expect(
          before.page_seq,
          `step ${index}: page_seq unchanged (W27 does not advance it)`,
        ).toBe(old.page_seq);
        expect(
          before.composition_seq,
          `step ${index}: composition unchanged (W27 does not advance it)`,
        ).toBe(old.composition_seq);
      }
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await proxy.release(ruleId);
      };
      const answer =
        (await options.onHeld?.({ record, model, before, index, release })) ??
        {};
      const final =
        seen(record).status === 200 && seen(record).has_more === false;
      if (final && answer.delivered !== false)
        barrier(iv, "final_released", { seq: record.seq });
      await release();
      if (answer.delivered !== false) model = advance(model, record);
      if (answer.stop) return { model, steps, final: null, stoppedAt: record };
      if (final && answer.delivered !== false) {
        finalised = true;
        break;
      }
    }
    if (!finalised)
      throw new Error("the revision did not finish within the step bound");
    await proxy.removeRule(ruleId);
    await proxy.release(ruleId);
    const done = await until(
      () => stored(options.page(), account, true),
      (s) =>
        s.applied_revision === model.activated &&
        s.delta_stage === null &&
        s.staged === 0,
      "the activation",
    );
    barrier(iv, "activation_complete", {
      applied_revision: done.applied_revision,
    });
    return { model, steps, final: done, stoppedAt: null };
  } finally {
    await proxy.removeRule(ruleId).catch(() => undefined);
    await proxy.release(ruleId).catch(() => undefined);
  }
}

/** The common opening: the complete old state, the interval begun, the pre-grant cursor read. */
export async function preGrant(
  page: Page,
  account: string,
  caseId: string,
  engine: string,
) {
  const old = await untilComplete(page, account);
  const oldRows = (await stored(page, account, true))?.rows ?? [];
  const iv = await beginInterval(page, caseId, engine);
  // Read AFTER the label is in force: an empty live-edge poll keeps the cursor (the server reuses it), so this is the interval's start.
  const at = (await stored(page, account)) as Stored;
  expect(
    at.cursor,
    "no request moved the cursor while the interval began",
  ).toBe(old.cursor);
  barrier(iv, "pre_grant_complete", {
    cursor_sha256: sha256(String(at.cursor)),
    cache_count: at.cache_count,
  });
  return {
    old: at,
    oldRows,
    iv,
    model: {
      cursor: at.cursor as string,
      boundary: null,
      stage: null,
      activated: null,
      restarted: 0,
    },
  };
}
