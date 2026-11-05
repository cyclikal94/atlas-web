import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import {
  controlCall as bridgeCall,
  type ContinuationHeader,
  continuationOf,
} from "../../scripts/integration/diagnostic-fixture.mjs";
import {
  type Attempt,
  createLedger,
  outcomeOf,
  type Persisted,
  seenOf,
} from "../../scripts/integration/pair-attempts.mjs";
import { recoverySample } from "../../scripts/integration/pair-capture.mjs";
import {
  type ChainModel,
  type Driven,
  type HeldStep as DriverStep,
  drive,
  type HeldSelection,
  type HookAnswer,
  type Milestone,
  openHold,
} from "../../scripts/integration/pair-driver.mjs";
import {
  assembleInterval,
  joinExchanges,
  validateInterval,
} from "../../scripts/integration/pair-evidence.mjs";
import {
  CASES,
  designedSkipReason,
} from "../../scripts/integration/pair-matrix.mjs";
import {
  observeRecovery,
  type RecoveryReader,
} from "../../scripts/integration/pair-recovery.mjs";
import {
  DIAGNOSTIC_SELECTION,
  selectionIdentity,
} from "../../scripts/integration/pair-selection.mjs";
import {
  BACKEND,
  challengeFor,
  expect,
  exposeSession,
  freshVerifier,
  ORIGIN,
  type ProxyLogEntry,
  paceSignIn,
  proxy,
  raw,
  test,
} from "../integration/helpers";
import { renderingOf } from "./rendering";
import { type CacheLike, type LocalWork, type Stored, stored } from "./stored";

/**
 * WEB-09c (R23-PAIR): the support of the development-pair journey (pair.development.spec.ts). Everything here talks to the REAL backend the
 * runner (scripts/integration/run-development-pair.mjs) started, through public routes, except where a name says otherwise:
 *   - `insertSyntheticBatch` writes ONE notice row into the disposable SQLite database (W-synthetic, labelled synthetic, as the backend's
 *     pinned dense fixture does);
 *   - `tap.fault` arms a one-shot, labelled alteration of ONE answer in the tap (scripts/integration/pair-tap.mjs); `tap.gate` holds the
 *     browser's /sync requests at the tap, unforwarded, while a case prepares a fault (revision 25: B1-B3);
 *   - the delaying proxy's rules hold, drop or replace answers (tests/integration/helpers.ts `proxy`); the pair runner gives the proxy and
 *     the tap one correlation header, so each tap exchange is joined to the proxy log entry that carried it and its DOWNSTREAM outcome
 *     (scripts/integration/pair-attempts.mjs: the tap sits upstream of the hold and never sees the browser's connection).
 * The browser runs the PRODUCTION composition (the session harness page with `?leader=production`: the election, the engine, the recovery job,
 * production quota, session persistence) and is told only that its server segments (`?segmented=capable`), a DIAGNOSTIC boot option.
 *
 * Revision 25 (R24-PAIR.c, DA-PAIR-S/E): the common driver, its opening and the record's assembly live in scripts/integration (pair-driver.mjs,
 * pair-evidence.mjs), qualified there; this file supplies their browser IO. The hold belongs to the interval from its opening (armed before
 * the label, every earlier /sync settled) to its end or an explicit hand-off; the workload is the writer's receipt revision.
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
  /** The tap's write to the PROXY (not the browser: the hold is downstream of the tap). */
  t_delivered: number | null;
  /** The PROXY had gone when the tap answered (never the browser's connection). */
  client_gone?: boolean;
  /** The proxy log entry this exchange came through (the correlation header, stripped before the backend). */
  proxy_id?: number | null;
  upstream_error?: string;
  /** Joined at the end of the interval: the proxy's downstream outcome of this exchange. */
  downstream?: { outcome: string; events: string[] | null };
  /** Joined at the end of the interval: the driver's attempt (received, lost, dropped) and what it did. */
  attempt?: {
    step: number | null;
    client: string | null;
    effect: string | null;
  };
  /** The tap destroyed the connection instead of answering (the server HAS answered): the client received nothing. */
  dropped?: string;
  /** The request waited at the tap's closed gate (revision 25), forwarded at `t_gate_open`. */
  gated?: boolean;
  t_gate_open?: number;
  /**
   * Revision 27: the attempt's causal-journal positions of this exchange (diagnostic runs only). Revision 33 (R33-DIAG): the interval
   * keeps them for EVERY exchange — a sync record whole, a non-sync one in its compact `other_requests` projection (pair-evidence.mjs
   * `CAUSAL_FIELDS`), copied when present and never invented — because the proof reader binds every exchange's arrival.
   */
  j_request?: number;
  j_gate_open?: number;
  j_upstream_end?: number;
  j_delivered?: number;
  delivered?: {
    injected: string;
    status: number;
    bytes: number;
    sha256: string;
    body_file: string;
    batches: number | null;
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
interface TapLog {
  dropped: number;
  dropped_through: number;
  seq: number;
  pending_writes: number;
  write_errors: Array<{ file: string; error: string }>;
  records: TapRecord[];
}
export const tap = {
  label: (label: string | null) =>
    tapCall<{ label: string | null; seq: number }>("POST", "/label", { label }),
  log: async (since = 0) =>
    (await tapCall<TapLog>("GET", `/log?since=${since}`)).records,
  /** The whole answer: records, truncation (`dropped_through`) and body write errors. */
  logFull: (since = 0) => tapCall<TapLog>("GET", `/log?since=${since}`),
  fault: (spec: Omit<TapFault, "id" | "fired">) =>
    tapCall<TapFault>("POST", "/fault", spec),
  /** The request-side gate: closed, every later /sync request waits at the tap, unforwarded; opened, they are forwarded in order. */
  gate: (closed: boolean) =>
    tapCall<{ closed: boolean; forwarded: number[] }>("POST", "/gate", {
      closed,
    }),
  faults: () => tapCall<TapFault[]>("GET", "/faults"),
  flush: () =>
    tapCall<{
      flushed: boolean;
      pending_writes: number;
      write_errors: Array<{ file: string; error: string }>;
    }>("POST", "/flush"),
  reset: () =>
    tapCall<{
      unfired: string[];
      seq: number;
      write_errors: Array<{ file: string; error: string }>;
    }>("POST", "/reset"),
};

/** The proxy's per-entry hold controls (delaying-proxy.mjs): which log entries a rule holds, and the release of ONE, with its outcome. */
const CONTROL = process.env.ATLAS_INTEGRATION_CONTROL ?? "";
async function controlCall<T>(method: string, path: string): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, { method });
  if (!response.ok)
    throw new Error(`proxy ${method} ${path}: ${response.status}`);
  return (await response.json()) as T;
}
export const holds = {
  entries: () =>
    controlCall<Record<string, number[]>>("GET", "/held?entries=1"),
  releaseOne: (rule: string, entry: number) =>
    controlCall<{
      released: number;
      outcomes: Array<{ id: number; outcome: string | null }>;
    }>("POST", `/release/${rule}?entry=${entry}`),
};
export const bodyOf = (file: string): Buffer =>
  readFileSync(join(BODIES, file));
export const syncRecords = (records: TapRecord[]) =>
  records.filter((r) => r.method === "GET" && r.path.endsWith("/sync"));
/** What the CLIENT was answered (if it received it): the injected answer when one was, else the server's (pair-attempts.mjs). */
export const seen = (r: TapRecord) => seenOf(r);

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

/**
 * R38-DIAG: the compatibility policy every development-pair document names. Against the approved DIAGNOSTIC executable it is the verified
 * selection's identity and its ONE API version (pair-selection.mjs `DIAGNOSTIC_SELECTION`), which the runner's health check, its environment
 * and the executable's own ready receipt must all report; any disagreement fails the set-up here, before a page boots. Null on every other
 * backend: the released pin's range, as production (the normal-development pairing's selection is not decided here).
 */
export function pairCompatibility(): {
  selection: string;
  apiVersion: string;
} | null {
  if (PAIR_BACKEND !== "diagnostic") return null;
  const apiVersion = DIAGNOSTIC_SELECTION.backend.apiVersion;
  const problems: string[] = [];
  if (!/^[0-9a-f]{64}$/.test(SELECTION_SHA256))
    problems.push(`selection identity ${JSON.stringify(SELECTION_SHA256)}`);
  if (SELECTION_SHA256 !== selectionIdentity())
    problems.push("the runner's selection is not the approved diagnostic one");
  if (API_VERSION !== apiVersion)
    problems.push(
      `the runner's health reported ${API_VERSION}, selected ${apiVersion}`,
    );
  if (DIAGNOSTIC_RECEIPT?.api_version !== apiVersion)
    problems.push(
      `the executable's receipt reports ${DIAGNOSTIC_RECEIPT?.api_version}, selected ${apiVersion}`,
    );
  if (problems.length > 0)
    throw new Error(
      `the diagnostic compatibility policy cannot be named: ${problems.join("; ")}`,
    );
  return { selection: SELECTION_SHA256, apiVersion };
}
/** `>=X.Y.0 <X.(Y+1).0` of a pin, and `>=X.Y.Z <X.Y.(Z+1)` of one version, computed here independently of the product's own functions. */
const releasedRangeOf = (pin: string) => {
  const [major, minor] = (pin.split(/[-+]/)[0] ?? "").split(".").map(Number);
  return `>=${major}.${minor}.0 <${major}.${Number(minor) + 1}.0`;
};
const exactRangeOf = (version: string) => {
  const [major, minor, patch] = version.split(".").map(Number);
  return `>=${version} <${major}.${minor}.${Number(patch) + 1}`;
};
/** The page's own compatibility verdict (the session's store the dispatcher reads), once its real `/health` has been judged. */
export async function compatOf(
  page: Page,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const verdict = (await page.evaluate(
      () => window.__atlasFixture?.session?.compat() ?? null,
    )) as Record<string, unknown> | null;
    if (
      (verdict !== null && verdict.status !== "unknown") ||
      Date.now() > deadline
    )
      return verdict;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
/** The production leader's outbox dispatcher state on this page (null when it does not lead). */
export const outboxOf = (page: Page) =>
  page.evaluate(
    () => window.__atlasFixture?.session?.outboxState() ?? null,
  ) as Promise<Record<string, unknown> | null>;

/**
 * The page: the session harness with the PRODUCTION leader, told (or not) that its server segments; its composition is verified. Against the
 * diagnostic executable every document also names the selection's compatibility policy (R38-DIAG), in its own address, so a reload, a
 * follower and a page taking the leadership each establish it before they boot; the page's recorded policy and its own verdict from the real
 * `/health` are asserted (and annotated) before the page is used. `policy: "omit"` is the NEGATIVE control only: the released range, which
 * must judge the diagnostic version unsupported.
 */
export async function pairPage(
  context: BrowserContext,
  maxChanges: number | null,
  existing?: Page,
  options: { policy?: "selected" | "omit" } = {},
): Promise<Page> {
  const page = existing ?? (await context.newPage());
  const query =
    maxChanges === null ? "" : `&segmented=capable&maxChanges=${maxChanges}`;
  const policy = options.policy === "omit" ? null : pairCompatibility();
  const named =
    policy === null
      ? ""
      : `&pairApi=${encodeURIComponent(policy.apiVersion)}&pairSelection=${policy.selection}`;
  await page.goto(
    `/__session?route=%2Ftoday&leader=production${query}${named}`,
  );
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
  const compatibility = await page.evaluate(
    () => window.__atlasFixture?.session?.compatibility ?? null,
  );
  expect(compatibility, "the page's compatibility policy").toEqual(
    policy === null
      ? null
      : {
          selection: policy.selection,
          apiVersion: policy.apiVersion,
          released: releasedRangeOf(RELEASED_VERSION),
          effective: exactRangeOf(policy.apiVersion),
        },
  );
  if (PAIR_BACKEND === "diagnostic") {
    const observed = await compatOf(page);
    test.info().annotations.push({
      type: "pair-compatibility",
      description: JSON.stringify({ policy: compatibility, observed }),
    });
    expect(
      observed,
      "the page's own verdict from the real /health under its policy",
    ).toEqual(
      policy === null
        ? {
            status: "unsupported",
            version: API_VERSION,
            supported: releasedRangeOf(RELEASED_VERSION),
          }
        : { status: "supported", version: policy.apiVersion },
    );
  }
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
/**
 * One public access command on `person` for `account` (grant read, or revoke); the answer is asserted. Returns its RECEIPT's revision
 * (`Receipt {revision}`: the one revision the command published, which the reader's batch carries): the workload's identity (revision 25).
 */
export async function access(
  w: Writer,
  kind: "grant" | "revoke",
  person: string,
  account: string,
): Promise<Milestone> {
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
  const revision = (answer.json as { revision?: unknown }).revision;
  expect(
    Number.isInteger(revision),
    `${kind}: the receipt names its revision`,
  ).toBe(true);
  return {
    revision: revision as number,
    source: `the public ${kind} receipt (POST /access-commands)`,
  };
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
): Promise<Milestone> {
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
    // The revision the batch was inserted at, read in the SAME transaction (never inferred later from a maximum or the browser).
    const { revision } = db
      .prepare("SELECT revision FROM sync_clock WHERE id=1")
      .get() as { revision: number };
    db.exec("COMMIT");
    return {
      revision,
      source:
        "LABELLED SYNTHETIC: the sync_batches row inserted into the disposable database",
    };
  } finally {
    db.close();
  }
}

// ---- what the browser stores: raw IndexedDB, one read-only transaction (tests/pair/stored.ts, revision 30) ------------------------------
export { type CacheLike, type LocalWork, type Stored, stored } from "./stored";

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
const isComplete = (s: Stored) =>
  s.phase === "delta" &&
  s.cache_status === "valid" &&
  s.cursor !== null &&
  s.delta_stage === null &&
  s.staged === 0;
/** The engine idle (one read), else null. */
async function idleState(page: Page, account: string) {
  const s = await stored(page, account);
  if (!s) return null;
  const leader = (await leaderOf(page)) as {
    engine?: { kind?: string };
  } | null;
  return leader?.engine?.kind === "idle" ? s : null;
}
/** The complete old state: a valid delta cache at the live edge, nothing staged, the engine idle. */
export async function untilComplete(
  page: Page,
  account: string,
  timeoutMs = 120_000,
): Promise<Stored> {
  return until(
    () => idleState(page, account),
    isComplete,
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

// ---- the client's continuity rule, modelled independently of the client: scripts/integration/pair-driver.mjs (`advance`) -----------------
export type { ChainModel, HookAnswer, Milestone };

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
  /** The tap's sequence number when the opening labelled it: the window's start (none until the opening is quiet). */
  since: number;
  barriers: Barrier[];
  piecesPersisted: number;
  heap: {
    stop(): Promise<number[]>;
    kind: string | null;
    reason: string | null;
  };
  /** Every driven attempt (received, lost, dropped) and the persistence events they earned (pair-attempts.mjs). */
  attempts: Attempt[];
  persisted: Persisted[];
  /** The workload: its revisions, each with its source (pair-driver.mjs). */
  target: Driven<TapRecord, Stored>["goal"] & {
    sources: Milestone[];
  };
  /** The driver's terminal references (absent for an interval it did not drive to its end). */
  terminal: { final_seq: number; activated_by_seq: number } | null;
  /** Where a partly driven case handed over (a 410 recovery, a replaced session). */
  handOff: { at_seq: number; reason: string } | null;
  /** The opening (pair-driver.mjs `openHold`): its label, its rounds and what it released before the label. */
  opening: {
    label_seq: number;
    rounds: number;
    released: Array<{
      round: number;
      proxy_id: number;
      outcome: string | null;
    }>;
  } | null;
  /** The hold the opening armed: owned by the interval until its end or a hand-off; every answer released without the driver is kept. */
  hold: { ruleId: string; closed: boolean } | null;
  holdReleases: Array<{
    proxy_id: number;
    outcome: string | null;
    reason: string;
  }>;
  /** Named observations a case makes (T1's follower; X0/X2's reader at the held 410, with its stage), bound by the record's validator. */
  observations: Array<{
    kind: string;
    at_seq: number;
    cache_digest: string;
    stage?: { revision: number; next_index: number } | null;
    detail?: Record<string, unknown>;
  }>;
  /** Revision 27: the recovery caller's hold, armed again before the grant (`rearmed_prefix`): the tap's last sequence number then. */
  rearm?: { at_seq: number; reason: string; released_rule: string };
  /** Revision 28: the account the recovery observer observes (the interval record's `reader_account`). */
  readerAccount?: string;
  /** Revision 30 (C3): the recovery observer's FIRST failure (its reason and the failing capture's facts), kept in the incomplete record. */
  observationFailure?: { reason: string; capture: unknown };
  /** Each page lifetime's trace, taken BEFORE a reload or close and at the end, so no observation depends on the surviving page. */
  traces: Array<{
    lifetime: number;
    reason: string;
    entries: TraceLine[];
  }>;
}
interface TraceLine {
  at: number;
  event: string;
  data?: Record<string, unknown>;
}
/** The intervals begun and not yet ended: kept as INCOMPLETE records when a case fails (`abandonOpenIntervals`). */
const open = new Set<Interval>();
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/**
 * Begins the interval: memory sampling starts (Chromium only), then the OPENING (pair-driver.mjs `openHold`) arms the hold, settles every
 * /sync admitted before it, releases what it held before the label, and labels the tap once the page is idle at its complete state.
 */
export async function beginInterval(
  page: Page,
  account: string,
  caseId: string,
  engine: string,
): Promise<Interval> {
  const id = `${caseId}:${engine}:${randomUUID()}`;
  const iv: Interval = {
    id,
    caseId,
    engine,
    since: Number.NaN,
    barriers: [],
    piecesPersisted: 0,
    heap: await heapSampler(page, engine),
    attempts: [],
    persisted: [],
    target: { revisions: [], through: null, sources: [] },
    terminal: null,
    handOff: null,
    opening: null,
    hold: null,
    holdReleases: [],
    observations: [],
    traces: [],
  };
  open.add(iv);
  const opening = await openHold(
    {
      addRule: async () => {
        const rule = await proxy.addRule({
          method: "GET",
          path: SYNC,
          action: "hold",
        });
        iv.hold = { ruleId: rule.id, closed: false };
        return rule;
      },
      proxyLog: () => proxy.log(),
      held: async (rule) => (await holds.entries())[rule] ?? [],
      releaseOne: (rule, entry) => holds.releaseOne(rule, entry),
      label: async (label) => (await tap.label(label)).seq,
      tapRecords: () => tap.log(0),
      quietNow: async () => {
        const s = await idleState(page, account);
        return s && isComplete(s) ? s : null;
      },
      now: () => Date.now(),
      sleep,
    },
    { label: id },
  );
  iv.since = opening.since;
  iv.opening = {
    label_seq: opening.since,
    rounds: opening.rounds,
    released: opening.released,
  };
  return iv;
}
export const barrier = (iv: Interval, name: string, detail?: unknown) => {
  iv.barriers.push({
    name,
    at: Date.now(),
    ...(detail === undefined ? {} : { detail }),
  });
};
/** A named observation of the case (T1's follower read through its own connection), at the exchange it was made at. */
export const observe = (
  iv: Interval,
  kind: string,
  atSeq: number,
  cacheDigest: string,
  stage?: { revision: number; next_index: number } | null,
  detail?: Record<string, unknown>,
) => {
  iv.observations.push({
    kind,
    at_seq: atSeq,
    cache_digest: cacheDigest,
    ...(stage === undefined ? {} : { stage }),
    ...(detail === undefined ? {} : { detail }),
  });
};
/**
 * Ends the interval's hold (an explicit hand-off, or the end of the interval): the rule is removed, so no later answer is held, and every
 * answer it still held is released, each KEPT with its outcome and the reason (never an attempt the driver made, never silently).
 */
export async function releaseHold(iv: Interval, reason: string) {
  if (!iv.hold || iv.hold.closed) return;
  const { ruleId } = iv.hold;
  iv.hold.closed = true;
  await proxy.removeRule(ruleId);
  for (const entry of (await holds.entries())[ruleId] ?? []) {
    const released = await holds.releaseOne(ruleId, entry);
    iv.holdReleases.push({
      proxy_id: entry,
      outcome: released.outcomes[0]?.outcome ?? null,
      reason,
    });
  }
}
/** Keeps the page's kernel trace lines of this interval, before the page is reloaded or closed (and at the end). */
export async function captureTrace(page: Page, iv: Interval, reason: string) {
  const entries = (
    (await page
      .evaluate(() => window.__atlasFixture?.session?.trace ?? [])
      .catch(() => [])) as TraceLine[]
  ).filter(
    (e) =>
      (e.event === "data.sync_commit" ||
        e.event === "data.recovery_commit" ||
        e.event === "request.issued") &&
      e.at >= (iv.barriers[0]?.at ?? 0),
  );
  iv.traces.push({ lifetime: iv.traces.length, reason, entries });
}

/**
 * The interval's complete collection: labelling ends (the tap's sequence number then is the window's end), the hold is released (every
 * answer it still held kept as a release), every exchange of the window is waited for until the tap and the proxy both settled it
 * (bounded; what is still open is recorded, and refuses the record), the body writes are flushed, and each exchange is joined to its proxy
 * log entry's downstream outcome and the driver's attempt (pair-evidence.mjs `joinExchanges`).
 */
async function collect(iv: Interval) {
  const { seq: until } = await tap.label(null);
  await releaseHold(iv, "the end of the interval");
  const deadline = Date.now() + 30_000;
  let log = await tap.logFull(iv.since);
  let entries: ProxyLogEntry[] = [];
  let unsettled: number[] = [];
  for (;;) {
    log = await tap.logFull(iv.since);
    entries = await proxy.log();
    const byProxy = new Map(entries.map((e) => [e.id, e]));
    unsettled = log.records
      .filter(
        (r) =>
          r.seq <= until &&
          ((r.status === null && !r.upstream_error) ||
            outcomeOf(byProxy.get(r.proxy_id as number)) === "pending"),
      )
      .map((r) => r.seq);
    if (unsettled.length === 0 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const flushed = await tap.flush();
  log = await tap.logFull(iv.since);
  const records = joinExchanges(
    log.records.filter((r) => r.seq <= until && r.label === iv.id),
    entries,
    iv.attempts,
  ) as TapRecord[];
  return {
    records,
    collection: {
      since: iv.since,
      until,
      dropped_through: log.dropped_through,
      pending_writes: flushed.pending_writes,
      write_errors: flushed.write_errors,
      unsettled,
    },
  };
}

/**
 * Ends the interval: its complete collection (above), the page traces, memory, the terminal references (the driver's, or the answers that
 * reached the client: the last activating one and the feed's completion), the oracle; the record (pair-evidence.mjs `assembleInterval`) is
 * written and VALIDATED before the caller asserts anything else. How it must have been driven and what it must observe come from the case's
 * MATRIX row, never from the case. Returns the record.
 */
export async function endInterval(
  page: Page,
  iv: Interval,
  details: {
    backend: string;
    workload: "W-real" | "W-synthetic";
    preGrantCursor: string;
    terminal: "activated" | "recovered";
    appliedRevision: number | null;
    oracle: { verdict: "match" | "mismatch"; problems: string[] };
    person: string;
    injectedOutsideTap?: string;
    extra?: Record<string, unknown>;
  },
) {
  const samples = await iv.heap.stop();
  await captureTrace(page, iv, "end of the interval");
  const { records, collection } = await collect(iv);
  const row = CASES.find((c) => c.id === iv.caseId);
  if (!row?.driven) throw new Error(`${iv.caseId} has no driven interval`);
  const record = assembleInterval({
    iv,
    records,
    collection,
    details: {
      ...details,
      selection: SELECTION_SHA256,
      apiVersion: API_VERSION,
      driven: row.driven,
      requiredObservations: [...row.observations],
      // Revision 27: the caller and the local-work declaration are the matrix row's, never the case's.
      ...(row.observations.some((k) => k.startsWith("recovery_"))
        ? { caller: row.caller, localWork: row.local_work ?? false }
        : {}),
    },
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
    readBody: bodyOf,
  });
  if (EVIDENCE) {
    mkdirSync(join(EVIDENCE, "intervals"), { recursive: true });
    writeFileSync(
      join(EVIDENCE, "intervals", `${iv.caseId}.${iv.engine}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }
  open.delete(iv);
  expect(
    validateInterval(record, { readBody: bodyOf }),
    "the interval record is valid evidence",
  ).toEqual([]);
  return record;
}

/**
 * A case that failed before ending its interval: the interval is kept as an INCOMPLETE record (never evidence; the runner reports it),
 * with every collected exchange, attempt, barrier, release and trace, BEFORE the tap and the proxy are reset. Memory sampling is stopped.
 */
export async function abandonOpenIntervals(reason: string) {
  for (const iv of [...open]) {
    open.delete(iv);
    const kept: Record<string, unknown> = {
      schema: "web09c-pair-interval-incomplete/2",
      interval: iv.id,
      case: iv.caseId,
      engine: iv.engine,
      reason,
      target: iv.target,
      opening: iv.opening,
      hand_off: iv.handOff,
      rearm: iv.rearm ?? null,
      barriers: iv.barriers,
      attempts: iv.attempts,
      persisted: iv.persisted,
      observations: iv.observations,
      observation_failure: iv.observationFailure ?? null,
      traces: iv.traces,
    };
    try {
      kept.memory_samples = (await iv.heap.stop()).length;
      if (Number.isInteger(iv.since)) {
        const { records, collection } = await collect(iv);
        kept.collection = collection;
        kept.requests = records;
      } else await releaseHold(iv, "the case failed during the opening");
      kept.hold_releases = iv.holdReleases;
    } catch (error) {
      kept.collection_error = String((error as Error)?.message ?? error);
    }
    if (EVIDENCE) {
      mkdirSync(join(EVIDENCE, "intervals"), { recursive: true });
      writeFileSync(
        join(
          EVIDENCE,
          "intervals",
          `${iv.caseId}.${iv.engine}.incomplete.json`,
        ),
        `${JSON.stringify(kept, null, 2)}\n`,
      );
    }
  }
}
export const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

// ---- the per-piece barrier driver (scripts/integration/pair-driver.mjs `drive`), with the browser's IO --------------------------------
export type HeldStep = DriverStep<TapRecord, Stored>;
/**
 * Drives the interval's held answers through the common driver: the hold is the interval's (its opening armed it), the workload is what
 * `start` returns (the grant's receipt, the synthetic transaction's revision), the stored state is read with raw IndexedDB in one
 * transaction. The interval keeps the attempts (even when the drive fails), the target, the terminal references and any hand-off.
 */
export async function drivePieces(options: {
  page: () => Page;
  account: string;
  iv: Interval;
  old: Stored;
  model: ChainModel;
  /** Runs with the hold in force and before the engine is nudged: the grant (or the synthetic batch), and any fault to arm. */
  start: () => Promise<Milestone>;
  onHeld?: (step: HeldStep) => Promise<HookAnswer | undefined>;
  maxSteps?: number;
  /** Revision 27 (C4): the case admits named local work (its matrix row says so); every other case keeps the zero-draft premise. */
  localWork?: boolean;
  /** Revision 39 (R39-DIAG): an identity-aware choice of the next held answer (XL0's `refusalPair`); default the oldest held entry. */
  select?: HeldSelection<TapRecord>;
}): Promise<Driven<TapRecord, Stored>> {
  const { account, iv } = options;
  if (!iv.hold || iv.hold.closed)
    throw new Error("the interval's hold is not in force");
  const ledger = createLedger();
  iv.attempts = ledger.attempts;
  iv.persisted = ledger.persisted;
  const read = async (rows = false) => {
    const s = await stored(options.page(), account, rows);
    if (!s) throw new Error("the account database is not there");
    return s;
  };
  const run = await drive<TapRecord, Stored>(
    {
      held: async (rule) => (await holds.entries())[rule] ?? [],
      records: async () =>
        syncRecords(await tap.log(iv.since)).filter((r) => r.label === iv.id),
      read: () => read(),
      release: (rule, entry) => holds.releaseOne(rule, entry),
      nudge: () => nudge(options.page()),
      waitFor: (predicate, what, o) =>
        until(() => read(o?.rows ?? false), predicate, what),
      barrier: (name, detail) => {
        if (name === "piece_persisted") iv.piecesPersisted += 1;
        barrier(iv, name, detail);
      },
      now: () => Date.now(),
      sleep,
    },
    {
      ruleId: iv.hold.ruleId,
      base: options.old,
      model: options.model,
      start: async () => {
        const first = await options.start();
        iv.target = {
          revisions: [first.revision],
          through: first.revision,
          sources: [first],
        };
        return first;
      },
      onHeld: options.onHeld,
      ledger,
      maxSteps: options.maxSteps,
      localWork: options.localWork ?? false,
      select: options.select,
    },
  );
  iv.target = { ...run.goal, sources: run.sources };
  iv.terminal = run.terminal;
  iv.handOff = run.handOff;
  return run;
}

/** The common opening: the complete old state, the interval begun and opened (the hold armed), the old state read once, rows included. */
export async function preGrant(
  page: Page,
  account: string,
  caseId: string,
  engine: string,
) {
  await untilComplete(page, account);
  const iv = await beginInterval(page, account, caseId, engine);
  // Read AFTER the opening: every /sync admitted before the hold settled, the page idle, every later answer held. ONE read, rows included.
  const at = (await stored(page, account, true)) as Stored;
  expect(
    isComplete(at),
    "the old state is complete at the pre-grant barrier",
  ).toBe(true);
  const { rows, ...old } = at;
  barrier(iv, "pre_grant_complete", {
    cursor_sha256: sha256(String(at.cursor)),
    cache_count: at.cache_count,
    cache_digest: at.cache_digest,
    page_seq: at.page_seq,
  });
  return {
    old: old as Stored,
    oldRows: rows ?? [],
    iv,
    model: {
      cursor: at.cursor as string,
      boundary: null,
      stage: null,
      activated: null,
      restarted: 0,
      pages: 0,
    } satisfies ChainModel,
  };
}

// ---- revision 26 (R26-DIAG): the diagnostic fixture's private controls and labelled probes ---------------------------------------------
/**
 * The diagnostic attempt (scripts/integration/run-development-pair.mjs `--backend diagnostic`): its ready receipt, and the runner's private
 * bridge (an owned Unix socket and this attempt's secret) to the executable's stdin controls. Only `inspect`, `age_history`,
 * `advance_clock` and `collect` pass; account creation and shutdown are the runner's. Nothing here reaches the browser, the preview or
 * the product, and no call is ever retried.
 */
export interface DiagnosticReceipt {
  attempt: string;
  sync_start: number;
  retention_seconds: number;
  api_version: string;
  public_origin: string;
  features: Record<string, boolean>;
}
export const DIAGNOSTIC_RECEIPT: DiagnosticReceipt | null = JSON.parse(
  process.env.ATLAS_PAIR_DIAGNOSTIC_RECEIPT || "null",
);
const BRIDGE = {
  socketPath: process.env.ATLAS_PAIR_DIAGNOSTIC_SOCKET ?? "",
  token: process.env.ATLAS_PAIR_DIAGNOSTIC_TOKEN ?? "",
};
export interface DiagnosticAnswer {
  attempt: string;
  seq: number;
  op: string;
  ok: true;
  effect: string;
  sync_now: number;
  // biome-ignore lint/suspicious/noExplicitAny: the executable's own result shapes, checked where they are used
  result: any;
}
/** One diagnostic command; resolves with its successful answer, throws (with the executable's answer) otherwise. */
export async function diagnostic(
  op: "inspect" | "age_history" | "advance_clock" | "collect",
  args: Record<string, unknown> = {},
): Promise<DiagnosticAnswer> {
  if (!BRIDGE.socketPath || !DIAGNOSTIC_RECEIPT)
    throw new Error("no diagnostic attempt: run with --backend diagnostic");
  const r = await bridgeCall(BRIDGE, "POST", "/command", { op, args });
  if (r.status !== 200)
    throw new Error(
      `diagnostic ${op}: ${r.status} ${JSON.stringify(r.body).slice(0, 600)}`,
    );
  return r.body.answer as DiagnosticAnswer;
}

/** The browser's own session as headers (its cookies for the preview origin and the CSRF token its session derives). */
async function browserSessionHeaders(context: BrowserContext) {
  const cookie = (await context.cookies(ORIGIN))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const current = await fetch(
    `${BACKEND}/api/experimental/v1/browser-sessions/current`,
    {
      headers: { origin: ORIGIN, cookie, "x-atlas-session": "1" },
    },
  );
  const body = (await current.json().catch(() => null)) as {
    csrf_token?: string;
    session_id?: string;
  } | null;
  return {
    cookie,
    current: current.status,
    csrf: body?.csrf_token ?? "",
    session_id: body?.session_id ?? null,
  };
}
export interface Probe {
  label: string;
  session: "browser" | "control";
  token_sha256: string | null;
  status: number;
  code: string | null;
  body_file: string | null;
  body_sha256: string | null;
  at_sent: number;
  at_answered: number;
}
/** Keeps a probe's exact answer bytes beside the tap's bodies (named, hashed), so the reader re-hashes them. */
function keepProbeBody(label: string, bytes: Buffer) {
  const digest = sha256(bytes);
  const file = `probe-${label}-${digest.slice(0, 16)}.json`;
  mkdirSync(BODIES, { recursive: true });
  writeFileSync(join(BODIES, file), bytes);
  return { file, digest };
}
/**
 * A LABELLED CONTROL PROBE (not the engine's traffic, never through the tap or the proxy, so never held, gated or labelled with the
 * interval): one `/sync` read with `token`, sent DIRECTLY to the backend under the BROWSER's own session (same account, device and session),
 * or under a raw `RawPairSession`. Its answer's bytes are kept.
 */
export async function probeSync(
  label: string,
  who: { context: BrowserContext } | { session: RawPairSession },
  token: string,
  maxChanges = 4,
): Promise<Probe> {
  const headers =
    "context" in who
      ? await browserSessionHeaders(who.context)
      : { cookie: who.session.cookie, csrf: who.session.csrf };
  const at_sent = Date.now();
  const response = await fetch(
    `${BACKEND}/api/experimental/v1/sync?cursor=${encodeURIComponent(token)}&max_changes=${maxChanges}`,
    {
      headers: {
        origin: ORIGIN,
        cookie: headers.cookie,
        "x-csrf-token": headers.csrf,
        "x-atlas-session": "1",
      },
    },
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  const at_answered = Date.now();
  let code: string | null = null;
  try {
    code =
      (JSON.parse(bytes.toString("utf8")) as { code?: string }).code ?? null;
  } catch {
    code = null;
  }
  const kept = keepProbeBody(label, bytes);
  return {
    label,
    session: "context" in who ? "browser" : "control",
    token_sha256: sha256(token),
    status: response.status,
    code,
    body_file: kept.file,
    body_sha256: kept.digest,
    at_sent,
    at_answered,
  };
}
/** The browser's session is live (wall-time authentication): `/browser-sessions/current` answered directly, labelled. */
export async function sessionProbe(context: BrowserContext) {
  const at_sent = Date.now();
  const h = await browserSessionHeaders(context);
  return {
    label: "session-live",
    status: h.current,
    session_id: h.session_id,
    at_sent,
    at_answered: Date.now(),
  };
}
/** The browser's next /sync with `token`, recorded at the closed request gate and NOT forwarded (no answer yet). */
export async function untilGated(
  iv: Interval,
  token: string,
): Promise<TapRecord> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const found = syncRecords(await tap.log(iv.since)).find(
      (r) => r.label === iv.id && r.gated === true && r.query?.cursor === token,
    );
    if (found) {
      if (found.t_gate_open !== undefined || found.status !== null)
        throw new Error(`the gated request ${found.seq} was already forwarded`);
      return found;
    }
    if (Date.now() > deadline)
      throw new Error(
        "the browser's continuation request did not reach the closed gate in 60 s",
      );
    await sleep(25);
  }
}
export const tokenHeader = (token: string): ContinuationHeader => {
  const header = continuationOf(token);
  if (!header) throw new Error("not an issued continuation");
  return header;
};
/** Writes the case's causal proof (the runner validates it against the attempt's transcript and the interval); returns its reference. */
export function writeProof(
  caseId: string,
  engine: string,
  proof: Record<string, unknown>,
) {
  const bytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
  const file = `${caseId}.${engine}.proof.json`;
  if (EVIDENCE) {
    mkdirSync(join(EVIDENCE, "diagnostic"), { recursive: true });
    writeFileSync(join(EVIDENCE, "diagnostic", file), bytes);
  }
  return { file, sha256: sha256(bytes) };
}

// ---- revision 27 (R27-DIAG.a): acknowledged markers instead of the spec's clock ------------------------------------------------------
/**
 * The spec's MARKERS (the runner's bridge `POST /mark`): each is an event of the attempt's causal journal, positioned when the runner
 * receives it, answered before the spec goes on. A probe or an action is bracketed by `<label>:begin` (acknowledged before it starts) and
 * `<label>:end` (sent after its awaited result). The proof carries `marks` (name → position) and `mark_prefix`; the runner's reader binds
 * each to the journal. Nothing compares the spec's clock with the runner's.
 */
export function markers(caseId: string) {
  const prefix = caseId.toLowerCase().replace("pair-", "");
  const marks: Record<string, number> = {};
  const mark = async (name: string): Promise<number> => {
    if (!BRIDGE.socketPath)
      throw new Error("no diagnostic attempt: run with --backend diagnostic");
    if (name in marks) throw new Error(`the marker ${name} was already made`);
    const r = await bridgeCall(BRIDGE, "POST", "/mark", {
      name: `${prefix}:${name}`,
    });
    if (r.status !== 200 || typeof r.body.j !== "number")
      throw new Error(
        `marker ${name}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`,
      );
    marks[name] = r.body.j as number;
    return marks[name];
  };
  return {
    prefix,
    marks,
    mark,
    /** `<label>:begin`, the action, `<label>:end`; resolves with the action's result. */
    async bracket<T>(label: string, action: () => Promise<T>): Promise<T> {
      await mark(`${label}:begin`);
      const out = await action();
      await mark(`${label}:end`);
      return out;
    },
  };
}
export type Markers = ReturnType<typeof markers>;

// ---- revision 27 (R27-DIAG.b, C2): the recovery observed at held snapshot pages, by the leader and an independent follower ------------
export { renderingOf };
/**
 * One reader's sample for the recovery observer. Revision 30 (R30-DIAG; design assessment C1): the maintained composition
 * (pair-capture.mjs `recoverySample`) of its raw IndexedDB read, its rendering with the auth bracket (`renderingOf`) and the stored state
 * read AGAIN after the capture (the storage bracket). The brackets stay separate outcomes: nothing here merges them or decides a re-read.
 * Revision 31 (R31-DIAG; C3): the second read's own coherent transaction is retained (`stored_after`) for the observer to judge; this
 * adapter adds no policy.
 */
export async function recoveryReader(
  page: Page,
  account: string,
  reader: "leader" | "follower",
  pageId: string,
  o: { rows?: boolean; local?: string[] | null } = {},
): Promise<RecoveryReader & { local?: LocalWork }> {
  return (await recoverySample(
    {
      stored: (rows: boolean, local: string[] | null) =>
        stored(page, account, rows, local),
      rendering: () => renderingOf(page, account),
    },
    {
      reader,
      page: pageId,
      account,
      rows: o.rows ?? false,
      local: o.local ?? null,
    },
  )) as unknown as RecoveryReader & { local?: LocalWork };
}

/**
 * Observes the recovery after the real 410 (pair-recovery.mjs `observeRecovery`) with the interval's hold still armed: every snapshot
 * answer held, observed by the leader and the follower page, and released with a recorded release. Then the hold is released (the
 * remaining answers kept), and the activation and the oracle are the observer's. Returns the final leader state (rows included).
 */
export async function observeRecoveryOf(options: {
  iv: Interval;
  account: string;
  leader: () => Page;
  follower: Page;
  caller: "ordinary" | "recovery";
  refusal: { seq: number; generation: number };
  oldDigest: string;
  expectFinal: (rows: CacheLike[]) => string[];
  onPage?: (
    kind: string,
    record: Record<string, unknown>,
    leader: RecoveryReader,
  ) => Promise<void> | void;
}): Promise<Stored> {
  const { iv } = options;
  if (!iv.hold || iv.hold.closed)
    throw new Error("the interval's hold is not in force at the hand-off");
  const ruleId = iv.hold.ruleId;
  // Revision 28: the interval names the account its recovery observations are of (pair-evidence.mjs binds every sample to it).
  iv.readerAccount = options.account;
  const done = await observeRecovery(
    {
      held: async (rule) => (await holds.entries())[rule] ?? [],
      records: async () =>
        syncRecords(await tap.log(iv.since)).filter((r) => r.label === iv.id),
      release: (rule, entry) => holds.releaseOne(rule, entry),
      read: (who, o) =>
        recoveryReader(
          who === "leader" ? options.leader() : options.follower,
          options.account,
          who,
          who === "leader" ? "leader-page" : "follower-page",
          { rows: o?.rows ?? false },
        ),
      recordRelease: (r) => {
        iv.holdReleases.push(r);
      },
      observe: (kind, atSeq, digest, detail) =>
        observe(iv, kind, atSeq, digest, undefined, detail),
      // Revision 30 (C3): the first failure only (a later one never replaces it).
      failed: (f) => {
        iv.observationFailure ??= f;
      },
      onPage: options.onPage,
      now: () => Date.now(),
      sleep,
    },
    {
      ruleId,
      caller: options.caller,
      account: options.account,
      refusal: options.refusal,
      oldDigest: options.oldDigest,
      expectFinal: (rows) => options.expectFinal(rows as CacheLike[]),
    },
  );
  await releaseHold(iv, "after the recovery's observed rendered exposure");
  return done.final as unknown as Stored;
}

/**
 * Revision 27 (C3): the recovery caller's hold. The opening's hold was released (the fence needs the ordinary engine's request answered);
 * a NEW hold is armed before the grant, so no answer of the workload is ever unheld; the tap's last sequence number then bounds the drive.
 */
export async function rearmHold(iv: Interval, reason: string) {
  if (!iv.hold?.closed)
    throw new Error("the opening's hold must be released before re-arming");
  const released = iv.hold.ruleId;
  // The tap's last sequence number BEFORE the rule exists: every exchange up to it entered before the new hold (and is not held); the
  // fenced page makes no request meanwhile, so every later /sync of the interval is held.
  const { seq } = await tap.label(iv.id);
  const rule = await proxy.addRule({
    method: "GET",
    path: SYNC,
    action: "hold",
  });
  iv.hold = { ruleId: rule.id, closed: false };
  iv.rearm = { at_seq: seq, reason, released_rule: released };
  return iv.rearm;
}

/** Every command POST the page sends (the production dispatcher's), with its Idempotency-Key and body digest; answers joined by URL order. */
export function observeCommandPosts(page: Page) {
  const sent: Array<{
    idempotency_key: string | null;
    body_sha256: string;
    path: string;
    status: number | null;
  }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() !== "POST" || !url.pathname.endsWith("/commands"))
      return;
    const entry = {
      idempotency_key: request.headers()["idempotency-key"] ?? null,
      body_sha256: sha256(request.postData() ?? ""),
      path: url.pathname,
      status: null as number | null,
    };
    sent.push(entry);
    request
      .response()
      .then((r) => {
        entry.status = r?.status() ?? null;
      })
      .catch(() => undefined);
  });
  return sent;
}
/** A save through the PRODUCTION controller's outbox facade (the production leader's dispatcher sends it). */
export const enqueueThroughProduction = (page: Page, spec: unknown) =>
  page.evaluate(
    (given) =>
      (
        window as unknown as {
          __atlasFixture: {
            session: { enqueue(spec: unknown): Promise<unknown> };
          };
        }
      ).__atlasFixture.session.enqueue(given),
    spec,
  ) as Promise<{ kind: string; localId?: string }>;
/** The page's own trace length now: a count-ordered window start (never a clock). */
export const traceLength = (page: Page) =>
  page.evaluate(() => window.__atlasFixture?.session?.trace?.length ?? 0);
export const traceFrom = async (page: Page, from: number) =>
  (
    (await page.evaluate(
      () => window.__atlasFixture?.session?.trace ?? [],
    )) as TraceLine[]
  ).slice(from);
