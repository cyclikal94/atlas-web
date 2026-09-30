// The single list of backend path prefixes lives in src/lib/backend-routes.ts. Scripts derive prefixes from it; they never
// keep their own copy. Node strips the TypeScript types when importing the .ts file.
import { backendPaths } from "../../src/lib/backend-routes.ts";

export function backendPrefixes() {
  return backendPaths.map((pattern) => {
    const match = /^\^\\\/([A-Za-z0-9_-]+)\(\?:\[\/\?\]\|\$\)$/.exec(
      pattern.source,
    );
    if (!match)
      throw new Error(`Unrecognised backend path pattern: ${pattern.source}`);
    return match[1];
  });
}
