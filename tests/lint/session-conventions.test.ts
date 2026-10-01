// @vitest-environment node
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  checkActivityConstruction,
  checkR7,
  checkR8,
  checkR9,
  checkR10,
  checkR11,
  checkR12,
  checkTree,
  firstStatements,
  functionsIn,
  mask,
  REQUIRED,
} from "../../scripts/lib/session-conventions.mjs";

const ROOT = resolve(__dirname, "../..");
const rules = (diagnostics: Array<{ rule: string }>) =>
  diagnostics.map((d) => d.rule);
const messages = (diagnostics: Array<{ message: string }>) =>
  diagnostics.map((d) => d.message);

/**
 * F-LINT R7 to R12: the session module's conventions (plan section 9), checked by scripts/check-session-conventions.mjs.
 * Each rule bites on its known-bad snippets, passes its known-good ones, and passes on the real tree. The checker is
 * SYNTACTIC (see the spike record): these tests are the proof of what it does and does not see.
 */
describe("the scanner underneath", () => {
  test("mask blanks comments and string contents but keeps offsets and lines", () => {
    const source = 'a(); // await\nconst s = "await x";\n/* await */ b();';
    const masked = mask(source);
    expect(masked.length).toBe(source.length);
    expect(masked).not.toMatch(/await/);
    expect(masked.split("\n")).toHaveLength(3);
  });
  test("functionsIn finds declarations, generic functions, async methods and return types with object types, not calls", () => {
    const masked = mask(`
      export async function one<R>(a: A): Promise<Out<R>> { return 1; }
      class C {
        private async two(x: number): Promise<{ kind: "a" } | { kind: "b" }> { return x; }
        three() { four(); }
      }
      function five() { six(1); if (x) { seven(); } }
    `);
    expect(functionsIn(masked).map((f) => f.name)).toEqual([
      "one",
      "two",
      "three",
      "five",
    ]);
  });
  test("firstStatements splits at top-level semicolons and after a compound statement", () => {
    expect(firstStatements("  a(1, [2;3]);  b();  ", 2)).toEqual([
      "a(1, [2;3]);",
      "b();",
    ]);
    expect(firstStatements("try { x(); } finally { y(); } z();", 2)).toEqual([
      "try { x(); } finally { y(); }",
      "z();",
    ]);
  });
});

describe("R7 send-boundary", () => {
  const good = `
    function issue(fetch, step) {
      if (step.refuses()) { step.releaseIssueLock(); return null; }
      step.markIssued();
      try { return fetch(decorate(step.request)); }
      finally { step.releaseIssueLock(); }
    }`;
  test("the known-good shape passes", () => {
    expect(checkR7("boundary.ts", good)).toEqual([]);
  });
  test.each([
    [
      "a fetch outside try/finally",
      good.replace(
        "try { return fetch(decorate(step.request)); }",
        "fetch(x); try { return 1; }",
      ),
    ],
    [
      "an await between the guard and the fetch",
      good.replace("step.markIssued();", "await step.ready;"),
    ],
    [
      "a finally that does not release the issue lock",
      good.replace(
        "finally { step.releaseIssueLock(); }",
        "finally { step.done(); }",
      ),
    ],
    [
      "no finally at all",
      good.replace(
        "finally { step.releaseIssueLock(); }",
        "catch (e) { throw e; }",
      ),
    ],
    [
      "a second call of fetch",
      `${good}\nfunction other(fetch) { return fetch(1); }`,
    ],
    [
      "a .then on the result",
      good.replace(
        "return fetch(decorate(step.request));",
        "return fetch(decorate(step.request)).then(x);",
      ),
    ],
    [
      "a call on locks",
      good.replace("step.markIssued();", "locks.request(n);"),
    ],
    ["a store read", good.replace("step.markIssued();", "store.transact(b);")],
    ["a read( call", good.replace("step.markIssued();", "read(step);")],
    [
      "the guard after the try",
      good
        .replace(/if \(step\.refuses\(\)\) \{[^}]*\}/, "")
        .replace(
          "finally { step.releaseIssueLock(); }",
          "finally { step.releaseIssueLock(); }\n if (step.refuses()) {}",
        ),
    ],
    ["no guard at all", good.replace(/if \(step\.refuses\(\)\) \{[^}]*\}/, "")],
  ])("bad: %s", (_name, source) => {
    expect(rules(checkR7("boundary.ts", source))).toContain("R7");
  });
  test("a missing `issue` is reported, not skipped", () => {
    expect(messages(checkR7("boundary.ts", "function other() {}"))[0]).toMatch(
      /`issue` was not found/,
    );
  });
  test("comments and strings do not count as code", () => {
    expect(
      checkR7(
        "boundary.ts",
        good.replace(
          "step.markIssued();",
          "// await x\n step.markIssued(); const s = 'locks.request(';",
        ),
      ),
    ).toEqual([]);
  });
});

describe("R8 closing-write-first", () => {
  test("good: function and method forms begin with beginClosing()", () => {
    expect(
      checkR8(
        "attempts.ts",
        `
        async function settleClosingWrite(k) { beginClosing(k); try { await x(); } finally { endClosing(k); } }
        class A { private async fenceClosingWrite(k): Promise<{ kind: "a" } | { kind: "b" }> { beginClosing(this.k); return 1; } }
        export function beginClosing(k) { k.closing += 1; }`,
      ),
    ).toEqual([]);
  });
  test.each([
    [
      "another first statement",
      "async function xClosingWrite(k) { const a = 1; beginClosing(k); }",
    ],
    [
      "beginClosing after an await",
      "async function xClosingWrite(k) { await y(); beginClosing(k); }",
    ],
    ["no beginClosing at all", "function xClosingWrite(k) { return 1; }"],
    [
      "beginClosing called by a function that is not a closing write",
      "function other(k) { beginClosing(k); }",
    ],
  ])("bad: %s", (_name, source) => {
    expect(rules(checkR8("attempts.ts", source))).toContain("R8");
  });
});

describe("R9 surrender-first", () => {
  const good = `
    export async function handleOrdinaryAnswer(k, inflight, response) {
      const surrendered = surrenderLock(k, inflight, response.status);
      detectInvalidation(k, inflight, surrendered);
      const body = await response.text();
      return body;
    }`;
  test("good passes", () => {
    expect(checkR9("send.ts", good)).toEqual([]);
  });
  test.each([
    [
      "an await before the surrender",
      good.replace(
        "const surrendered = surrenderLock(k, inflight, response.status);",
        "await tick(); const surrendered = surrenderLock(k, inflight, response.status);",
      ),
    ],
    [
      "a body read before the hold",
      good.replace(
        "detectInvalidation(k, inflight, surrendered);",
        "const t = response.json(); detectInvalidation(k, inflight, surrendered);",
      ),
    ],
    [
      "a store call before the hold",
      good.replace(
        "detectInvalidation(k, inflight, surrendered);",
        "store.transact(b); detectInvalidation(k, inflight, surrendered);",
      ),
    ],
    [
      "the hold not second",
      good.replace(
        "detectInvalidation(k, inflight, surrendered);",
        "log(); detectInvalidation(k, inflight, surrendered);",
      ),
    ],
    [
      "surrenderLock called by another function",
      `${good}\nfunction other(k) { surrenderLock(k, 1, 2); }`,
    ],
    [
      "a handler that never surrenders",
      "async function handleOtherAnswer(k) { return 1; }",
    ],
  ])("bad: %s", (_name, source) => {
    expect(rules(checkR9("send.ts", source))).toContain("R9");
  });
});

describe("R10 act-is-synchronous", () => {
  const good = `export function act(k, a) { a.state = 'ACTED'; ports.surface.attachTree(a.account, a.epoch); handle.release(); void deleteBestEffort(k, [a.m]); }`;
  test("good passes", () => {
    expect(checkR10("expose.ts", good)).toEqual([]);
  });
  test.each([
    ["an await", "export async function act(k) { await x(); }"],
    ["a .then", "export function act(k) { p.then(f); }"],
    ["a transact", "export function act(k) { k.ports.store.transact(b); }"],
    ["a store member", "export function act(k) { store.get(); }"],
    ["a lock request", "export function act(k) { locks.acquire('n'); }"],
    ["a read", "export function act(k) { read(k); }"],
    [
      "attachTree outside act",
      "function other(k) { surface.attachTree(a, 1); }",
    ],
  ])("bad: %s", (_name, source) => {
    expect(rules(checkR10("expose.ts", source))).toContain("R10");
  });
  test("the surface port and adapter may declare and define attachTree", () => {
    expect(
      checkR10(
        "src/session/ports/surface.ts",
        "interface S { attachTree(a: string): void }",
      ),
    ).toEqual([]);
    expect(
      checkR10(
        "src/session/adapters/protected-surface.ts",
        "const s = { attachTree(a) { return 1; } };",
      ),
    ).toEqual([]);
  });
});

describe("R11 activity-first", () => {
  test("good: the activity is created first, assigned or bare", () => {
    expect(
      checkR11(
        "send.ts",
        "async function send(k, spec) { const activity = createActivity(k, 'request'); use(activity); }",
      ),
    ).toEqual([]);
    expect(
      checkR11(
        "expose.ts",
        "async function expose(k) { createActivity(k, 'exposure'); }",
      ),
    ).toEqual([]);
  });
  test.each([
    [
      "send with a lock first",
      "async function send(k) { await locks.acquire('n'); const a = createActivity(k); }",
    ],
    [
      "expose with another statement first",
      "async function expose(k) { const x = 1; const a = createActivity(k); }",
    ],
    ["no activity at all", "async function send(k) { return 1; }"],
  ])("bad: %s", (_name, source) => {
    expect(rules(checkR11("send.ts", source))).toContain("R11");
  });
  test("an Activity is constructed only in activity.ts", () => {
    expect(
      rules(
        checkActivityConstruction(
          "src/session/kernel/send.ts",
          "const a = new ActivityImpl(k);",
        ),
      ),
    ).toEqual(["R11"]);
    expect(
      checkActivityConstruction(
        "src/session/kernel/activity.ts",
        "const a = new ActivityImpl(k);",
      ),
    ).toEqual([]);
  });
});

describe("R12 send-reads-no-display-state", () => {
  test("good passes", () => {
    expect(
      checkR12(
        "send.ts",
        "async function send(k) { const a = createActivity(k); return k.memory.hasHold(a.account); }",
      ),
    ).toEqual([]);
  });
  test.each([
    ["display", "async function send(k) { if (k.memory.display.kind) {} }"],
    ["displaying", "async function send(k) { const displaying = 1; }"],
    ["mayRender", "async function send(k) { mayRender(k); }"],
    ["renderPermission", "async function send(k) { renderPermission(k); }"],
    ["page.display", "async function send(k) { page.display; }"],
  ])("bad: %s", (_name, source) => {
    expect(rules(checkR12("send.ts", source))).toContain("R12");
  });
});

describe("the real tree", () => {
  test("R7 to R12 pass on the real tree", () => {
    expect(checkTree(ROOT)).toEqual([]);
  });
  test("every function a rule is about really exists (a rename cannot switch a rule off)", () => {
    for (const required of REQUIRED) {
      const present = new Set(
        functionsIn(mask(readFileSync(join(ROOT, required.file), "utf8"))).map(
          (f) => f.name,
        ),
      );
      for (const name of required.names)
        expect(present.has(name), `${required.file}: ${name}`).toBe(true);
    }
  });
  test.each([
    [
      "R7",
      "src/lib/api-client/boundary.ts",
      "step.markIssued();",
      "await Promise.resolve(); step.markIssued();",
    ],
    [
      "R8",
      "src/session/kernel/operations.ts",
      "beginClosing(this.k);",
      "await Promise.resolve(); beginClosing(this.k);",
    ],
    [
      "R9",
      "src/session/kernel/send.ts",
      "const surrendered = surrenderLock(k, inflight, response.status);",
      "await Promise.resolve(); const surrendered = surrenderLock(k, inflight, response.status);",
    ],
    [
      "R10",
      "src/session/kernel/expose.ts",
      "ports.surface.attachTree(a.account, a.epoch);",
      "await Promise.resolve(); ports.surface.attachTree(a.account, a.epoch);",
    ],
    [
      "R11",
      "src/session/kernel/expose.ts",
      'const a = createActivity(k, "exposure", "exposure", account, epoch);',
      'await Promise.resolve(); const a = createActivity(k, "exposure", "exposure", account, epoch);',
    ],
  ])(
    "a one-line edit to the real source is caught: %s",
    (rule, file, from, to) => {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source).toContain(from);
      const dir = mkdtempSync(join(tmpdir(), "conventions-"));
      try {
        for (const path of [
          "src/lib/api-client/boundary.ts",
          "src/session/kernel/operations.ts",
          "src/session/kernel/send.ts",
          "src/session/kernel/expose.ts",
          "src/session/kernel/attempts.ts",
          "src/session/kernel/identity.ts",
        ]) {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(
            join(dir, path),
            path === file
              ? source.replace(from, to)
              : readFileSync(join(ROOT, path), "utf8"),
          );
        }
        const found = checkTree(dir).map((d) => d.rule);
        expect(found).toContain(rule);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("the command", () => {
  afterAll(() => undefined);
  test("exits 0 with a clean message on the real tree", () => {
    const run = spawnSync(
      process.execPath,
      ["scripts/check-session-conventions.mjs"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("R7 to R12: clean");
  });
});
