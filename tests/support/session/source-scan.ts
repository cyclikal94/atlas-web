import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Source scans for the static conformance tests (plan 13.6): the code of a file with its comments removed, and its import
 * specifiers. The installed TypeScript (7.x) has no JavaScript compiler API and no parser is a direct dependency (D-01:
 * none is added), so this is a small scanner that understands strings, template literals, regular-expression literals and
 * both kinds of comment. It is deliberately conservative and is itself tested (`source-scan.test.ts`).
 */
export const ROOT = resolve(__dirname, "../../..");

export function filesUnder(
  directory: string,
  extensions = [".ts", ".tsx"],
): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (extensions.some((ext) => path.endsWith(ext))) out.push(path);
    }
  };
  walk(join(ROOT, directory));
  return out.sort();
}

export const rel = (path: string): string => relative(ROOT, path);

const REGEX_PREFIX =
  /[(,=:[!&|?{};+\-*%<>~^]$|^$|\b(?:return|typeof|case|in|of|delete|void|throw|new)$/;

/** Text with `//` and block comments blanked out (strings, templates and regex literals are kept as they are). */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "/" && REGEX_PREFIX.test(out.trimEnd().slice(-10))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && (text[j] !== "/" || inClass)) {
        if (text[j] === "\\") j += 1;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "\n") break;
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The code of a file (comments removed, whitespace collapsed), given a repository-relative or absolute path. */
export function code(path: string): string {
  return stripComments(readFileSync(resolve(ROOT, path), "utf8"))
    .replace(/\s+/g, " ")
    .trim();
}

/** Files (repository-relative) under a directory whose code matches. */
export function filesMatching(directory: string, pattern: RegExp): string[] {
  return filesUnder(directory)
    .filter((path) => pattern.test(code(path)))
    .map(rel);
}

/** The module specifiers a file imports, re-exports or dynamically imports, and whether each is type-only. */
export function imports(
  path: string,
): Array<{ from: string; typeOnly: boolean }> {
  const text = code(path);
  const found: Array<{ from: string; typeOnly: boolean }> = [];
  for (const match of text.matchAll(
    /\b(import|export) (type )?(?:[^;'"]*? from )?["']([^"']+)["']/g,
  )) {
    // `export const x = "..."` has no `from`; require an import statement or a re-export `export {..} from`.
    const whole = match[0];
    if (match[1] === "export" && !/ from /.test(whole)) continue;
    found.push({ from: match[3] as string, typeOnly: match[2] === "type " });
  }
  for (const match of text.matchAll(/\bimport ?\( ?["']([^"']+)["']/g))
    found.push({ from: match[1] as string, typeOnly: false });
  return found;
}

/** Resolve a relative specifier from a file to a repository-relative path without extension. */
export function resolveImport(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return rel(resolve(ROOT, file, "..", specifier));
}
