// WEB-14a revision 15 (review R22, R23): which integration cases run on which fresh stack, and how a stack's outcome is judged.
//
// Pure: no process is started here. scripts/integration/run.mjs supplies the processes (the backend, the proxy, the preview and
// Playwright) and scripts/integration/schedule.mjs the order; tests/static/integration-runner.test.ts supplies doubles.
//
// R22: the old base stack was "everything a negative title filter did not exclude", so later suites (sharing, snapshot) joined it
// silently and ran after the password, logout and credential-changing cases on the same backend, accounts and sign-in throttle.
// Every spec file is now NAMED by exactly one stack or a separate obligation, and `assignCases` checks Playwright's own listing:
// a discovered case in no stack, in two, or in a file nobody names stops the run before any backend starts.

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

/**
 * R23: whether ONE stack's run is complete and passed. `report` is the raw text of its result file, or null when there is none.
 * A zero exit is not enough, and neither is a green report with a non-zero exit. Returns verdict passed | failed | incomplete.
 */
export function judgeStack({
  planned,
  report,
  exitCode,
  startedAt,
  project,
  context,
  refusals = [],
  deliberateThrottle = false,
}) {
  const reasons = [];
  const counts = { passed: 0, designed_skips: 0, failed: 0, not_run: 0 };
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
  if (report === null) {
    incomplete = true;
    reasons.push("no result file");
    return finish();
  }
  let parsed;
  try {
    parsed = JSON.parse(report);
  } catch {
    incomplete = true;
    reasons.push("the result file is not JSON");
    return finish();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.suites) ||
    !parsed.stats ||
    typeof parsed.stats.startTime !== "string"
  ) {
    incomplete = true;
    reasons.push("the result file is not a complete Playwright JSON report");
    return finish();
  }
  if (Date.parse(parsed.stats.startTime) < startedAt) {
    incomplete = true;
    reasons.push(
      `the result file is stale: it started at ${parsed.stats.startTime}, before this stack`,
    );
    return finish();
  }
  if ((parsed.errors ?? []).length > 0) {
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
  const got = counted(cases.map((c) => c.key));
  const missing = [];
  for (const [key, n] of planned)
    for (let i = got.get(key) ?? 0; i < n; i += 1) missing.push(key);
  const extra = [];
  for (const [key, n] of got)
    for (let i = planned.get(key) ?? 0; i < n; i += 1) extra.push(key);
  if (missing.length > 0) {
    incomplete = true;
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
  for (const { key, file, test } of cases) {
    const results = test.results ?? [];
    if (results.length > 1 || results.some((r) => (r.retry ?? 0) > 0)) {
      failed = true;
      counts.failed += 1;
      reasons.push(`retried (no retry is approved): ${key}`);
      continue;
    }
    if (test.status === "expected" && test.expectedStatus === "passed") {
      counts.passed += 1;
      continue;
    }
    if (test.status === "skipped") {
      const reason = results.some((r) => r.status === "interrupted")
        ? null
        : designedSkip(file, test, context);
      if (reason !== null) {
        counts.designed_skips += 1;
        designed.push({ key, reason });
      } else {
        incomplete = true;
        counts.not_run += 1;
        reasons.push(
          `${results.some((r) => r.status === "interrupted") ? "interrupted" : "not run, and not a designed skip"}: ${key}`,
        );
      }
      continue;
    }
    failed = true;
    counts.failed += 1;
    reasons.push(`${test.status}: ${key}`);
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
