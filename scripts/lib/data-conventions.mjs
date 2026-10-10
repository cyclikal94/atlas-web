// The data layer's conventions R13 to R18 (plan section 6.3), as a small deterministic checker.
//
// SYNTACTIC, like scripts/lib/session-conventions.mjs, and labelled so: it sees file paths, imports and tokens, not data flow.
// It stops accidents and makes a deliberate evasion visible in review; the runtime suites (the plan inventory, the conformance
// suite, the commit-guard matrix) are the other half. A rule whose subject has gone missing REPORTS THAT, so renaming or moving
// the one file a rule protects can never switch the rule off.
//
//  R13  `indexedDB` / `IDBFactory` only in src/data/store/**, src/session/**, the capability probe and the fixture harness
//  R14  `dexie` and `dexie-react-hooks` only in src/data/store/dexie-adapter.ts and src/data/ui/**; a plan's `read` awaits only
//       `Reader` calls (a macrotask awaited inside a transaction ends it)
//  R15  code outside src/data (and the fixture harness) imports the data layer only through src/data/index.ts
//  R16  `deleteDatabase` only in src/data/store/idb-host.ts (the capability probe's throwaway database is the other, separate
//       use); `pending_deletions` is not referenced in src/data
//  R17  `localStorage` / `sessionStorage` only in src/data/engine/write-failure-marker.ts, within src/data
//  R18  every plan is built by a builder and states its writer and guards (the inventory test compares them with the table)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { mask } from "./session-conventions.mjs";

const norm = (path) => path.split("\\").join("/");

function walk(root, directory, out = []) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return out;
  for (const name of readdirSync(absolute)) {
    const path = join(absolute, name);
    const rel = norm(relative(root, path));
    if (statSync(path).isDirectory()) walk(root, rel, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(rel);
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const at = (rule, path, source, index, message) => ({
  rule,
  path,
  line: lineOf(source, index),
  message,
});

const startsWithAny = (path, prefixes) =>
  prefixes.some((prefix) => path === prefix || path.startsWith(prefix));

/** Every match of `pattern` in the MASKED source (comments and string contents blanked), as diagnostics. */
function find(rule, path, source, pattern, message) {
  const masked = mask(source);
  const found = [];
  for (const match of masked.matchAll(pattern))
    found.push(at(rule, path, source, match.index ?? 0, message));
  return found;
}

// ---- R13 ------------------------------------------------------------------------------------------------------------------
const R13_ALLOWED = [
  "src/data/store/",
  "src/session/",
  "src/app/capabilities.ts",
  "src/fixture/",
];
export function checkR13(path, source) {
  if (startsWithAny(path, R13_ALLOWED)) return [];
  return find(
    "R13",
    path,
    source,
    /\bindexedDB\b|\bIDBFactory\b/g,
    "raw IndexedDB belongs to src/data/store/**, the session and the capability probe; go through the store port",
  );
}

// ---- R14 ------------------------------------------------------------------------------------------------------------------
const R14_ALLOWED = ["src/data/store/dexie-adapter.ts", "src/data/ui/"];
export function checkR14Imports(path, source) {
  if (startsWithAny(path, R14_ALLOWED)) return [];
  const out = [];
  for (const match of source.matchAll(
    /(?:from\s+|import\s*\(\s*|import\s+)["'](dexie|dexie-react-hooks)["']/g,
  ))
    out.push(
      at(
        "R14",
        path,
        source,
        match.index ?? 0,
        `${match[1]} may be imported only by src/data/store/dexie-adapter.ts and src/data/ui/**`,
      ),
    );
  return out;
}

/** Index of the matching closer for the opener at `from`, or -1. */
function closer(s, from) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  let depth = 0;
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === "{" || s[i] === "(" || s[i] === "[") depth += 1;
    else if (s[i] === "}" || s[i] === ")" || s[i] === "]") {
      depth -= 1;
      if (depth === 0) return s[i] === pairs[s[from]] ? i : -1;
    }
  }
  return -1;
}

/**
 * A plan's `read` is `read: async (reader, input) => {...}` or `async read(reader, input) {...}`. Inside it only `Reader` calls
 * (or a helper that is handed the reader) may be awaited: anything else ends the IndexedDB transaction.
 */
export function readBodies(masked) {
  const bodies = [];
  const starts = [
    ...masked.matchAll(/\bread\s*:\s*(?:async\s*)?\(/g),
    ...masked.matchAll(/\basync\s+read\s*\(/g),
    ...masked.matchAll(/\bread\s*\(\s*reader\b[^)]*\)\s*(?::\s*[^{]+)?\{/g),
  ];
  for (const match of starts) {
    const open = masked.indexOf("(", match.index ?? 0);
    const close = closer(masked, open);
    if (close < 0) continue;
    let i = close + 1;
    while (/\s/.test(masked[i] ?? "")) i += 1;
    // optional return type
    if (masked[i] === ":") {
      while (
        i < masked.length &&
        masked[i] !== "{" &&
        !masked.startsWith("=>", i)
      )
        i += 1;
    }
    if (masked.startsWith("=>", i)) {
      i += 2;
      while (/\s/.test(masked[i] ?? "")) i += 1;
      if (masked[i] === "{") {
        const end = closer(masked, i);
        if (end > 0) bodies.push({ text: masked.slice(i, end + 1), start: i });
      } else {
        // An expression body ends at the first top-level `,` or `)` that closes the object it sits in, or a line end `,`.
        let depth = 0;
        let j = i;
        for (; j < masked.length; j += 1) {
          const c = masked[j];
          if (c === "(" || c === "[" || c === "{") depth += 1;
          else if (c === ")" || c === "]" || c === "}") {
            if (depth === 0) break;
            depth -= 1;
          } else if (c === "," && depth === 0) break;
        }
        bodies.push({ text: masked.slice(i, j), start: i });
      }
    } else if (masked[i] === "{") {
      const end = closer(masked, i);
      if (end > 0) bodies.push({ text: masked.slice(i, end + 1), start: i });
    }
  }
  // The same method can match two of the patterns: one body, once.
  const seen = new Set();
  return bodies.filter((body) => {
    if (seen.has(body.start)) return false;
    seen.add(body.start);
    return true;
  });
}

// `await reader.x(...)`, or `await helper(..., reader, ...)` / `await obj.helper(reader, ...)`: the reader is handed to what is awaited.
const READER_AWAIT =
  /\bawait\s+(?:(?:reader|r)\s*\.|[A-Za-z_$][\w$.]*\s*\([^)]*\b(?:reader|r)\b)/y;

export function checkR14Read(path, source) {
  if (!path.startsWith("src/data/plans/")) return [];
  const masked = mask(source);
  const out = [];
  for (const body of readBodies(masked)) {
    for (const match of body.text.matchAll(/\bawait\b/g)) {
      READER_AWAIT.lastIndex = match.index ?? 0;
      if (!READER_AWAIT.test(body.text))
        out.push(
          at(
            "R14",
            path,
            source,
            body.start + (match.index ?? 0),
            "a plan's read may await only Reader calls: any other await can end the transaction",
          ),
        );
    }
  }
  return out;
}

// ---- R15 ------------------------------------------------------------------------------------------------------------------
export function checkR15(path, source) {
  if (path.startsWith("src/data/") || path.startsWith("src/fixture/"))
    return [];
  if (!path.startsWith("src/")) return [];
  const out = [];
  for (const match of source.matchAll(
    /(?:from\s+|import\s*\(\s*)["']((?:\.\.?\/)+data\/[^"']+)["']/g,
  ))
    out.push(
      at(
        "R15",
        path,
        source,
        match.index ?? 0,
        `import the data layer through src/data/index.ts, not ${match[1]}`,
      ),
    );
  return out;
}

// ---- R16 ------------------------------------------------------------------------------------------------------------------
export function checkR16(path, source) {
  if (!path.startsWith("src/data/")) return [];
  const out = [];
  if (path !== "src/data/store/idb-host.ts")
    out.push(
      ...find(
        "R16",
        path,
        source,
        /\bdeleteDatabase\b/g,
        "deleteDatabase belongs to src/data/store/idb-host.ts only",
      ),
    );
  out.push(
    ...find(
      "R16",
      path,
      source,
      /\bpending_deletions\b/g,
      "the deletion ledger is the session's: src/data never references pending_deletions",
    ),
  );
  return out;
}

// ---- R17 ------------------------------------------------------------------------------------------------------------------
export function checkR17(path, source) {
  if (!path.startsWith("src/data/")) return [];
  if (path === "src/data/engine/write-failure-marker.ts") return [];
  return find(
    "R17",
    path,
    source,
    /\blocalStorage\b|\bsessionStorage\b/g,
    "web storage belongs to src/data/engine/write-failure-marker.ts only, and holds no account data",
  );
}

// ---- R18 ------------------------------------------------------------------------------------------------------------------
export function checkR18(path, source) {
  if (!path.startsWith("src/data/plans/")) return [];
  if (path.endsWith("/builders.ts") || path.endsWith("/registry.ts")) return [];
  const masked = mask(source);
  const out = [];
  // Every builder call states its writer and guards.
  for (const match of masked.matchAll(
    /\b(singletonPlan|guardedPlan)\s*(?:<[^()]*>)?\s*\(/g,
  )) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = closer(masked, open);
    const call = source.slice(open, close + 1);
    if (!/\bmeta\s*:\s*\{[^}]*\bwriter\s*:\s*"W\d+"/.test(call))
      out.push(
        at("R18", path, source, open, `${match[1]} needs meta.writer ("W<n>")`),
      );
    if (!/\bmeta\s*:\s*\{[^}]*\bguards\s*:\s*\[/.test(call))
      out.push(at("R18", path, source, open, `${match[1]} needs meta.guards`));
  }
  // No hand-built plan: a Plan literal is made by a builder or registered by registerPlan.
  for (const match of masked.matchAll(/:\s*Plan<[^=]*=\s*\{/g))
    out.push(
      at(
        "R18",
        path,
        source,
        match.index ?? 0,
        "build a plan with singletonPlan/guardedPlan (or registerPlan) so it is in the writer inventory",
      ),
    );
  return out;
}

// ---- subjects that must still exist --------------------------------------------------------------------------------------
export const REQUIRED = [
  {
    rule: "R14",
    file: "src/data/store/dexie-adapter.ts",
    pattern: /from\s+["']dexie["']/,
  },
  {
    rule: "R16",
    file: "src/data/store/idb-host.ts",
    pattern: /\bdeleteDatabase\b/,
  },
  {
    rule: "R17",
    file: "src/data/engine/write-failure-marker.ts",
    pattern: /\blocalStorage\b/,
  },
  {
    rule: "R18",
    file: "src/data/plans/builders.ts",
    pattern: /\bexport function singletonPlan\b/,
  },
  {
    rule: "R18",
    file: "src/data/plans/registry.ts",
    pattern: /\bexport function registerPlan\b/,
  },
  {
    rule: "R15",
    file: "src/data/index.ts",
    pattern: /createDataDeletionPorts/,
  },
];

export const CHECKS = [
  checkR13,
  checkR14Imports,
  checkR14Read,
  checkR15,
  checkR16,
  checkR17,
  checkR18,
];

export function checkTree(root) {
  const diagnostics = [];
  for (const path of walk(root, "src")) {
    const source = readFileSync(join(root, path), "utf8");
    for (const check of CHECKS) diagnostics.push(...check(path, source));
  }
  for (const { rule, file, pattern } of REQUIRED) {
    const full = join(root, file);
    if (!existsSync(full) || !pattern.test(readFileSync(full, "utf8")))
      diagnostics.push({
        rule,
        path: file,
        line: 1,
        message: `the subject of ${rule} is missing from ${file} (${pattern}); a rule must not be switched off by a rename`,
      });
  }
  return diagnostics;
}

export function format(diagnostic) {
  return `${diagnostic.path}:${diagnostic.line}: ${diagnostic.rule}: ${diagnostic.message}`;
}
