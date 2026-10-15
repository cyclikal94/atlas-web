// The integration programme's stacks, and the plan that gives every discovered case exactly one of them (WEB-08d review r5, H3).
//
// The released backend throttles per source over a fixed window of 60 s (120 admitted operations: password sign-ins, activation and
// its cancellation, registration and its preview, single sign-on start/callback, password change; scripts/integration/admission.mjs),
// and every case of a stack reaches it from the same loopback address. A fresh stack is a fresh backend process and so a fresh budget;
// nothing else resets it (not a new page, context, account, worker or `/reset` of the proxy). The full programme is therefore split
// into stacks whose traffic fits that budget, and each stack names the spec FILES it runs: a case that no stack names (a new spec
// file, a renamed title outside a stack's grep) fails planning instead of falling silently into a stack whose budget it would exhaust.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const spec = (name) => `tests/integration/integration.${name}.spec.ts`;

/**
 * The full programme, in launch order. `files` are Playwright file filters, `grep`/`grepInvert` its title filters, `oidc` whether
 * the stack starts the stub OpenID Connect provider. The selections before WEB-08d revision 6 are kept case for case; stacks were
 * only split. Review r5 (H3) found the sharing and snapshot specs refused at sign-in behind the base cases; revision 6 measured every
 * stack's source traffic (scripts/integration/admission.mjs) and found the base cases ALONE over the budget (126 uses in 25 s, the
 * last case's activations answered 429) and registration at 115, so those are split too. Each stack's busiest 60 s is checked by
 * the runner on every run; scripts/integration/stacks.test.mjs proves the partition against the previous definitions.
 */
export const FULL_STACKS = [
  {
    suffix: "",
    files: [
      spec("compat-settings"),
      spec("faults"),
      spec("operations"),
      spec("profile-sync"),
      spec("profile"),
    ],
    oidc: false,
  },
  {
    suffix: "-pages",
    files: [spec("pages")],
    grepInvert: "I-14e|I-14d \\(revision 11\\)",
    oidc: false,
  },
  { suffix: "-password-path", files: [spec("password-path")], oidc: false },
  { suffix: "-sharing", files: [spec("sharing")], oidc: false },
  { suffix: "-snapshot", files: [spec("snapshot")], oidc: false },
  { suffix: "-i14e", files: [spec("pages")], grep: "I-14e", oidc: false },
  {
    suffix: "-i14d",
    files: [spec("pages")],
    grep: "I-14d \\(revision 11\\)",
    oidc: false,
  },
  { suffix: "-data", files: [spec("data")], oidc: false },
  // WEB-13a's linked-calendar journeys retain their own throttle-isolated stack and loopback feed.
  { suffix: "-calendar", files: [spec("calendars")], oidc: false },
  {
    suffix: "-traces",
    files: [spec("web08b-traces")],
    grep: "I-20|I-22|I-23",
    oidc: false,
  },
  {
    suffix: "-registration",
    files: [spec("web08b-registration")],
    grep: "I-24|I-26",
    oidc: false,
  },
  {
    suffix: "-registration-i25",
    files: [spec("web08b-registration")],
    grep: "I-25",
    oidc: false,
  },
  {
    suffix: "-oidc",
    files: [spec("web08b-oidc")],
    grep: "I-21|I-27|I-28a",
    oidc: true,
  },
  {
    suffix: "-oidc-off",
    files: [spec("web08b-oidc")],
    grep: "I-28b",
    oidc: false,
  },
  {
    suffix: "-settings",
    files: [spec("web08b-settings")],
    grep: "I-29|I-30",
    oidc: false,
  },
  // WEB-08d: the BE-Q25 labels, names and capacities against the released 0.28 backend, in a fresh stack of their own.
  {
    suffix: "-labels",
    files: [spec("web08d-labels")],
    grep: "I-8d",
    oidc: false,
  },
];

/** The Playwright arguments that select a stack's cases (after `--project`). */
export function stackArgs(stack) {
  return [
    ...(stack.grep ? ["--grep", stack.grep] : []),
    ...(stack.grepInvert ? ["--grep-invert", stack.grepInvert] : []),
    ...(stack.files ?? []),
    ...(stack.passthrough ?? []),
  ];
}

/**
 * The stacks of one invocation. A run the caller narrowed (`--grep`, or Playwright arguments after `--`) is one stack, as before:
 * the caller chose what runs, and its plan only proves that the selection is not empty.
 */
export function selectStacks({ grep, passthrough, postgres, oidc }) {
  if (grep || passthrough.length > 0)
    return {
      mode: "narrowed",
      stacks: [
        {
          suffix: "",
          ...(grep ? { grep } : {}),
          passthrough,
          oidc: oidc && !postgres,
        },
      ],
    };
  return { mode: "full", stacks: FULL_STACKS };
}

/** Flatten a Playwright JSON report (a run or a `--list`) into its cases: one per project and spec. */
export function casesOf(report) {
  const out = [];
  const walk = (suite, path) => {
    for (const s of suite.specs ?? []) {
      // `--repeat-each` lists a spec once per repetition and project: each repetition is its own case.
      const seen = new Map();
      for (const t of s.tests ?? []) {
        const n = seen.get(t.projectName) ?? 0;
        seen.set(t.projectName, n + 1);
        out.push({
          key: `${t.projectName}|${s.id}${n > 0 ? `#${n}` : ""}`,
          project: t.projectName,
          id: s.id,
          file: s.file,
          line: s.line,
          title: [...path, s.title].join(" › "),
          test: t,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
  };
  for (const suite of report?.suites ?? []) walk(suite, []);
  return out;
}

/** A plain child process to completion (the default for `discover`; the runner passes its owned, abortable `exec`). */
const plainExec = (_label, command, args, { env, cwd } = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.once("error", (error) =>
      resolve({ status: null, stdout, stderr: String(error) }),
    );
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });

/**
 * Playwright's own discovery of a selection (`test --list --reporter=json`): the same projects, title filters and file filters as
 * the run, so the plan uses Playwright's grep semantics rather than an imitation of them. `evidence` receives the browser-evidence
 * allocation that the configuration makes even for a listing. `exec` runs the listing (the runner's is owned and ends on a stop).
 */
export async function discover({
  root,
  projects,
  args,
  evidence,
  env = {},
  exec = plainExec,
  signal,
}) {
  mkdirSync(evidence, { recursive: true });
  const listed = await exec(
    "discovery",
    process.execPath,
    [
      join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      "--list",
      "--reporter=json",
      // `--project` takes several names: the `=` form keeps a following file filter from being read as one.
      ...projects.map((p) => `--project=${p}`),
      ...args,
    ],
    {
      cwd: root,
      signal,
      timeoutMs: 300_000,
      env: {
        ...process.env,
        ...env,
        ATLAS_E2E_BROWSERS: "all",
        ATLAS_EVIDENCE_DIR: evidence,
        PLAYWRIGHT_JSON_OUTPUT_NAME: "",
      },
    },
  );
  let report;
  try {
    report = JSON.parse(listed.stdout);
  } catch {
    throw new Error(
      `case discovery failed (exit ${listed.status}): ${String(listed.stderr).slice(-2000)}${String(listed.stdout).slice(0, 500)}`,
    );
  }
  // An empty selection is Playwright's "No tests found" error; it is reported by the plan as the stack that selects nothing.
  const errors = (report.errors ?? []).filter(
    (e) => !/^Error: No tests found/.test(String(e.message ?? "")),
  );
  if (errors.length > 0)
    throw new Error(
      `case discovery reported errors: ${JSON.stringify(errors).slice(0, 2000)}`,
    );
  return casesOf(report).map(({ test, ...c }) => c);
}

/**
 * Give every case of `full` exactly one stack. `perStack[i]` is the discovered selection of `stacks[i]`. Fails on a case that no
 * stack selects, a case that two stacks select, a stack case outside the full inventory and a stack that selects nothing.
 */
export function assign({ full, stacks, perStack }) {
  const problems = [];
  const owner = new Map();
  stacks.forEach((stack, i) => {
    const cases = perStack[i] ?? [];
    if (cases.length === 0)
      problems.push(`stack "${stack.suffix || "base"}" selects no case`);
    for (const c of cases) {
      const earlier = owner.get(c.key);
      if (earlier !== undefined)
        problems.push(
          `${c.title} [${c.project}] is selected by both "${stacks[earlier].suffix || "base"}" and "${stack.suffix || "base"}"`,
        );
      else owner.set(c.key, i);
    }
  });
  const known = new Set(full.map((c) => c.key));
  for (const [key, i] of owner)
    if (!known.has(key))
      problems.push(
        `stack "${stacks[i].suffix || "base"}" selects ${key}, which the full discovery does not list`,
      );
  for (const c of full)
    if (!owner.has(c.key))
      problems.push(
        `${c.file}: ${c.title} [${c.project}] belongs to no stack (add it to FULL_STACKS in scripts/integration/stacks.mjs)`,
      );
  return {
    ok: problems.length === 0,
    problems,
    stacks: stacks.map((stack, i) => ({
      stack,
      cases: perStack[i] ?? [],
    })),
  };
}

/** Plan an invocation: discover the full inventory and every stack's selection, then assign. Nothing is started. */
export async function plan({
  root,
  browsers,
  selection,
  evidence,
  exec,
  signal,
}) {
  const projects = browsers.map((b) => `integration-${b}`);
  const perStack = [];
  for (const [i, stack] of selection.stacks.entries())
    perStack.push(
      await discover({
        root,
        projects,
        args: stackArgs(stack),
        evidence: join(evidence, `stack-${i}`),
        exec,
        signal,
      }),
    );
  if (selection.mode === "narrowed") {
    const cases = perStack[0];
    return {
      mode: selection.mode,
      ok: cases.length > 0,
      problems:
        cases.length > 0 ? [] : ["the narrowed selection discovers no case"],
      stacks: [{ stack: selection.stacks[0], cases }],
      full: cases,
    };
  }
  const full = await discover({
    root,
    projects,
    args: [],
    evidence: join(evidence, "full"),
    exec,
    signal,
  });
  return {
    mode: selection.mode,
    ...assign({ full, stacks: selection.stacks, perStack }),
    full,
  };
}
