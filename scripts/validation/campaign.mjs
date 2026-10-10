// Run-owned artefacts; no cross-run test-result reuse.
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const OUTPUT_TOKEN = `\${RUN_DIR}`;
const inside = (parent, path) => {
  const rel = relative(parent, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export function prepareCampaign(requested, { root, runDir }) {
  root = realpathSync(root);
  runDir = realpathSync(runDir);
  if (!inside(resolve(root, ".agtx/evidence"), runDir))
    throw new Error("Campaign outputs must be under ignored .agtx/evidence");
  const outputs = [];
  function expand(value) {
    if (!value.includes(OUTPUT_TOKEN)) return value;
    const at = value.indexOf(OUTPUT_TOKEN);
    // Expand structured path arguments only, never source code or shell strings.
    const prefix = value.slice(0, at);
    if (prefix && !/^--[a-zA-Z-]+=$/.test(prefix))
      throw new Error(
        `Use ${OUTPUT_TOKEN} only in path arguments or environment values`,
      );
    const tail = value.slice(at + OUTPUT_TOKEN.length);
    if (!tail.startsWith("/") || tail.includes(OUTPUT_TOKEN))
      throw new Error(`${OUTPUT_TOKEN} needs one relative output suffix`);
    const destination = resolve(runDir, tail.slice(1));
    if (!inside(runDir, destination) || destination === runDir)
      throw new Error("Campaign output escapes its unique run directory");
    outputs.push({ original: value, resolved: prefix + destination });
    return prefix + destination;
  }
  const plan = {
    ...requested,
    steps: requested.steps.map((step) => ({
      ...step,
      argv: step.argv.map(expand),
      ...(step.env
        ? {
            env: Object.fromEntries(
              Object.entries(step.env).map(([k, v]) => [k, expand(v)]),
            ),
          }
        : {}),
    })),
  };
  // Catch an occupied browser output before qualification, rather than halfway
  // through a long run. Never clear old evidence to make a command succeed.
  const browserOutputs = new Set();
  const produced = new Map();
  for (const step of plan.steps) {
    const paths = ["ATLAS_EVIDENCE_DIR", "PLAYWRIGHT_JSON_OUTPUT_FILE"]
      .filter((name) => step.env?.[name])
      .map((name) => resolve(root, step.env[name]));
    const seen = new Set();
    for (let i = 0; i < step.argv.length; i++) {
      const arg = step.argv[i];
      if (arg !== "--output" && !arg.startsWith("--output=")) continue;
      if (seen.has("--output"))
        throw new Error(`Duplicate --output in ${step.id}`);
      seen.add("--output");
      const value = arg === "--output" ? step.argv[++i] : arg.slice(9);
      if (!value || value.startsWith("--"))
        throw new Error(`Missing --output in ${step.id}`);
      const path = resolve(root, value);
      if (existsSync(path) || existsSync(`${path}.atlas-evidence-claim`))
        throw new Error(
          `Occupied output in ${step.id}: preserve it and use \${RUN_DIR}/<step>/output`,
        );
      if (browserOutputs.has(path))
        throw new Error(
          `Shared --output in ${step.id}: give each step a separate output destination`,
        );
      browserOutputs.add(path);
      paths.push(path);
    }
    produced.set(step.id, paths);
  }
  for (const [id, paths] of produced) {
    for (const [other, otherPaths] of produced) {
      if (id === other) continue;
      if (
        paths.some((path) =>
          otherPaths.some(
            (candidate) => inside(path, candidate) || inside(candidate, path),
          ),
        )
      )
        throw new Error(
          `Overlapping output destinations in ${id} and ${other}; use separate step directories`,
        );
    }
  }
  // Pool results live in per-attempt evidence, not the original local --output
  // directory. Preserve a plan's structured producer/consumer contract instead
  // of reporting pool success and letting the consumer read a missing file.
  for (const step of plan.steps) {
    const paths = produced.get(step.id);
    const consumers = plan.steps.filter(
      (other) =>
        other.id !== step.id &&
        [...other.argv, ...Object.values(other.env ?? {})].some((value) => {
          const argument = value.replace(/^--[a-zA-Z-]+=/, "");
          const referenced = resolve(root, argument);
          return paths.some(
            (path) => inside(path, referenced) || inside(referenced, path),
          );
        }),
    );
    if (!consumers.length) continue;
    if (step.routing?.mode === "pool")
      throw new Error(
        `Pooled step ${step.id} has local output consumers: ${consumers.map((s) => s.id).join(", ")}; use a local constraint or an explicit pool-evidence collection step`,
      );
    if (step.routing?.mode !== "local")
      step.routing = {
        ...step.routing,
        mode: "local",
        constraint: "specialised",
        reason: `Local output is consumed by ${consumers.map((s) => s.id).join(", ")}; pool artefacts are remapped and cannot satisfy those paths`,
      };
  }
  return { plan, outputs };
}
