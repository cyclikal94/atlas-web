import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * The text of a repository source file as the code under test sees it. Under the unit mutation runner (`ATLAS_MUTANT_DIR`, laid out
 * like the repository) a file with a PATCHED COPY reads as the copy, exactly as `scripts/mutation/redirect-plugin.mjs` resolves its
 * imports; otherwise (and in the unmutated control) it is the file itself. Static conformance tests that a mutant must be able to
 * fail read through this, never through `readFileSync` on the tree.
 */
export const ROOT = resolve(__dirname, "../..");

export function sourceText(path: string): string {
  const rel = relative(ROOT, resolve(ROOT, path));
  const mutant = process.env.ATLAS_MUTANT_DIR;
  const copy =
    mutant !== undefined && mutant !== "" ? join(resolve(mutant), rel) : null;
  return readFileSync(
    copy !== null && rel.startsWith("src/") && existsSync(copy)
      ? copy
      : join(ROOT, rel),
    "utf8",
  );
}
