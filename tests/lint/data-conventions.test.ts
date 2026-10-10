// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  checkR13,
  checkR14Imports,
  checkR14Read,
  checkR15,
  checkR16,
  checkR17,
  checkR18,
  checkTree,
  readBodies,
} from "../../scripts/lib/data-conventions.mjs";
import { mask } from "../../scripts/lib/session-conventions.mjs";

const ROOT = resolve(__dirname, "../..");
const rules = (d: Array<{ rule: string }>) => d.map((x) => x.rule);

/**
 * F-LINT R13 to R18 (plan 6.3): the data layer's conventions, checked by scripts/check-data-conventions.mjs. SYNTACTIC, like
 * R7 to R12: each rule bites its known-bad snippets, passes its known-good ones, and passes on the real tree; and a rule whose
 * subject has been renamed away REPORTS that, so it can never be switched off by a move.
 */
describe("the real tree", () => {
  test("is clean", () => {
    expect(checkTree(ROOT)).toEqual([]);
  });
});

describe("R13: raw IndexedDB", () => {
  const bad = "const db = indexedDB.open('x');";
  test("is refused outside the store, the session, the capability probe and the fixture harness", () => {
    expect(rules(checkR13("src/data/engine/sync-engine.ts", bad))).toEqual([
      "R13",
    ]);
    expect(
      rules(checkR13("src/features/sync/QueuePanel.tsx", "let f: IDBFactory;")),
    ).toEqual(["R13"]);
    expect(rules(checkR13("src/data/ports/ports-impl.ts", bad))).toEqual([
      "R13",
    ]);
  });
  test("is allowed where the plan says", () => {
    for (const path of [
      "src/data/store/idb-host.ts",
      "src/session/adapters/idb-auth-store.ts",
      "src/app/capabilities.ts",
      "src/fixture/data-harness/main.ts",
    ])
      expect(checkR13(path, bad)).toEqual([]);
  });
  test("a comment or a string that MENTIONS it is not a use", () => {
    expect(
      checkR13(
        "src/data/engine/x.ts",
        "// never indexedDB here\nconst s = 'indexedDB';",
      ),
    ).toEqual([]);
  });
});

describe("R14: Dexie", () => {
  test("is imported only by the adapter and the UI hooks", () => {
    const bad = "import Dexie from 'dexie';";
    expect(
      rules(checkR14Imports("src/data/engine/sync-engine.ts", bad)),
    ).toEqual(["R14"]);
    expect(
      rules(
        checkR14Imports(
          "src/features/sync/QueuePanel.tsx",
          'import { useLiveQuery } from "dexie-react-hooks";',
        ),
      ),
    ).toEqual(["R14"]);
    expect(
      rules(
        checkR14Imports(
          "src/data/engine/x.ts",
          "const d = await import('dexie');",
        ),
      ),
    ).toEqual(["R14"]);
    expect(checkR14Imports("src/data/store/dexie-adapter.ts", bad)).toEqual([]);
    expect(
      checkR14Imports(
        "src/data/ui/hooks.ts",
        'import { useLiveQuery } from "dexie-react-hooks";',
      ),
    ).toEqual([]);
  });

  const plan = (read: string) =>
    `export const p = singletonPlan({ name: "x", meta: { writer: "W10", guards: ["INC"], quota: null }, scope: [], durability: "strict", ${read} decide: () => ({ result: 1 }) });`;
  test("a read that awaits only Reader calls passes", () => {
    expect(
      checkR14Read(
        "src/data/plans/x.ts",
        plan(
          "read: async (reader) => { const a = await reader.get('sync_state', 'singleton'); return await helper(reader, a); },",
        ),
      ),
    ).toEqual([]);
    expect(
      checkR14Read(
        "src/data/plans/x.ts",
        plan("read: (reader) => reader.list('drafts'),"),
      ),
    ).toEqual([]);
    expect(
      checkR14Read(
        "src/data/plans/x.ts",
        plan(
          "read: async (reader, input) => ({ a: await spec.read(reader, input) }),",
        ),
      ),
    ).toEqual([]);
  });
  test("a read that awaits anything else is refused (it can end the transaction)", () => {
    expect(
      rules(
        checkR14Read(
          "src/data/plans/x.ts",
          plan("read: async (reader) => { await fetch('/x'); return null; },"),
        ),
      ),
    ).toEqual(["R14"]);
    expect(
      rules(
        checkR14Read(
          "src/data/plans/x.ts",
          plan(
            "read: async (reader) => { await new Promise((r) => setTimeout(r, 1)); return null; },",
          ),
        ),
      ),
    ).toEqual(["R14"]);
    expect(
      rules(
        checkR14Read(
          "src/data/plans/x.ts",
          plan(
            "read: async (reader) => { const x = await crypto.subtle.digest('SHA-256', b); return x; },",
          ),
        ),
      ),
    ).toEqual(["R14"]);
  });
  test("an await OUTSIDE a read is not this rule's business", () => {
    expect(
      checkR14Read(
        "src/data/plans/x.ts",
        "async function helper() { await fetch('/x'); }",
      ),
    ).toEqual([]);
  });
  test("the finder sees arrow properties, async methods and expression bodies", () => {
    const masked = mask(
      "const a = { read: async (reader) => { x; }, }; class C { async read(reader: R) { y; } } const b = { read: (reader) => reader.get() };",
    );
    expect(readBodies(masked)).toHaveLength(3);
  });
});

describe("R15: the public path", () => {
  test("code outside src/data imports it only through its index", () => {
    expect(
      rules(
        checkR15(
          "src/app/boot.tsx",
          'import { x } from "../data/ports/deletion-ports";',
        ),
      ),
    ).toEqual(["R15"]);
    expect(
      rules(
        checkR15(
          "src/features/sync/QueuePanel.tsx",
          "import { x } from '../../data/model/types';",
        ),
      ),
    ).toEqual(["R15"]);
    expect(
      checkR15(
        "src/app/boot.tsx",
        'import { createDataDeletionPorts } from "../data";',
      ),
    ).toEqual([]);
    expect(
      checkR15("src/data/engine/a.ts", "import { x } from '../model/types';"),
    ).toEqual([]);
    expect(
      checkR15(
        "src/fixture/data-harness/main.ts",
        "import { x } from '../../data/model/schema';",
      ),
    ).toEqual([]);
  });
});

describe("R16: deleting databases and the ledger", () => {
  test("deleteDatabase is the host's alone", () => {
    expect(
      rules(
        checkR16(
          "src/data/ports/account-database.ts",
          "indexedDB.deleteDatabase(n);",
        ),
      ),
    ).toEqual(["R16"]);
    expect(
      checkR16("src/data/store/idb-host.ts", "factory.deleteDatabase(name);"),
    ).toEqual([]);
  });
  test("the data layer never touches the session's pending_deletions", () => {
    expect(
      rules(checkR16("src/data/ports/x.ts", "records.pending_deletions[a]")),
    ).toEqual(["R16"]);
  });
  test("outside src/data it is not this rule's (F-BND-3 lists the other permitted files)", () => {
    expect(
      checkR16("src/app/capabilities.ts", "indexedDB.deleteDatabase(n);"),
    ).toEqual([]);
  });
});

describe("R17: web storage", () => {
  test("only the marker module", () => {
    expect(
      rules(
        checkR17(
          "src/data/engine/sync-engine.ts",
          "localStorage.setItem('a','b');",
        ),
      ),
    ).toEqual(["R17"]);
    expect(
      rules(checkR17("src/data/ui/hooks.ts", "sessionStorage.getItem('a')")),
    ).toEqual(["R17"]);
    expect(
      checkR17(
        "src/data/engine/write-failure-marker.ts",
        "localStorage.setItem('a','1');",
      ),
    ).toEqual([]);
  });
});

describe("R18: every plan states its writer and guards", () => {
  const good = `export const a = singletonPlan({ name: "n", meta: { writer: "W10", guards: ["INC"], quota: null }, scope: [], durability: "strict", read: async () => null, decide: () => ({ result: 1 }) });`;
  test("a builder call with meta.writer and meta.guards passes", () => {
    expect(checkR18("src/data/plans/fence.ts", good)).toEqual([]);
    expect(
      checkR18(
        "src/data/plans/x.ts",
        good.replace("singletonPlan", "guardedPlan<Q, R, O>"),
      ),
    ).toEqual([]);
  });
  test("a missing writer or guard list is refused", () => {
    expect(
      rules(
        checkR18("src/data/plans/x.ts", good.replace('writer: "W10", ', "")),
      ),
    ).toEqual(["R18"]);
    expect(
      rules(
        checkR18("src/data/plans/x.ts", good.replace('guards: ["INC"], ', "")),
      ),
    ).toEqual(["R18"]);
    expect(
      rules(
        checkR18(
          "src/data/plans/x.ts",
          good.replace('writer: "W10"', 'writer: "x"'),
        ),
      ),
    ).toEqual(["R18"]);
  });
  test("a hand-built Plan literal is refused", () => {
    expect(
      rules(
        checkR18(
          "src/data/plans/x.ts",
          "export const p: Plan<A, B, C> = { name: 'x', scope: [], mode: 'readwrite' };",
        ),
      ),
    ).toEqual(["R18"]);
  });
  test("the builders and the registry define the mechanism and are exempt", () => {
    expect(
      checkR18(
        "src/data/plans/builders.ts",
        "const plan: Plan<I, R, O> = { name: spec.name };",
      ),
    ).toEqual([]);
  });
});

describe("a rule whose subject has been renamed away says so", () => {
  const copies: string[] = [];
  afterAll(() => {
    for (const dir of copies) rmSync(dir, { recursive: true, force: true });
  });
  function copyTree(): string {
    const dir = mkdtempSync(join(tmpdir(), "atlas-data-conv-"));
    copies.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    cpSync(join(ROOT, "src/data"), join(dir, "src/data"), { recursive: true });
    return dir;
  }
  for (const [rule, file] of [
    ["R16", "src/data/store/idb-host.ts"],
    ["R17", "src/data/engine/write-failure-marker.ts"],
    ["R14", "src/data/store/dexie-adapter.ts"],
    ["R18", "src/data/plans/builders.ts"],
  ] as const) {
    test(`${rule}: moving ${file} is reported`, () => {
      const dir = copyTree();
      renameSync(join(dir, file), join(dir, `${file}.moved`));
      const found = checkTree(dir).filter((d) => d.path === file);
      expect(found.map((d) => d.rule)).toContain(rule);
    });
  }
});
