// WEB-14a revision 29 (review r28 R31, design assessment C3): the Node module-loading hook of a supervised Vitest worker. Registered
// before anything else by vitest-origin-register.mjs (the worker's `--import`), it replaces exactly the pinned framework modules
// (vitest-origin-sites.mjs MODULES, matched by real-path suffix) with their instrumented source. A matching path whose bytes are not
// the audited ones, or whose anchors do not match exactly, makes the import fail: the worker cannot run tests uninstrumented. Every
// other module is returned as loaded.
import { fileURLToPath } from "node:url";
import { MODULES, ORIGIN_FILES, transform } from "./vitest-origin-sites.mjs";

const runtimeUrl = new URL("./vitest-origin-runtime.mjs", import.meta.url).href;
if (fileURLToPath(runtimeUrl) !== ORIGIN_FILES.runtime)
  throw new Error("assertion-origin loader: runtime path mismatch");

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith("file:")) return result;
  const path = fileURLToPath(url.split(/[?#]/)[0]);
  const entry = MODULES.find((m) => path.endsWith(m.path));
  if (entry === undefined) return result;
  if (result.format !== "module" || result.source == null)
    throw new Error(
      `assertion-origin loader: ${entry.name} loaded as ${result.format}, expected an ES module`,
    );
  const source =
    typeof result.source === "string"
      ? result.source
      : Buffer.from(result.source).toString("utf8");
  return { ...result, source: transform(entry, source, runtimeUrl) };
}
