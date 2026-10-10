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
      if (rel.startsWith("src/") && existsSync(join(mutant, rel)))
        return join(mutant, rel);
      return resolved;
    },
  };
}
