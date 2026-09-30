import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/**
 * Records which npm packages a build actually puts in the output, from the bundler's own module graph, so the third-party
 * notices (scripts/generate-notices.mjs) cover what is distributed instead of what package.json happens to call a production
 * dependency. Vite bundles everything it imports, whatever the dependency field says: the Workbox packages are devDependencies
 * and are compiled into sw.js, which `pnpm licenses --prod` never listed.
 *
 * The record holds names and versions only (no paths from the build machine) and is written into the output, dist/_web/, so it
 * is always the record of the files beside it and travels in the archive and the image. Two builds produce two records: the
 * application, and the service worker (vite-plugin-pwa builds sw.js separately).
 */

export interface BundledPackage {
  name: string;
  version: string;
}
export interface BundledPackagesRecord {
  schema: 1;
  build: "app" | "service-worker";
  packages: BundledPackage[];
}

const NODE_MODULES = "/node_modules/";

/** The package a bundled file comes from: the innermost node_modules directory in its path. Null for the project's own files. */
export function packageDirectoryOf(
  id: string,
): { name: string; directory: string } | null {
  const path = id.replace(/^\0/, "").split("?")[0]?.replace(/\\/g, "/") ?? "";
  const at = path.lastIndexOf(NODE_MODULES);
  if (at < 0) return null;
  const rest = path.slice(at + NODE_MODULES.length).split("/");
  const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  if (!name || name.endsWith("/undefined")) return null;
  return {
    name,
    directory: `${path.slice(0, at + NODE_MODULES.length)}${name}`,
  };
}

export function recordBundledPackages(
  build: BundledPackagesRecord["build"],
): Plugin {
  return {
    name: `atlas-record-bundled-packages-${build}`,
    apply: "build",
    generateBundle(_options, bundle) {
      const files = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          for (const id of Object.keys(output.modules)) files.add(id);
        } else {
          // Assets copied out of a package, such as the Geist font files.
          for (const original of output.originalFileNames ?? [])
            files.add(original);
        }
      }
      const found = new Map<string, BundledPackage>();
      for (const file of files) {
        const owner = packageDirectoryOf(file);
        if (!owner) continue;
        const { version } = JSON.parse(
          readFileSync(`${owner.directory}/package.json`, "utf8"),
        ) as { version: string };
        found.set(`${owner.name}@${version}`, { name: owner.name, version });
      }
      const packages = [...found.values()].sort(
        (a, b) =>
          a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
      );
      const record: BundledPackagesRecord = { schema: 1, build, packages };
      this.emitFile({
        type: "asset",
        fileName: `_web/bundled-packages-${build}.json`,
        source: `${JSON.stringify(record, null, 2)}\n`,
      });
    },
  };
}
