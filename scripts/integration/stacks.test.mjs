import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assign,
  casesOf,
  discover,
  FULL_STACKS,
  plan,
  selectStacks,
  stackArgs,
} from "./stacks.mjs";

// The repository whose Playwright configuration and specs are discovered (a mutation run tests a COPY of these scripts against it).
const root =
  process.env.ATLAS_INTEGRATION_TOOLS_ROOT ??
  resolve(import.meta.dirname, "../..");
const c = (key, title = key) => ({
  key,
  project: key.split("|")[0],
  file: "f",
  title,
});
const stacks = (...names) => names.map((suffix) => ({ suffix }));

test("every case in exactly one stack is a valid plan", () => {
  const full = [c("p|a"), c("p|b"), c("p|c")];
  const result = assign({
    full,
    stacks: stacks("", "-x"),
    perStack: [[full[0], full[1]], [full[2]]],
  });
  assert.equal(result.ok, true, result.problems.join("\n"));
});

test("a case in two stacks, in none, outside the inventory, or an empty stack fails planning", () => {
  const full = [c("p|a"), c("p|b")];
  const twice = assign({
    full,
    stacks: stacks("", "-x"),
    perStack: [[full[0], full[1]], [full[1]]],
  });
  assert.equal(twice.ok, false);
  assert.match(
    twice.problems.join("\n"),
    /selected by both "base" and "x"|both "base" and "-x"/,
  );
  const none = assign({
    full,
    stacks: stacks(""),
    perStack: [[full[0]]],
  });
  assert.equal(none.ok, false);
  assert.match(none.problems.join("\n"), /p\|b|b \[p\] belongs to no stack/);
  const unknown = assign({
    full,
    stacks: stacks(""),
    perStack: [[full[0], full[1], c("p|z")]],
  });
  assert.equal(unknown.ok, false);
  assert.match(
    unknown.problems.join("\n"),
    /p\|z, which the full discovery does not list/,
  );
  const empty = assign({
    full,
    stacks: stacks("", "-x"),
    perStack: [[full[0], full[1]], []],
  });
  assert.equal(empty.ok, false);
  assert.match(empty.problems.join("\n"), /stack "-x" selects no case/);
});

test("repetitions of one spec are distinct cases", () => {
  const report = {
    suites: [
      {
        title: "a.spec.ts",
        specs: [
          {
            id: "s1",
            title: "t",
            file: "a.spec.ts",
            tests: [
              { projectName: "p" },
              { projectName: "p" },
              { projectName: "q" },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(
    casesOf(report).map((x) => x.key),
    ["p|s1", "p|s1#1", "q|s1"],
  );
});

test("a narrowed run is one stack that keeps the caller's selection", () => {
  const narrowed = selectStacks({
    grep: "I-27k",
    passthrough: [],
    postgres: false,
    oidc: true,
  });
  assert.equal(narrowed.mode, "narrowed");
  assert.deepEqual(stackArgs(narrowed.stacks[0]), ["--grep", "I-27k"]);
  assert.equal(narrowed.stacks[0].oidc, true);
  const files = selectStacks({
    grep: "",
    passthrough: ["integration.profile"],
    postgres: true,
    oidc: true,
  });
  assert.deepEqual(stackArgs(files.stacks[0]), ["integration.profile"]);
  assert.equal(files.stacks[0].oidc, false);
  assert.equal(
    selectStacks({ grep: "", passthrough: [], postgres: false, oidc: true })
      .mode,
    "full",
  );
});

// The full programme before WEB-08d revision 6, verbatim (scripts/integration/run.mjs at e88085b): the base was a catch-all.
const LEGACY = [
  {
    suffix: "",
    args: [
      "--grep-invert",
      "I-14e|I-14d \\(revision 11\\)|I-(P|O|C|S|W)[0-9]|I-2[0-9]|I-30|I-8d",
    ],
  },
  { suffix: "-i14e", args: ["--grep", "I-14e"] },
  { suffix: "-i14d", args: ["--grep", "I-14d \\(revision 11\\)"] },
  { suffix: "-data", args: ["tests/integration/integration.data.spec.ts"] },
  { suffix: "-traces", args: ["--grep", "I-20|I-22|I-23"] },
  { suffix: "-registration", args: ["--grep", "I-24|I-25|I-26"] },
  { suffix: "-oidc", args: ["--grep", "I-21|I-27|I-28a"] },
  { suffix: "-oidc-off", args: ["--grep", "I-28b"] },
  { suffix: "-settings", args: ["--grep", "I-29|I-30"] },
  { suffix: "-labels", args: ["--grep", "I-8d"] },
];

test("Playwright's discovery: the full programme gives every case one stack and keeps every earlier selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-plan-"));
  try {
    const projects = ["integration-chromium"];
    const p = await plan({
      root,
      browsers: ["chromium"],
      selection: selectStacks({
        grep: "",
        passthrough: [],
        postgres: false,
        oidc: true,
      }),
      evidence: dir,
    });
    assert.equal(p.ok, true, p.problems.join("\n"));
    const by = Object.fromEntries(
      p.stacks.map(({ stack, cases }) => [
        stack.suffix || "base",
        new Set(cases.map((x) => x.key)),
      ]),
    );
    assert.equal(
      Object.values(by).reduce((n, s) => n + s.size, 0),
      p.full.length,
    );
    // The two suites the review found refused at sign-in: every case, on stacks of their own.
    const titles = (name) =>
      p.stacks
        .find(({ stack }) => (stack.suffix || "base") === name)
        .cases.map((x) => x.title)
        .join("\n");
    assert.equal(by["-sharing"].size, 7);
    for (const id of [
      "I-SH1",
      "I-SH3",
      "I-SH4",
      "I-SH5",
      "I-SH6",
      "I-SH7",
      "I-SH9",
    ])
      assert.match(titles("-sharing"), new RegExp(id));
    assert.equal(by["-snapshot"].size, 6);
    for (const id of ["I-N1", "I-N2", "I-N3", "I-N4", "I-N5", "I-N6"])
      assert.match(titles("-snapshot"), new RegExp(id));
    // Every earlier stack's cases are exactly those of the stacks that replace it: stacks were only split.
    const SPLIT = {
      "": [
        "base",
        "-pages",
        "-password-path",
        "-sharing",
        "-snapshot",
        "-calendar",
      ],
      "-registration": ["-registration", "-registration-i25"],
    };
    for (const [i, legacy] of LEGACY.entries()) {
      const old = new Set(
        (
          await discover({
            root,
            projects,
            args: legacy.args,
            evidence: join(dir, `legacy-${i}`),
          })
        ).map((x) => x.key),
      );
      const now = new Set(
        (SPLIT[legacy.suffix] ?? [legacy.suffix]).flatMap((name) => [
          ...by[name],
        ]),
      );
      assert.deepEqual(
        [...now].sort(),
        [...old].sort(),
        `stack "${legacy.suffix || "base"}"`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Playwright's discovery: a missing stack, the old catch-all base or an empty narrowed run fails planning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-plan-"));
  try {
    const run = (stacksOf, extra = {}) =>
      plan({
        root,
        browsers: ["chromium"],
        selection: { mode: "full", stacks: stacksOf, ...extra },
        evidence: join(dir, String(Math.random()).slice(2)),
      });
    // A spec no stack names (here: the labels stack left out) belongs to no stack.
    const unnamed = await run(
      FULL_STACKS.filter((s) => s.suffix !== "-labels"),
    );
    assert.equal(unnamed.ok, false);
    assert.match(
      unnamed.problems.join("\n"),
      /integration\.web08d-labels\.spec\.ts: .*I-8d-1: .* belongs to no stack/,
    );
    // The old catch-all base beside the new stacks selects the pages, password-path, sharing and snapshot cases twice.
    const catchAll = await run([
      { suffix: "", passthrough: LEGACY[0].args },
      ...FULL_STACKS.slice(1),
    ]);
    assert.equal(catchAll.ok, false);
    for (const name of ["-pages", "-password-path", "-sharing", "-snapshot"])
      assert.match(
        catchAll.problems.join("\n"),
        new RegExp(`selected by both "base" and "${name}"`),
      );
    const nothing = await plan({
      root,
      browsers: ["chromium"],
      selection: selectStacks({
        grep: "no case is called this",
        passthrough: [],
        postgres: false,
        oidc: true,
      }),
      evidence: join(dir, "narrowed"),
    });
    assert.equal(nothing.ok, false);
    assert.deepEqual(nothing.problems, [
      "the narrowed selection discovers no case",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
