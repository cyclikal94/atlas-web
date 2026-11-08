/**
 * WEB-13b revision 15 (review 16 R13): how much text a synchronous call reads or writes, counted in code units. While `metered` runs
 * its callback, the built-in string, regular-expression, array-join and text-encoding methods are wrapped, and each call adds the most
 * it can touch given its arguments and answer:
 *
 *  - `charCodeAt`, `charAt`, `codePointAt`, `at`: 1;
 *  - `indexOf` / `includes`: from its start to the end of the match, or to the end of the text when there is none (at least 1);
 *    `lastIndexOf` the same backwards;
 *  - `startsWith` / `endsWith`: the searched length + 1;
 *  - anything that returns part of the text (`slice`, `substring`, `substr`): that part's length + 1;
 *  - any other string method (`split`, `toUpperCase`, `trim`, `replace`, `match`, …): the text's length + the length of a string answer + 1;
 *  - `RegExp` `exec`/`test`, `Array.prototype.join`, `TextEncoder.encode`: the input's (or joined result's) length + 1.
 *
 * Indexed access (`text[i]`), `.length` and operators cannot be wrapped, so they are not counted: the meter bounds the work done
 * through the methods above, nothing else. Past `limit` the wrapped call throws `WorkExceeded` at once, so a quadratic implementation is
 * stopped (and reported by an assertion) instead of running for seconds; below it every wrapper returns exactly the original's answer.
 * The wrappers are removed before `metered` returns, whatever happens. No test runner is imported.
 */
export class WorkExceeded extends Error {
  readonly work: number;
  constructor(work: number) {
    super(`more than the allowed work (${work} code units)`);
    this.work = work;
  }
}

type Span = (self: unknown, args: unknown[], answer: unknown) => number;

const length = (value: unknown): number =>
  typeof value === "string" ? value.length : 0;
const start = (value: unknown, fallback: number, size: number): number => {
  const n = value === undefined ? fallback : Math.trunc(Number(value)) || 0;
  return Math.min(Math.max(n, 0), size);
};

const forwardSearch: Span = (self, args, answer) => {
  const text = String(self);
  const from = start(args[1], 0, text.length);
  const found = typeof answer === "number" ? answer : -1;
  const end = found === -1 ? text.length : found + String(args[0]).length;
  return Math.max(1, end - from);
};

const SPANS: Record<string, Span> = {
  charCodeAt: () => 1,
  charAt: () => 1,
  codePointAt: () => 1,
  at: () => 1,
  indexOf: forwardSearch,
  includes: (self, args) => {
    const text = String(self);
    return Math.max(1, text.length - start(args[1], 0, text.length));
  },
  lastIndexOf: (self, args, answer) => {
    const text = String(self);
    const from = start(args[1], text.length, text.length);
    const found = answer as number;
    return Math.max(1, (found === -1 ? from : from - found) + length(args[0]));
  },
  startsWith: (_, args) => String(args[0]).length + 1,
  endsWith: (_, args) => String(args[0]).length + 1,
  slice: (_, __, answer) => length(answer) + 1,
  substring: (_, __, answer) => length(answer) + 1,
  substr: (_, __, answer) => length(answer) + 1,
};

const OTHER_STRING_METHODS = [
  "concat",
  "localeCompare",
  "match",
  "matchAll",
  "normalize",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "search",
  "split",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
];
const whole: Span = (self, _, answer) =>
  String(self).length + length(answer) + 1;

/** Runs `run` with the meter installed; `work` is what it counted. Throws `WorkExceeded` past `limit`. */
export function metered<T>(
  limit: number,
  run: () => T,
): { work: number; result: T } {
  let work = 0;
  const restore: Array<() => void> = [];
  const wrap = (
    owner: object,
    name: string,
    span: (self: unknown, args: unknown[], answer: unknown) => number,
  ) => {
    const original = (owner as Record<string, unknown>)[name];
    if (typeof original !== "function") return;
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    Object.defineProperty(owner, name, {
      ...descriptor,
      value: function (this: unknown, ...args: unknown[]) {
        const answer = Reflect.apply(original, this, args);
        work += span(this, args, answer);
        if (work > limit) throw new WorkExceeded(work);
        return answer;
      },
    });
    restore.push(() =>
      Object.defineProperty(owner, name, descriptor as PropertyDescriptor),
    );
  };
  try {
    for (const [name, span] of Object.entries(SPANS))
      wrap(String.prototype, name, span);
    for (const name of OTHER_STRING_METHODS)
      wrap(String.prototype, name, whole);
    wrap(RegExp.prototype, "exec", (_, args) => length(args[0]) + 1);
    wrap(RegExp.prototype, "test", (_, args) => length(args[0]) + 1);
    wrap(Array.prototype, "join", (_, __, answer) => length(answer) + 1);
    wrap(TextEncoder.prototype, "encode", (_, args) => length(args[0]) + 1);
    const result = run();
    return { work, result };
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}
