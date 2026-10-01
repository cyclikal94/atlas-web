// The session module's conventions R7 to R12 (plan section 9), as a small deterministic checker.
//
// WHY A SCRIPT AND NOT GRITQL. The spike (.agtx/evidence/WEB-08a/lint/spike.md) showed biome 2.5.14's GritQL can match a named
// function declaration and its first statement, but cannot match a class method by name, cannot say that one statement
// PRECEDES another, and cannot count ("exactly one call of fetch"). The plan's fallback applies: a dependency-free
// check, labelled SYNTACTIC. It sees names, braces and tokens, not data flow: it stops accidents and makes a deliberate
// evasion visible in review; the runtime suites (surrender order, closing writes, act) are the other half.
//
// A rule that cannot find the function it is about REPORTS THAT, so renaming a function can never switch a rule off.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** `text` with comments removed and the CONTENTS of strings, templates and regex literals blanked; same length, same lines. */
export function mask(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  const regexPrefix =
    /[(,=:[!&|?{};+\-*%<>~^]$|^$|\b(?:return|typeof|case|in|of|delete|void|throw|new)$/;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j += 1;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j += 1;
      out += blank(text.slice(i, j + 2));
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      out += c + blank(text.slice(i + 1, j)) + (text[j] ?? "");
      i = j + 1;
      continue;
    }
    if (c === "/" && regexPrefix.test(out.trimEnd().slice(-10))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && (text[j] !== "/" || inClass) && text[j] !== "\n") {
        if (text[j] === "\\") j += 1;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        j += 1;
      }
      out += `/${blank(text.slice(i + 1, j))}/`;
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const matching = (s, open, from) => {
  const close = { "(": ")", "{": "}", "[": "]" }[open];
  let depth = 0;
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === open) depth += 1;
    else if (s[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** From just after a parameter list's `)`: skip an optional return type; return the index of the body's `{`, or -1. */
function bodyStart(s, from) {
  let i = from;
  while (/\s/.test(s[i] ?? "")) i += 1;
  if (s[i] === "{") return i;
  if (s[i] !== ":") return -1;
  i += 1;
  let angle = 0;
  let prev = ":";
  for (; i < s.length; i += 1) {
    const c = s[i];
    if (/\s/.test(c)) continue;
    if (c === "<") angle += 1;
    else if (c === ">" && s[i - 1] !== "=") angle -= 1;
    else if (c === "{") {
      // A type literal follows `: | & < , ( =>` or sits inside angle brackets; otherwise this is the body.
      if (
        angle > 0 ||
        /[:|&<,(]/.test(prev) ||
        (prev === ">" && s[i - 2] === "=")
      ) {
        i = matching(s, "{", i);
        if (i < 0) return -1;
        prev = "}";
        continue;
      }
      return i;
    } else if (c === "(") {
      i = matching(s, "(", i);
      if (i < 0) return -1;
      prev = ")";
      continue;
    } else if (c === ";" || c === "=") {
      if (c === "=" && s[i + 1] === ">") {
        prev = ">";
        i += 1;
        continue;
      }
      return -1;
    }
    prev = c;
  }
  return -1;
}

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "typeof",
  "await",
  "new",
  "super",
  "void",
  "delete",
]);

/**
 * Every function-like declaration in `masked` (function declarations and class/object methods; arrow functions are not
 * named declarations and are out of scope). `{ name, start, bodyOpen, bodyClose, line }`.
 */
export function functionsIn(masked) {
  const found = [];
  const re = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*([(<])/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    let open = m.index + m[0].length - 1;
    if (masked[open] === "<") {
      // Type parameters: balance the angle brackets (bounded; a type parameter list holds no parentheses of a call).
      let depth = 0;
      let i = open;
      for (; i < Math.min(masked.length, open + 240); i += 1) {
        if (masked[i] === "<") depth += 1;
        else if (masked[i] === ">" && masked[i - 1] !== "=") {
          depth -= 1;
          if (depth === 0) break;
        } else if (";{}".includes(masked[i])) {
          i = -1;
          break;
        }
      }
      if (i < 0 || depth !== 0) continue;
      const after = /^\s*\(/.exec(masked.slice(i + 1));
      if (!after) continue;
      open = i + after[0].length;
    }
    const close = matching(masked, "(", open);
    if (close < 0) continue;
    const body = bodyStart(masked, close + 1);
    if (body < 0) continue;
    const end = matching(masked, "{", body);
    if (end < 0) continue;
    found.push({
      name,
      start: m.index,
      bodyOpen: body,
      bodyClose: end,
      line: masked.slice(0, m.index).split("\n").length,
    });
  }
  return found;
}

/** The first statement of a body: text up to the first top-level `;` or the end of a leading block statement. */
export function firstStatements(body, count = 1) {
  const out = [];
  let i = 0;
  const s = body;
  for (let k = 0; k < count; k += 1) {
    while (/\s/.test(s[i] ?? "")) i += 1;
    const start = i;
    let depth = 0;
    for (; i < s.length; i += 1) {
      const c = s[i];
      if ("({[".includes(c)) depth += 1;
      else if (")}]".includes(c)) {
        depth -= 1;
        if (
          depth === 0 &&
          c === "}" &&
          /^(?:try|if|for|while|switch)\b/.test(
            s.slice(start, start + 6).trim(),
          )
        ) {
          // a compound statement ends at its closing brace (an `else`/`catch`/`finally` continues it)
          const rest = s.slice(i + 1).match(/^\s*(else|catch|finally)\b/);
          if (!rest) {
            i += 1;
            break;
          }
        }
      } else if (c === ";" && depth === 0) {
        i += 1;
        break;
      }
    }
    out.push(s.slice(start, i).trim());
  }
  return out;
}

const bodyOf = (masked, fn) => masked.slice(fn.bodyOpen + 1, fn.bodyClose);
const lineOf = (masked, index) => masked.slice(0, index).split("\n").length;
const diag = (rule, path, line, message) => ({ rule, path, line, message });

// ---- the rules ----------------------------------------------------------------------------------------------------

/** R7 send-boundary: src/lib/api-client/boundary.ts */
export function checkR7(path, source) {
  const masked = mask(source);
  const out = [];
  const issue = functionsIn(masked).find((fn) => fn.name === "issue");
  if (!issue)
    return [
      diag(
        "R7",
        path,
        1,
        "R7 send-boundary: the function `issue` was not found, so the boundary cannot be checked",
      ),
    ];
  const body = bodyOf(masked, issue);
  const at = (index, message) =>
    out.push(
      diag("R7", path, lineOf(masked, issue.bodyOpen + 1 + index), message),
    );
  for (const [pattern, what] of [
    [/\bawait\b/, "an `await`"],
    [/\.then\s*\(/, "a `.then`"],
    [/\blocks\s*\./, "a call on `locks`"],
    [/\bstore\s*\./, "a call on `store`"],
    [/\bread\s*\(/, "a `read(` call"],
  ]) {
    const hit = pattern.exec(body);
    if (hit)
      at(
        hit.index,
        `R7 send-boundary: \`issue\` must be one synchronous step; it contains ${what}`,
      );
  }
  const calls = [...masked.matchAll(/(?<![\w$.])fetch\s*\(/g)];
  if (calls.length !== 1)
    out.push(
      diag(
        "R7",
        path,
        1,
        `R7 send-boundary: boundary.ts must contain exactly one call of fetch, found ${calls.length}`,
      ),
    );
  const tryAt = body.search(/\btry\s*\{/);
  if (tryAt < 0) {
    at(
      0,
      "R7 send-boundary: `issue` must issue inside a `try` whose `finally` releases the issue lock",
    );
    return out;
  }
  const tryOpen = body.indexOf("{", tryAt);
  const tryClose = matching(body, "{", tryOpen);
  const finallyMatch = /^\s*finally\s*\{/.exec(body.slice(tryClose + 1));
  if (!finallyMatch)
    at(tryAt, "R7 send-boundary: the `try` in `issue` has no `finally`");
  else {
    const finOpen = tryClose + 1 + finallyMatch[0].length - 1;
    const finClose = matching(body, "{", finOpen);
    if (!/\breleaseIssueLock\s*\(/.test(body.slice(finOpen, finClose)))
      at(
        finOpen,
        "R7 send-boundary: the `finally` in `issue` must call `releaseIssueLock`",
      );
  }
  for (const call of calls) {
    const inBody = call.index > issue.bodyOpen && call.index < issue.bodyClose;
    const rel = call.index - issue.bodyOpen - 1;
    if (!inBody || rel < tryOpen || rel > tryClose)
      out.push(
        diag(
          "R7",
          path,
          lineOf(masked, call.index),
          "R7 send-boundary: the call of fetch must be inside the `try` of `issue`",
        ),
      );
  }
  const guard = body.search(/\brefuses\s*\(/);
  if (guard < 0 || guard > tryAt)
    at(
      tryAt,
      "R7 send-boundary: the guard `step.refuses(` must precede the `try` in `issue`",
    );
  return out;
}

/** R8 closing-write-first: every `…ClosingWrite` begins with `beginClosing(`; every call of it is such a first statement. */
export function checkR8(path, source) {
  const masked = mask(source);
  const out = [];
  const fns = functionsIn(masked);
  for (const fn of fns.filter((f) => /ClosingWrite$/.test(f.name))) {
    const [first] = firstStatements(bodyOf(masked, fn));
    if (!/^beginClosing\s*\(/.test(first ?? ""))
      out.push(
        diag(
          "R8",
          path,
          fn.line,
          `R8 closing-write-first: the first statement of \`${fn.name}\` must be a call of beginClosing()`,
        ),
      );
  }
  for (const call of masked.matchAll(/(?<![\w$.])beginClosing\s*\(/g)) {
    const inside = fns
      .filter((f) => call.index > f.bodyOpen && call.index < f.bodyClose)
      .sort((a, b) => b.bodyOpen - a.bodyOpen)[0];
    const definition = /function\s+$/.test(masked.slice(0, call.index));
    if (definition) continue;
    if (!inside || !/ClosingWrite$/.test(inside.name))
      out.push(
        diag(
          "R8",
          path,
          lineOf(masked, call.index),
          "R8 closing-write-first: beginClosing() may be called only by a function named `…ClosingWrite`, as its first statement",
        ),
      );
  }
  return out;
}

/** R9 surrender-first: every `handle…Answer` begins `surrenderLock(` then `detectInvalidation(`, with nothing awaited or read between. */
export function checkR9(path, source) {
  const masked = mask(source);
  const out = [];
  const fns = functionsIn(masked);
  for (const fn of fns.filter((f) => /^handle\w*Answer$/.test(f.name))) {
    const [first, second] = firstStatements(bodyOf(masked, fn), 2);
    if (!/\bsurrenderLock\s*\(/.test(first ?? ""))
      out.push(
        diag(
          "R9",
          path,
          fn.line,
          `R9 surrender-first: the first statement of \`${fn.name}\` must call surrenderLock()`,
        ),
      );
    if (!/\bdetectInvalidation\s*\(/.test(second ?? ""))
      out.push(
        diag(
          "R9",
          path,
          fn.line,
          `R9 surrender-first: the second statement of \`${fn.name}\` must call detectInvalidation()`,
        ),
      );
    const head = `${first ?? ""} ${second ?? ""}`;
    if (
      /\bawait\b|\.text\s*\(|\.json\s*\(|\.clone\s*\(|\bstore\s*\.|\btransact\s*\(|\blocks\s*\.\s*acquire|\.acquire\s*\(/.test(
        head,
      )
    )
      out.push(
        diag(
          "R9",
          path,
          fn.line,
          `R9 surrender-first: nothing may be awaited, read or stored before the surrender and the hold in \`${fn.name}\``,
        ),
      );
  }
  for (const call of masked.matchAll(/(?<![\w$.])surrenderLock\s*\(/g)) {
    const inside = fns
      .filter((f) => call.index > f.bodyOpen && call.index < f.bodyClose)
      .sort((a, b) => b.bodyOpen - a.bodyOpen)[0];
    if (/function\s+$/.test(masked.slice(0, call.index))) continue;
    if (!inside || !/^handle\w*Answer$/.test(inside.name))
      out.push(
        diag(
          "R9",
          path,
          lineOf(masked, call.index),
          "R9 surrender-first: surrenderLock() may be called only by a `handle…Answer` function",
        ),
      );
  }
  return out;
}

/** R10 act-is-synchronous: `act` awaits and reads nothing, and only `act` reaches the surface's attachTree. */
export function checkR10(path, source) {
  const masked = mask(source);
  const out = [];
  const fns = functionsIn(masked);
  const act = fns.filter((f) => f.name === "act");
  for (const fn of act) {
    const body = bodyOf(masked, fn);
    const hit =
      /\bawait\b/.exec(body) ??
      /\.then\s*\(/.exec(body) ??
      /(?<![\w$])(?:transact|acquire|wait|probe|getItem|read)\s*\(/.exec(
        body,
      ) ??
      /\bstore\s*\./.exec(body) ??
      /\.(?:transact|acquire|wait|probe|getItem|read)\s*\(/.exec(body);
    if (hit)
      out.push(
        diag(
          "R10",
          path,
          lineOf(masked, fn.bodyOpen + 1 + hit.index),
          `R10 act-is-synchronous: \`act\` must not await or read (found \`${hit[0].trim()}\`)`,
        ),
      );
  }
  // The port declares `attachTree` and the surface adapter defines it; every other reference must be inside `act`.
  const definesIt =
    /(?:^|\/)(?:adapters\/protected-surface|ports\/surface)\.ts$/.test(path);
  for (const use of definesIt ? [] : masked.matchAll(/\battachTree\b/g)) {
    const inside = fns
      .filter((f) => use.index > f.bodyOpen && use.index < f.bodyClose)
      .sort((a, b) => b.bodyOpen - a.bodyOpen)[0];
    if (inside?.name !== "act")
      out.push(
        diag(
          "R10",
          path,
          lineOf(masked, use.index),
          "R10 act-is-synchronous: attachTree may be referenced only from `act`",
        ),
      );
  }
  return out;
}

/** R11 activity-first: `send` and `expose` create their activity first; only activity.ts constructs one. */
export function checkR11(path, source) {
  const masked = mask(source);
  const out = [];
  for (const fn of functionsIn(masked).filter(
    (f) => f.name === "send" || f.name === "expose",
  )) {
    const [first] = firstStatements(bodyOf(masked, fn));
    if (
      !/^(?:(?:const|let)\s+[\w$]+\s*=\s*)?createActivity\s*\(/.test(
        first ?? "",
      )
    )
      out.push(
        diag(
          "R11",
          path,
          fn.line,
          `R11 activity-first: the first statement of \`${fn.name}\` must create its activity with createActivity()`,
        ),
      );
  }
  return out;
}

/** R12 send-reads-no-display-state: `send` consults nothing about what is displayed. */
export function checkR12(path, source) {
  const masked = mask(source);
  const out = [];
  for (const fn of functionsIn(masked).filter((f) => f.name === "send")) {
    const body = bodyOf(masked, fn);
    const hit =
      /\b(?:display|displaying|mayRender|renderPermission)\b|\bpage\s*\.\s*display\b/.exec(
        body,
      );
    if (hit)
      out.push(
        diag(
          "R12",
          path,
          lineOf(masked, fn.bodyOpen + 1 + hit.index),
          `R12 send-reads-no-display-state: \`send\` must not read display state (found \`${hit[0]}\`)`,
        ),
      );
  }
  return out;
}

/** "Nothing else constructs an Activity" (R11): `new ActivityImpl(` only in activity.ts. */
export function checkActivityConstruction(path, source) {
  if (/(?:^|\/)activity\.ts$/.test(path)) return [];
  const masked = mask(source);
  return [...masked.matchAll(/\bnew\s+ActivityImpl\s*\(/g)].map((m) =>
    diag(
      "R11",
      path,
      lineOf(masked, m.index),
      "R11 activity-first: an Activity is constructed only by createActivity() in activity.ts",
    ),
  );
}

// ---- the tree -----------------------------------------------------------------------------------------------------

/** The rules and the files each applies to, as repository-relative paths or directory prefixes. */
export const SCOPES = [
  { rule: "R7", check: checkR7, files: ["src/lib/api-client/boundary.ts"] },
  { rule: "R8", check: checkR8, files: ["src/session/kernel/"] },
  { rule: "R9", check: checkR9, files: ["src/session/kernel/"] },
  { rule: "R10", check: checkR10, files: ["src/session/"] },
  { rule: "R11", check: checkR11, files: ["src/session/kernel/"] },
  { rule: "R11", check: checkActivityConstruction, files: ["src/session/"] },
  { rule: "R12", check: checkR12, files: ["src/session/kernel/send.ts"] },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Functions that MUST exist for a rule to mean something (a renamed function cannot switch its rule off). */
export const REQUIRED = [
  { rule: "R7", file: "src/lib/api-client/boundary.ts", names: ["issue"] },
  {
    rule: "R8",
    file: "src/session/kernel/attempts.ts",
    names: ["activatingClosingWrite", "settlementClosingWrite"],
  },
  {
    rule: "R8",
    file: "src/session/kernel/operations.ts",
    names: ["operationFenceClosingWrite"],
  },
  {
    rule: "R9",
    file: "src/session/kernel/send.ts",
    names: ["handleOrdinaryAnswer"],
  },
  {
    rule: "R9",
    file: "src/session/kernel/identity.ts",
    names: ["handleIdentityAnswer"],
  },
  {
    rule: "R9",
    file: "src/session/kernel/operations.ts",
    names: ["handleOperationAnswer"],
  },
  { rule: "R10", file: "src/session/kernel/expose.ts", names: ["act"] },
  { rule: "R11", file: "src/session/kernel/send.ts", names: ["send"] },
  { rule: "R11", file: "src/session/kernel/expose.ts", names: ["expose"] },
  { rule: "R12", file: "src/session/kernel/send.ts", names: ["send"] },
];

export function checkTree(root) {
  const diagnostics = [];
  const files = new Map();
  const read = (path) => {
    if (!files.has(path))
      files.set(path, readFileSync(join(root, path), "utf8"));
    return files.get(path);
  };
  for (const scope of SCOPES) {
    for (const prefix of scope.files) {
      const full = join(root, prefix);
      if (!existsSync(full)) {
        diagnostics.push(
          diag(
            scope.rule,
            prefix,
            1,
            `${scope.rule}: ${prefix} does not exist, so the rule cannot be checked`,
          ),
        );
        continue;
      }
      const list = statSync(full).isDirectory()
        ? walk(full).map((p) => relative(root, p))
        : [prefix];
      for (const path of list.sort())
        diagnostics.push(...scope.check(path, read(path)));
    }
  }
  for (const required of REQUIRED) {
    if (!existsSync(join(root, required.file))) continue;
    const present = new Set(
      functionsIn(mask(read(required.file))).map((f) => f.name),
    );
    for (const name of required.names)
      if (!present.has(name))
        diagnostics.push(
          diag(
            required.rule,
            required.file,
            1,
            `${required.rule}: the function \`${name}\` was not found in ${required.file}, so the rule cannot be checked`,
          ),
        );
  }
  return diagnostics;
}

export const format = (d) => `${d.path}:${d.line} ${d.message}`;
