/**
 * The Playwright runs a maintained shell script makes, read as the shell reads them: one logical command per invocation, with
 * explicit backslash-newline continuations folded and the environment assignments that prefix that same simple command. R36: a
 * physical-line reader lost `ATLAS_PRODUCTION_URL="$ORIGIN"` when scripts/smoke-image.sh put it on the line before a continued
 * `playwright test`, although the shell supplies it to that run.
 *
 * This is deliberately not a shell interpreter. It understands words, single/double quotes, backslash escapes, `$(...)`,
 * comments, redirections and the command separators `;`, `&`, `&&`, `|`, `||`, `(`, `)`, plus leading reserved words such as
 * `if`/`then`. An assignment applies only to the simple command it prefixes: one on another command, after a separator or in a
 * comment never supplies a URL. Any other layout that mentions `playwright test` (backticks, here-documents, an unterminated
 * quote, the words inside a string) throws with its file and line instead of being guessed.
 */

export interface ShellInvocation {
  file: string;
  /** 1-based line of the logical command's first physical line, and its last. */
  line: number;
  endLine: number;
  /** `NAME=value` words prefixing this simple command, quotes removed and `$VAR` left unexpanded. */
  assignments: ReadonlyMap<string, string>;
  /** The words after `playwright test`, without redirections. */
  args: readonly string[];
}

interface LogicalCommand {
  text: string;
  line: number;
  endLine: number;
}

type Token =
  | { kind: "word"; value: string }
  | { kind: "separator" }
  | { kind: "redirect"; takesTarget: boolean };

const MENTION = /playwright\s+test/;
const RESERVED = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "{",
  "}",
  "time",
]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const REDIRECT = /^\d*(?:>>|>&|<&|>\||>|<)(&?\d+|&?-)?/;

class UnsupportedShell extends Error {}

/** Join explicit continuations (a line ending in an odd number of backslashes); comment-only lines stand alone and are dropped. */
export function logicalCommands(source: string): LogicalCommand[] {
  const lines = source.split("\n");
  const commands: LogicalCommand[] = [];
  let pending: LogicalCommand | undefined;
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (!pending && raw.trimStart().startsWith("#")) return;
    const continues = /(?:^|[^\\])(?:\\\\)*\\$/.test(raw);
    const text = continues ? raw.slice(0, -1) : raw;
    pending = pending
      ? { ...pending, text: `${pending.text} ${text}`, endLine: line }
      : { text, line, endLine: line };
    if (!continues) {
      commands.push(pending);
      pending = undefined;
    }
  });
  if (pending) commands.push(pending);
  return commands;
}

/** Read `$(...)` starting at `start` (the `$`), returning the index after its closing parenthesis. */
function skipSubstitution(text: string, start: number): number {
  let depth = 0;
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") index += 2;
    else if (char === "'") {
      const close = text.indexOf("'", index + 1);
      if (close < 0)
        throw new UnsupportedShell("unterminated single quote in $(...)");
      index = close + 1;
    } else if (char === '"') index = skipDoubleQuoted(text, index).end;
    else if (char === "`") throw new UnsupportedShell("backtick substitution");
    else {
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
  }
  throw new UnsupportedShell("unterminated $(...)");
}

/** Read a double-quoted string starting at `start` (the opening quote), returning its contents and the index after it. */
function skipDoubleQuoted(
  text: string,
  start: number,
): { value: string; end: number } {
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === '"') return { value, end: index + 1 };
    if (char === "\\") {
      const next = text[index + 1] ?? "";
      value += '$`"\\'.includes(next) ? next : `\\${next}`;
      index += 2;
    } else if (char === "$" && text[index + 1] === "(") {
      const end = skipSubstitution(text, index);
      value += text.slice(index, end);
      index = end;
    } else if (char === "`")
      throw new UnsupportedShell("backtick substitution");
    else {
      value += char;
      index += 1;
    }
  }
  throw new UnsupportedShell("unterminated double quote");
}

function tokens(text: string): Token[] {
  const result: Token[] = [];
  let word: string | undefined;
  const endWord = () => {
    if (word !== undefined) result.push({ kind: "word", value: word });
    word = undefined;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    const rest = text.slice(index);
    const redirect = REDIRECT.exec(rest);
    if (/\s/.test(char)) {
      endWord();
      index += 1;
    } else if (char === "#" && word === undefined) {
      break;
    } else if (rest.startsWith("<<")) {
      throw new UnsupportedShell("here-document");
    } else if (redirect && (word === undefined || !/^\d/.test(rest))) {
      // `2>&1` and `>&2` duplicate a descriptor; every other form (`>`, `>>`, `2>`, `<`) is followed by its target word.
      endWord();
      result.push({ kind: "redirect", takesTarget: redirect[1] === undefined });
      index += redirect[0].length;
    } else if (/^(?:&&|\|\||[;&|()])/.test(rest)) {
      endWord();
      result.push({ kind: "separator" });
      index += rest.startsWith("&&") || rest.startsWith("||") ? 2 : 1;
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1);
      if (close < 0) throw new UnsupportedShell("unterminated single quote");
      word = (word ?? "") + text.slice(index + 1, close);
      index = close + 1;
    } else if (char === '"') {
      const { value, end } = skipDoubleQuoted(text, index);
      word = (word ?? "") + value;
      index = end;
    } else if (char === "\\") {
      word = (word ?? "") + (text[index + 1] ?? "");
      index += 2;
    } else if (char === "$" && text[index + 1] === "(") {
      const end = skipSubstitution(text, index);
      word = (word ?? "") + text.slice(index, end);
      index = end;
    } else if (char === "`") {
      throw new UnsupportedShell("backtick substitution");
    } else {
      word = (word ?? "") + char;
      index += 1;
    }
  }
  endWord();
  return result;
}

/** Split tokens into simple commands, dropping redirections and their targets. */
function simpleCommands(list: readonly Token[]): string[][] {
  const commands: string[][] = [[]];
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (!token) continue;
    if (token.kind === "separator") commands.push([]);
    else if (token.kind === "redirect") {
      if (token.takesTarget) index += 1;
    } else commands[commands.length - 1]?.push(token.value);
  }
  return commands.filter((words) => words.length > 0);
}

function invocation(
  file: string,
  command: LogicalCommand,
  words: readonly string[],
): ShellInvocation | undefined {
  let index = 0;
  while (index < words.length && RESERVED.has(words[index] ?? "")) index += 1;
  const assignments = new Map<string, string>();
  for (; index < words.length; index += 1) {
    const match = ASSIGNMENT.exec(words[index] ?? "");
    if (!match) break;
    assignments.set(match[1] ?? "", match[2] ?? "");
  }
  const argv = words.slice(index);
  const at = argv.findIndex(
    (word, position) =>
      /(?:^|\/)playwright$/.test(word) && argv[position + 1] === "test",
  );
  if (at < 0) return undefined;
  return {
    file,
    line: command.line,
    endLine: command.endLine,
    assignments,
    args: argv.slice(at + 2),
  };
}

/** Every `playwright test` run in `source`; throws, naming `file:line`, for a mention this reader cannot attribute to a run. */
export function playwrightInvocations(
  file: string,
  source: string,
): ShellInvocation[] {
  const found: ShellInvocation[] = [];
  for (const command of logicalCommands(source)) {
    if (!MENTION.test(command.text)) continue;
    const where = `${file}:${command.line}`;
    let runs: ShellInvocation[];
    try {
      runs = simpleCommands(tokens(command.text)).flatMap(
        (words) => invocation(file, command, words) ?? [],
      );
    } catch (error) {
      if (!(error instanceof UnsupportedShell)) throw error;
      throw new Error(
        `${where}: unsupported shell layout around a Playwright run (${error.message}); write it as a plain command`,
      );
    }
    const mentions = command.text.match(new RegExp(MENTION, "g"))?.length ?? 0;
    if (runs.length !== mentions)
      throw new Error(
        `${where}: found ${mentions} mention(s) of "playwright test" but ${runs.length} run(s) this reader can attribute; write each run as a plain command`,
      );
    found.push(...runs);
  }
  return found;
}
