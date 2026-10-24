// The mutation harness's resolver, shared by vitest (vitest.mutant.config.ts) and the real-engine fixture build
// (vite.mutant.config.ts): every import of a source file that has a PATCHED COPY under `mutantDir` resolves to the copy. The copy
// resolves its own imports as if it still lived at its original path, so only the patched files differ. With no `mutantDir` it does
// nothing, which is the unmutated CONTROL.
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export function mutantRedirect(root, mutantDirectory) {
  const mutant = mutantDirectory ? resolve(mutantDirectory) : null;
  return {
    name: "atlas-mutant-redirect",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (mutant === null) return null;
      const base =
        importer?.startsWith(`${mutant}/`) === true
          ? join(root, importer.slice(mutant.length + 1))
          : importer;
      const resolved = await this.resolve(source, base, {
        ...options,
        skipSelf: true,
      });
      if (!resolved || resolved.external) return resolved;
      const path = resolved.id.split("?")[0] ?? resolved.id;
      const rel = relative(root, path);
      // Source files and catalogue counts (R24: MU-2235), plus the exact inventory guard qualified by the accepted-base merge (MU-2425).
      if (
        (rel.startsWith("src/") ||
          rel.startsWith("scripts/mutation/") ||
          rel === "scripts/lib/mutation-inventory.mjs") &&
        existsSync(join(mutant, rel))
      )
        return join(mutant, rel);
      return resolved;
    },
  };
}
