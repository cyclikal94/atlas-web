// WEB-14a revision 15 (review R22, R23): which integration cases run on which fresh stack, and how a stack's outcome is judged.
//
// Pure: no process is started here. scripts/integration/run.mjs supplies the processes (the backend, the proxy, the preview and
// Playwright) and scripts/integration/schedule.mjs the order; tests/static/integration-runner.test.ts supplies doubles.
//
// R22: the old base stack was "everything a negative title filter did not exclude", so later suites (sharing, snapshot) joined it
// silently and ran after the password, logout and credential-changing cases on the same backend, accounts and sign-in throttle.
// Every spec file is now NAMED by exactly one stack or a separate obligation, and `assignCases` checks Playwright's own listing:
// a discovered case in no stack, in two, or in a file nobody names stops the run before any backend starts.
//
// Revision 16 (review R23a): a stack passes only on terminal execution evidence. The report's shape, its start time and its totals
// are checked, every planned case needs exactly one passing result at retry 0 (or the exact designed-skip shape), and every planned
// case is counted exactly once, as `unproven` when the evidence does not show what happened to it.

const SPEC = (name) => `tests/integration/integration.${name}.spec.ts`;

/**
 * The default suite, in order. Each stack is a FRESH backend, database, accounts, sign-in throttle, proxy, preview and helper state
 * (scripts/integration/run.mjs `main`). `suffix` names the result file (`results-<browser><suffix>.json`, unchanged for the older
 * stacks). `oidc`: whether the stack starts the stub OpenID Connect provider. `deliberateThrottle`: the stack contains a case that
 * provokes the backend's own 429 on purpose (I-30b); anywhere else a backend 429 means the stack's budget was not its own.
 */
export const DEFAULT_STACKS = [
  {
    name: "base",
    suffix: "",
    files: [
      SPEC("compat-settings"),
      SPEC("faults"),
      SPEC("operations"),
      // Designed skips unless ATLAS_PROFILE is set (pnpm profile:session / profile:sync run them on their own runs).
      SPEC("profile"),
      SPEC("profile-sync"),
    ],
    oidc: false,
  },
  // Revision 15: pages and password-path leave base. Measured on the corrected boundary, base with both used the backend's whole
  // 120-per-minute source budget in 24 s and I-03's sixth to eleventh activation attempts were refused with 429, which I-03 accepts
  // as "a 4xx" (a false pass the throttle check now fails). WEB-08d measured the same independently.
  {
    name: "pages",
    suffix: "-pages",
    files: [SPEC("pages")],
    grepInvert: "I-14e|I-14d \\(revision 11\\)",
    oidc: false,
  },
  {
    name: "password-path",
    suffix: "-password-path",
    files: [SPEC("password-path")],
    oidc: false,
  },
  {
    name: "i14e",
    suffix: "-i14e",
    files: [SPEC("pages")],
    grep: "I-14e",
    oidc: false,
  },
  {
    name: "i14d",
    suffix: "-i14d",
    files: [SPEC("pages")],
    grep: "I-14d \\(revision 11\\)",
    oidc: false,
  },
  { name: "data", suffix: "-data", files: [SPEC("data")], oidc: false },
  // Accepted WEB-13a journeys retain their own backend, throttle and loopback feed.
  {
    name: "calendar",
    suffix: "-calendar",
    files: [SPEC("calendars")],
    oidc: false,
  },
  {
    name: "traces",
    suffix: "-traces",
    files: [SPEC("web08b-traces")],
    oidc: false,
  },
  {
    name: "registration",
    suffix: "-registration",
    files: [SPEC("web08b-registration")],
    oidc: false,
  },
  {
    name: "oidc",
    suffix: "-oidc",
    files: [SPEC("web08b-oidc")],
    grepInvert: "I-28b",
    oidc: true,
  },
  {
    name: "oidc-off",
    suffix: "-oidc-off",
    files: [SPEC("web08b-oidc")],
    grep: "I-28b",
    oidc: false,
  },
  {
    name: "settings",
    suffix: "-settings",
    files: [SPEC("web08b-settings")],
    oidc: false,
    deliberateThrottle: true,
  },
  // R22: their own stacks. They rotate through alice, carol, dave and erin with the ORIGINAL passwords (I-08 changes carol's in
  // base) and pace sign-ins only against their own ledger, which cannot see what earlier suites used of the backend's throttle.
  {
    name: "sharing",
    suffix: "-sharing",
    files: [SPEC("sharing")],
    oidc: false,
  },
  {
    name: "snapshot",
    suffix: "-snapshot",
    files: [SPEC("snapshot")],
    oidc: false,
  },
];

/** Discovered by Playwright but NOT run by the default suite: a separate, mandatory command. Never counted as passed by it. */
export const SEPARATE = [
  {
    name: "pwa",
    files: [SPEC("pwa")],
    obligation:
      "I-U2 needs the worker-enabled build: node scripts/integration/run.mjs --app dist-pwa/fixture-a --browsers chromium,firefox,webkit -- tests/integration/integration.pwa.spec.ts",
  },
];

/**
 * The skips a passing stack may contain, each with the condition under which it is designed. Any other skipped or unexecuted case
 * makes the stack incomplete. A designed skip is reported as not run, never as passed.
 */
export const DESIGNED_SKIPS = [
  {
    file: "integration.profile.spec.ts",
    description: "not run: measurements are taken by `pnpm profile:session`",
    when: ({ env }) => !env.ATLAS_PROFILE,
  },
  {
    file: "integration.profile-sync.spec.ts",
    description: "not run: measurements are taken by `pnpm profile:sync`",
    when: ({ env }) => !env.ATLAS_PROFILE,
  },
  {
    file: "integration.web08b-traces.spec.ts",
    description:
      "structurally impossible ordering (no B request exists before B starts)",
    when: () => true,
  },
  {
    file: "integration.web08b-oidc.spec.ts",
    description:
      "takes about five and a half minutes of real time: set ATLAS_INTEGRATION_REALTIME=1 to run it",
    when: ({ env }) => !env.ATLAS_INTEGRATION_REALTIME,
  },
  {
    file: "integration.web08b-oidc.spec.ts",
    description:
      "this stack did not configure the stub OpenID Connect provider",
    when: ({ oidc }) => !oidc,
  },
  {
    // I-25h: the released `account` command makes no household, so the household invitation is Layer B only (recorded NOT RUN).
    file: "integration.web08b-registration.spec.ts",
    prefix: "NOT RUN: no bootstrap account manages a household",
    when: () => true,
  },
  {
    file: "integration.pwa.spec.ts",
    description:
      "needs the worker-enabled build: scripts/integration/run.mjs --app dist-pwa/fixture-a",
    when: ({ app }) => !app.includes("dist-pwa"),
  },
];

/** The Playwright selection arguments of one stack (positional file filters last, so `--project=` never swallows one). */
export function stackArgs(stack) {
  return [
    ...(stack.grep ? ["--grep", stack.grep] : []),
    ...(stack.grepInvert ? ["--grep-invert", stack.grepInvert] : []),
    ...(stack.args ?? []),
    ...(stack.files ?? []),
  ];
}

/**
 * The stacks of one invocation. A run the caller has narrowed (`--grep`, or Playwright arguments after `--` such as a spec file) is
 * ONE stack: the caller chose what runs, and the closure check does not apply (its listing is still the case inventory).
 * `only` (`--stacks a,b`) runs a named subset of the default stacks, in their usual order: the closure check still covers the whole
 * manifest, and the summary is marked partial (never complete).
 */
export function planStacks({ grep, passthrough, oidc, postgres, only = [] }) {
  const narrowed = Boolean(grep) || passthrough.length > 0;
  if (narrowed && only.length > 0)
    throw new Error("--stacks names default stacks; it cannot be narrowed too");
  const unknown = only.filter(
    (name) => !DEFAULT_STACKS.some((s) => s.name === name),
  );
  if (unknown.length > 0)
    throw new Error(`no such stack: ${unknown.join(", ")}`);
  if (narrowed)
    return {
      narrowed: true,
      partial: false,
      stacks: [
        {
          name: "narrowed",
          suffix: "",
          args: grep ? ["--grep", grep] : [],
          oidc: oidc && !postgres,
          // Decided from the listing: whether the caller's selection contains the settings spec (I-30b).
          deliberateThrottle: undefined,
          passthrough,
        },
      ],
    };
  const manifest = DEFAULT_STACKS.map((stack) => ({
    ...stack,
    oidc: stack.oidc && !postgres,
    passthrough: [],
  }));
  return {
    narrowed: false,
    partial: only.length > 0,
    manifest,
    stacks:
      only.length > 0
        ? manifest.filter((s) => only.includes(s.name))
        : manifest,
  };
}

const base = (file) => file.split("/").at(-1);

/** Every test of a Playwright JSON report, with the identity used to compare a listing with a result: project, file, titles. */
export function reportCases(report) {
  const out = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? [])
        out.push({
          key: [
            test.projectName,
            base(spec.file ?? suite.file ?? ""),
            ...titles,
            spec.title,
          ].join(" › "),
          project: test.projectName,
          file: base(spec.file ?? suite.file ?? ""),
          test,
        });
    for (const child of suite.suites ?? [])
      walk(child, child.title ? [...titles, child.title] : titles);
  };
  // The top-level suites are the files; their title is the file name, not a describe.
  for (const file of report.suites ?? []) walk(file, []);
  return out;
}

const counted = (keys) => {
  const map = new Map();
  for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1);
  return map;
};

/**
 * R22 closure: every case of the whole listing is selected by exactly one stack or one separate obligation (counted, so a repeat
 * selected twice is a duplicate), and every stack selects at least one case in every browser.
 */
export function assignCases({ all, stacks, separate, browsers }) {
  const problems = [];
  const owners = new Map();
  const claim = (name, keys) => {
    for (const [key, n] of counted(keys))
      owners.set(key, [
        ...(owners.get(key) ?? []),
        ...Array.from({ length: n }, () => name),
      ]);
  };
  for (const { name, keys } of [...stacks, ...separate]) claim(name, keys);
  const wanted = counted(all);
  for (const [key, n] of wanted) {
    const by = owners.get(key) ?? [];
    if (by.length < n) problems.push(`in no stack: ${key}`);
    else if (by.length > n)
      problems.push(`in more than one stack (${by.join(", ")}): ${key}`);
  }
  for (const key of owners.keys())
    if (!wanted.has(key)) problems.push(`not in the whole listing: ${key}`);
  for (const { name, keys } of stacks)
    for (const browser of browsers)
      if (!keys.some((key) => key.startsWith(`integration-${browser} › `)))
        problems.push(`stack ${name} selects nothing in ${browser}`);
  return { ok: problems.length === 0, problems };
}

/** The reason a skipped test is a designed skip, or null. */
export function designedSkip(file, test, context) {
  const notes = [
    ...(test.annotations ?? []),
    ...(test.results ?? []).flatMap((r) => r.annotations ?? []),
  ]
    .filter((a) => a.type === "skip")
    .map((a) => a.description ?? "");
  if (notes.length === 0) return null;
  for (const note of notes)
    for (const rule of DESIGNED_SKIPS)
      if (
        rule.file === file &&
        (rule.description !== undefined
          ? note === rule.description
          : note.startsWith(rule.prefix)) &&
        rule.when(context)
      )
        return note;
  return null;
}

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const TEST_STATUSES = new Set(["expected", "unexpected", "flaky", "skipped"]);
const RESULT_STATUSES = new Set([
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
]);
const EXPECTED_STATUSES = new Set([
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
]);

/**
 * Revision 16 (R23a): what is wrong with the SHAPE of a parsed Playwright JSON report, as the pinned reporter writes it (every field
 * this module reads, with its type), or [] when nothing is. Checked before anything walks the report, so a malformed nested value is
 * an explained incomplete result, never a throw and never a guess. A `--list` report has the same shape (its tests have no results).
 */
export function reportShapeProblems(parsed) {
  const problems = [];
  const note = (problem) => {
    if (problems.length < 5) problems.push(problem);
    else if (problems.length === 5)
      problems.push("(further shape problems not listed)");
  };
  if (!isObject(parsed)) return ["the report is not a JSON object"];
  const { stats } = parsed;
  if (!isObject(stats)) note("the report has no stats");
  else {
    if (
      typeof stats.startTime !== "string" ||
      !Number.isFinite(Date.parse(stats.startTime))
    )
      note(`stats.startTime is not a time: ${JSON.stringify(stats.startTime)}`);
    if (
      typeof stats.duration !== "number" ||
      !Number.isFinite(stats.duration) ||
      stats.duration < 0
    )
      note(
        `stats.duration is not a duration: ${JSON.stringify(stats.duration)}`,
      );
    for (const key of ["expected", "skipped", "unexpected", "flaky"])
      if (!isCount(stats[key])) note(`stats.${key} is not a count`);
  }
  if (!Array.isArray(parsed.errors)) note("errors is not a list");
  if (!Array.isArray(parsed.suites)) {
    note("suites is not a list");
    return problems;
  }
  const annotations = (value, where) => {
    if (value === undefined) return;
    if (!Array.isArray(value) || !value.every(isObject))
      note(`${where}: annotations is not a list of objects`);
  };
  const result = (value, where) => {
    if (!isObject(value)) {
      note(`${where} is not an object`);
      return;
    }
    if (!RESULT_STATUSES.has(value.status))
      note(`${where} has an unknown status ${JSON.stringify(value.status)}`);
    if (!isCount(value.retry)) note(`${where}.retry is not a count`);
    annotations(value.annotations, where);
  };
  const test = (value, where) => {
    if (!isObject(value)) {
      note(`${where} is not an object`);
      return;
    }
    if (typeof value.projectName !== "string")
      note(`${where} has no projectName`);
    if (!TEST_STATUSES.has(value.status))
      note(`${where} has an unknown status ${JSON.stringify(value.status)}`);
    if (!EXPECTED_STATUSES.has(value.expectedStatus))
      note(
        `${where} has an unknown expectedStatus ${JSON.stringify(value.expectedStatus)}`,
      );
    annotations(value.annotations, where);
    if (!Array.isArray(value.results)) {
      note(`${where}.results is not a list`);
      return;
    }
    for (const [k, each] of value.results.entries())
      result(each, `${where}.results[${k}]`);
  };
  const spec = (value, where, file) => {
    if (!isObject(value)) {
      note(`${where} is not an object`);
      return;
    }
    if (typeof value.title !== "string") note(`${where} has no title`);
    if (typeof value.file !== "string" && typeof file !== "string")
      note(`${where} has no file`);
    if (!Array.isArray(value.tests)) {
      note(`${where}.tests is not a list`);
      return;
    }
    for (const [j, each] of value.tests.entries())
      test(each, `${where}.tests[${j}]`);
  };
  const suite = (value, where, file) => {
    if (!isObject(value)) {
      note(`${where} is not an object`);
      return;
    }
    if (typeof value.title !== "string") note(`${where} has no title`);
    const own = typeof value.file === "string" ? value.file : file;
    for (const [key, list] of [
      ["specs", value.specs],
      ["suites", value.suites],
    ])
      if (list !== undefined && !Array.isArray(list))
        note(`${where}.${key} is not a list`);
    if (Array.isArray(value.specs))
      for (const [i, each] of value.specs.entries())
        spec(each, `${where}.specs[${i}]`, own);
    if (Array.isArray(value.suites))
      for (const [i, child] of value.suites.entries())
        suite(child, `${where}.suites[${i}]`, own);
  };
  for (const [i, value] of parsed.suites.entries())
    suite(value, `suites[${i}]`, undefined);
  return problems;
}

/**
 * Revision 16 (R23a, I1/I2): what ONE planned case's own test record proves. A listed test object is not execution evidence: only
 * exactly one terminal `passed` result at retry 0 under status `expected` / expectedStatus `passed` is a pass, and a designed skip
 * needs the pinned reporter's skip shape (status and expectedStatus `skipped`, one `skipped` result) as well as its own annotation
 * and condition. Returns [outcome, reason]: passed | designed | failed | interrupted | not_run | unproven.
 */
function caseOutcome(file, test, context) {
  const results = test.results;
  const shown = `status ${test.status}, expected ${test.expectedStatus}, results [${results.map((r) => `${r.status}@${r.retry}`).join(", ")}]`;
  if (results.some((r) => r.status === "interrupted"))
    return ["interrupted", "interrupted"];
  if (results.length > 1 || results.some((r) => r.retry !== 0))
    return ["failed", "retried (no retry is approved)"];
  if (test.status === "unexpected" || test.status === "flaky")
    return ["failed", test.status];
  const [only] = results;
  if (only && (only.status === "failed" || only.status === "timedOut"))
    return ["failed", `a ${only.status} execution under ${shown}`];
  if (test.status === "expected")
    return test.expectedStatus === "passed" && only?.status === "passed"
      ? ["passed", null]
      : ["unproven", `no terminal passing execution (${shown})`];
  // status skipped
  if (results.length === 0)
    return ["not_run", "not run, and not a designed skip"];
  if (test.expectedStatus !== "skipped" || only.status !== "skipped")
    return ["unproven", `contradictory skip (${shown})`];
  const reason = designedSkip(file, test, context);
  return reason !== null
    ? ["designed", reason]
    : ["not_run", "not run, and not a designed skip"];
}

/** Every planned case accounted for once (revision 16, I6): the outcome counts of one stack. */
export const emptyCounts = () => ({
  passed: 0,
  designed_skips: 0,
  failed: 0,
  interrupted: 0,
  not_run: 0,
  unproven: 0,
  not_launched: 0,
});
const total = (planned) => [...planned.values()].reduce((n, k) => n + k, 0);

/**
 * R23: whether ONE stack's run is complete and passed. `report` is the raw text of its result file, or null when there is none.
 * A zero exit is not enough, and neither is a green report with a non-zero exit. Returns verdict passed | failed | incomplete, and
 * counts that account for every planned case exactly once (`unproven`: the report does not prove what happened to it).
 *
 * Revision 16 (R23a): the report's shape is checked first (`reportShapeProblems`); its start time must be a real time inside this
 * stack's own run (`startedAt` .. `finishedAt`); every case needs its own terminal execution evidence (`caseOutcome`); and the
 * report's own totals must agree with its tests.
 */
export function judgeStack({
  planned,
  report,
  exitCode,
  startedAt,
  finishedAt,
  project,
  context,
  refusals = [],
  deliberateThrottle = false,
}) {
  const reasons = [];
  const counts = emptyCounts();
  const designed = [];
  let incomplete = false;
  let failed = false;
  const finish = () => {
    return {
      verdict: incomplete ? "incomplete" : failed ? "failed" : "passed",
      reasons,
      counts,
      designed_skips: designed,
    };
  };
  const unproven = (reason) => {
    incomplete = true;
    reasons.push(reason);
    counts.unproven = total(planned);
    return finish();
  };
  // A non-zero exit fails the stack whatever its result file says.
  if (exitCode !== 0) {
    failed = true;
    reasons.push(`Playwright exited ${exitCode}`);
  }
  if (refusals.length > 0 && !deliberateThrottle) {
    failed = true;
    reasons.push(
      `the backend refused ${refusals.length} request(s) with 429 (first: ${refusals[0].method} ${refusals[0].path}): this stack's throttle budget was not its own`,
    );
  }
  if (report === null) return unproven("no result file");
  let parsed;
  try {
    parsed = JSON.parse(report);
  } catch {
    return unproven("the result file is not JSON");
  }
  const shape = reportShapeProblems(parsed);
  if (shape.length > 0)
    return unproven(
      `the result file is not a complete Playwright JSON report: ${shape.join("; ")}`,
    );
  const began = Date.parse(parsed.stats.startTime);
  if (!Number.isFinite(startedAt) || began < startedAt)
    return unproven(
      `the result file is stale: it started at ${parsed.stats.startTime}, before this stack`,
    );
  if (finishedAt !== undefined && !(began <= finishedAt))
    return unproven(
      `the result file started at ${parsed.stats.startTime}, after this stack finished`,
    );
  if (parsed.errors.length > 0) {
    failed = true;
    reasons.push(
      `Playwright reported ${parsed.errors.length} error(s) outside a test: ${String(parsed.errors[0]?.message ?? "").slice(0, 200)}`,
    );
  }
  const cases = reportCases(parsed);
  const wrong = cases.filter((c) => c.project !== project);
  if (wrong.length > 0) {
    incomplete = true;
    reasons.push(
      `${wrong.length} result(s) for another project (${wrong[0].project})`,
    );
  }
  // The report's own totals must agree with its tests (a contradictory report is not evidence either way).
  const statuses = { expected: 0, skipped: 0, unexpected: 0, flaky: 0 };
  for (const { test } of cases) statuses[test.status] += 1;
  const disagree = Object.keys(statuses).filter(
    (key) => parsed.stats[key] !== statuses[key],
  );
  if (disagree.length > 0) {
    incomplete = true;
    reasons.push(
      `the report's totals contradict its tests (${disagree.map((k) => `${k} ${parsed.stats[k]} != ${statuses[k]}`).join(", ")})`,
    );
  }
  const used = new Map();
  const extra = [];
  for (const { key, file, test } of cases) {
    const n = used.get(key) ?? 0;
    if (n >= (planned.get(key) ?? 0)) {
      extra.push(key);
      continue;
    }
    used.set(key, n + 1);
    const [outcome, reason] = caseOutcome(file, test, context);
    if (outcome === "passed") counts.passed += 1;
    else if (outcome === "designed") {
      counts.designed_skips += 1;
      designed.push({ key, reason });
    } else {
      if (outcome === "failed") failed = true;
      else incomplete = true;
      counts[outcome] += 1;
      reasons.push(`${reason}: ${key}`);
    }
  }
  const missing = [];
  for (const [key, n] of planned)
    for (let i = used.get(key) ?? 0; i < n; i += 1) missing.push(key);
  if (missing.length > 0) {
    incomplete = true;
    counts.unproven += missing.length;
    reasons.push(
      `${missing.length} planned case(s) have no result (first: ${missing[0]})`,
    );
  }
  if (extra.length > 0) {
    incomplete = true;
    reasons.push(
      `${extra.length} result(s) were not planned (first: ${extra[0]})`,
    );
  }
  return finish();
}

/** The paths whose answers count against the backend's sign-in throttle (a path heuristic, for the per-stack demand record). */
const THROTTLED = /\/(browser-sessions|password|registrations?|oidc)(\/|$)/;

/** What one stack asked of the backend's throttle, from the proxy's view of every UPSTREAM answer (proxy-injected statuses excluded). */
export function throttleRecord(exchanges) {
  const refusals = exchanges
    .filter((e) => e.status === 429)
    .map(({ method, path, at }) => ({ method, path, at }));
  const admitted = exchanges
    .filter(
      (e) =>
        e.method === "POST" && e.status !== 429 && THROTTLED.test(e.path ?? ""),
    )
    .map((e) => e.at)
    .sort((a, b) => a - b);
  let peak = 0;
  for (let i = 0, j = 0; i < admitted.length; i += 1) {
    while (admitted[i] - admitted[j] >= 60_000) j += 1;
    peak = Math.max(peak, i - j + 1);
  }
  const byPath = {};
  for (const e of exchanges)
    if (e.method === "POST" && THROTTLED.test(e.path ?? ""))
      byPath[e.path] = (byPath[e.path] ?? 0) + 1;
  return {
    requests: exchanges.length,
    sign_in_class_posts: admitted.length,
    sign_in_class_by_path: byPath,
    sign_in_class_peak_60s: peak,
    refusals_429: refusals,
  };
}
