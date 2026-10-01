// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  code,
  filesMatching,
  filesUnder,
  imports,
  ROOT,
  rel,
  resolveImport,
  stripComments,
} from "../support/session/source-scan";

/**
 * F-BND (plan 13.6): source scans and the public-interface boundary. These see syntax, not data flow, and say so; the
 * lint rules R1 to R12 and the runtime suites are the other halves. Comments are excluded, so a sentence that MENTIONS
 * `localStorage` (to say it is not used) is not a use.
 */
const STORAGE = /localStorage|sessionStorage|document\s*\.\s*cookie/;
const LOCKS_QUERY = /locks\s*\.\s*query|\bsteal\b/;
const FETCH_CALL = /\bfetch\s*\(/;
const KERNEL_GLOBALS =
  /\b(document|window|navigator|indexedDB|localStorage|BroadcastChannel|MessageChannel|location)\b|\bfetch\s*\(/;
const MODEL_GLOBALS =
  /\b(document|window|navigator|indexedDB|fetch|setTimeout|Date\s*\.\s*now|Math\s*\.\s*random|crypto)\b/;

describe("the scans are not vacuous: each pattern matches its known-bad snippet", () => {
  const bad: Array<[string, RegExp, string]> = [
    ["storage", STORAGE, 'const x = localStorage.getItem("a");'],
    ["storage", STORAGE, "document . cookie = 1"],
    ["locks", LOCKS_QUERY, "await navigator.locks.query()"],
    [
      "locks",
      LOCKS_QUERY,
      "locks.request(n, { steal: true }, f); const steal = 1",
    ],
    ["fetch", FETCH_CALL, "return fetch(request)"],
    ["kernel", KERNEL_GLOBALS, "document.title = 'x'"],
    ["kernel", KERNEL_GLOBALS, "await fetch (url)"],
    ["model", MODEL_GLOBALS, "const t = Date.now()"],
  ];
  for (const [name, pattern, snippet] of bad)
    test(`${name}: ${snippet}`, () => {
      expect(pattern.test(snippet)).toBe(true);
    });
  test("a comment that mentions localStorage is not a use", () => {
    expect(
      STORAGE.test(
        stripComments(
          "// never localStorage\n/* sessionStorage */ const a = 1;",
        ),
      ),
    ).toBe(false);
  });
});

describe("F-BND-1: the session's single store of truth (D-13)", () => {
  test("no localStorage, sessionStorage or document.cookie in src/session or src/lib/api-client", () => {
    for (const directory of ["src/session", "src/lib/api-client"])
      expect(filesMatching(directory, STORAGE), directory).toEqual([]);
  });
});

describe("F-BND-2: Web Locks are used only as the protocol allows", () => {
  test("no locks.query and no steal anywhere in src", () => {
    expect(filesMatching("src", LOCKS_QUERY)).toEqual([]);
  });
});

describe("F-BND-3: deletion lives in the wipe procedure and its ports", () => {
  test("deleteDatabase is not used by the session at all (the account database is the port's, WEB-09a's)", () => {
    expect(filesMatching("src/session", /deleteDatabase/)).toEqual([]);
    // The only other use in src is the capability probe's own throwaway database.
    expect(filesMatching("src", /deleteDatabase/)).toEqual([
      "src/app/capabilities.ts",
    ]);
  });

  test("pending_deletions appears only in the ledger, its record types and reducers, the store adapter and the consent read", () => {
    expect(filesMatching("src", /pending_deletions/)).toEqual([
      "src/session/adapters/deletion-ledger.ts",
      "src/session/adapters/idb-auth-store.ts",
      "src/session/kernel/evaluate.ts",
      "src/session/model/records.ts",
      "src/session/model/reducers/misc.ts",
      "src/session/model/types.ts",
    ]);
  });
});

describe("F-BND-4: the public-interface boundary", () => {
  test("nothing outside src/session imports a src/session path other than its index", () => {
    const offenders: string[] = [];
    for (const file of filesUnder("src")) {
      if (rel(file).startsWith("src/session/")) continue;
      for (const { from } of imports(file)) {
        const target = resolveImport(file, from);
        if (!target?.startsWith("src/session/")) continue;
        if (target !== "src/session/index")
          offenders.push(`${rel(file)} -> ${from}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("src/lib/api-client never imports src/session", () => {
    const offenders: string[] = [];
    for (const file of filesUnder("src/lib/api-client"))
      for (const { from } of imports(file))
        if (resolveImport(file, from)?.startsWith("src/session"))
          offenders.push(rel(file));
    expect(offenders).toEqual([]);
  });

  test("the kernel imports model, ports and the pure problem recogniser and wire helpers only; it touches no browser global", () => {
    const allowed = [
      /^src\/session\/(model|ports|kernel)\//,
      /^src\/session\/(constants|api)$/,
      /^src\/lib\/api-client\/(problem|wire)$/,
    ];
    for (const file of filesUnder("src/session/kernel")) {
      for (const { from, typeOnly } of imports(file)) {
        if (!from.startsWith("."))
          throw new Error(`${rel(file)} imports a package: ${from}`);
        const target = resolveImport(file, from) as string;
        // The kernel's types come from api.ts (which imports api-client types); type imports of the client are fine.
        if (typeOnly && target.startsWith("src/lib/api-client")) continue;
        expect(
          allowed.some((pattern) => pattern.test(target)),
          `${rel(file)} -> ${from}`,
        ).toBe(true);
      }
      expect(code(file), rel(file)).not.toMatch(KERNEL_GLOBALS);
    }
  });

  test("the model is pure: type-only imports from ports/store and app/capabilities, nothing else, no I/O", () => {
    for (const file of filesUnder("src/session/model")) {
      for (const { from, typeOnly } of imports(file)) {
        if (from.startsWith("./") || from.startsWith("../")) {
          const target = resolveImport(file, from) as string;
          if (
            target.startsWith("src/session/model/") ||
            target === "src/session/model"
          )
            continue;
          expect(typeOnly, `${rel(file)} -> ${from}`).toBe(true);
          expect(
            ["src/session/ports/store", "src/app/capabilities"],
            `${rel(file)}`,
          ).toContain(target);
        } else throw new Error(`${rel(file)} imports a package: ${from}`);
      }
      expect(code(file), rel(file)).not.toMatch(MODEL_GLOBALS);
    }
  });
});

describe("F-BND-5: the network and the gate have one door each", () => {
  test("fetch( appears only in boundary.ts and unstamped.ts", () => {
    expect(filesMatching("src", FETCH_CALL)).toEqual([
      "src/lib/api-client/boundary.ts",
      "src/lib/api-client/unstamped.ts",
    ]);
  });

  test("attachTree is referenced only by the port, the surface adapter and act", () => {
    expect(filesMatching("src", /attachTree/)).toEqual([
      "src/session/adapters/protected-surface.ts",
      "src/session/kernel/expose.ts",
      "src/session/ports/surface.ts",
    ]);
    const expose = code("src/session/kernel/expose.ts");
    // Within expose.ts the only call is inside `act` (which ends before the next exported declaration).
    const actBody = expose.slice(
      expose.indexOf("export function act"),
      expose.indexOf("function isCancelled"),
    );
    expect(actBody).toMatch(/attachTree/);
    expect(expose.replace(actBody, "")).not.toMatch(/attachTree/);
  });

  test("the gate primitives are imported only by the surface adapter (and the fixture entry)", () => {
    const importers = filesUnder("src")
      .filter((file) =>
        imports(file).some((i) => /protected-surface\/gate$/.test(i.from)),
      )
      .map(rel);
    expect(importers).toEqual([
      "src/fixture/main.tsx",
      "src/session/adapters/protected-surface.ts",
    ]);
  });

  test("the send boundary is the only place a stamped request is issued", () => {
    // boundary.ts holds one fetch call, inside `issue`, guarded and released in one synchronous step.
    const boundary = code("src/lib/api-client/boundary.ts");
    expect(boundary.match(new RegExp(FETCH_CALL.source, "g"))).toHaveLength(1);
    expect(boundary).not.toMatch(/\bawait\b/);
  });
});

describe("F-BND-6: the fixture harness stays out of the product", () => {
  test("nothing in the session module or the production entry mentions the fixture hooks", () => {
    for (const directory of ["src/session", "src/app", "src/lib"])
      expect(
        filesMatching(directory, /__atlasFixture|ATLAS_FIXTURE_ONLY/),
        directory,
      ).toEqual([]);
    expect(readFileSync(`${ROOT}/src/main.tsx`, "utf8")).not.toMatch(
      /__atlasFixture|ATLAS_FIXTURE_ONLY/,
    );
  });
});
