import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A disposable world for scripts/smoke-kind.sh: a copy of the script in a scratch repository layout, and fake kind, docker, helm and
 * kubectl executables (fake-kind-tools.mjs) on its PATH, over a cluster that already holds other people's work. The script under
 * test is the delivered file, byte for byte, unless a test passes a mutated copy on purpose. Nothing here touches a real cluster,
 * Docker daemon or kubeconfig; everything lives under os.tmpdir() (the launcher's TMPDIR).
 *
 * R7: the script's clean-up used to uninstall a fixed release name from whatever cluster it was pointed at, so a failed run
 * deleted a release it had never installed. The state here always contains such releases; what a run must leave alone is
 * whatever `diffState` reports as removed.
 */

const ROOT = resolve(__dirname, "../..");
const TOOLS = resolve(__dirname, "fake-kind-tools.mjs");
export const CLUSTER = "atlas-web-test";
export const OTHER_CLUSTER = "other-cluster";

type Release = {
  replicas: number;
  runAsUser: number;
  status: string;
  sentinel: string;
};
type Namespace = { releases: Record<string, Release> };
export type ClusterState = {
  nodeImages: string[];
  namespaces: Record<string, Namespace>;
};
export type State = {
  currentContext: string;
  images: string[];
  clusters: Record<string, ClusterState>;
};
export type Call = { tool: string; argv: string[] };

const release = (sentinel: string): Release => ({
  replicas: 3,
  runAsUser: 999,
  status: "deployed",
  sentinel,
});

/**
 * What already exists before a run. The `atlas-web` release in `default` is the one the review lost; the others make the cluster
 * hold same-named releases in other namespaces and a second cluster, and hold the names the collision tests pick.
 */
export function initialState(): State {
  return {
    // The kubeconfig's current context is another cluster, so a call with no --context would reach it.
    currentContext: `kind-${OTHER_CLUSTER}`,
    images: ["unrelated:latest", "atlas-web-kind-smoke:smoke-collide"],
    clusters: {
      [CLUSTER]: {
        nodeImages: ["kindest/node:fake"],
        namespaces: {
          default: { releases: { "atlas-web": release("default-atlas-web") } },
          "team-a": { releases: { "atlas-web": release("team-a-atlas-web") } },
          "atlas-web-smoke-collide2": {
            releases: {
              "atlas-web-smoke-collide2": release("collide2-release"),
            },
          },
        },
      },
      [OTHER_CLUSTER]: {
        nodeImages: [],
        namespaces: {
          default: { releases: { "atlas-web": release("other-cluster") } },
        },
      },
    },
  };
}

export type World = { dir: string; repo: string; script: string };

/** Builds the world. `script` is the text of smoke-kind.sh to run (default: the delivered file). */
export function createWorld(script?: string): World {
  const dir = mkdtempSync(join(tmpdir(), "atlas-web-kind-world-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(join(repo, "dist"), { recursive: true });
  const scriptPath = join(repo, "scripts", "smoke-kind.sh");
  writeFileSync(
    scriptPath,
    script ?? readFileSync(join(ROOT, "scripts/smoke-kind.sh"), "utf8"),
  );
  chmodSync(scriptPath, 0o755);
  cpSync(
    join(ROOT, "deploy/base-images.env"),
    join(repo, "deploy/base-images.env"),
  );
  writeFileSync(join(repo, "dist", "index.html"), "<!doctype html>");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const tool of ["kind", "docker", "helm", "kubectl"]) {
    const wrapper = join(bin, tool);
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec '${process.execPath}' '${TOOLS}' ${tool} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
  }
  mkdirSync(join(dir, "fake"));
  writeFileSync(
    join(dir, "fake", "state.json"),
    JSON.stringify(initialState(), null, 2),
  );
  writeFileSync(join(dir, "fake", "calls.jsonl"), "");
  return { dir, repo, script: scriptPath };
}

export function removeWorld(world: World): void {
  rmSync(world.dir, { recursive: true, force: true });
}

export type Options = {
  /** One of the fault names in fake-kind-tools.mjs. */
  fault?: string;
  /** SMOKE_KIND_RUN_ID, to make the run pick a name that is already in use. */
  runId?: string;
  cluster?: string;
  /** Delete dist/ first: the script's first precondition. */
  noDist?: boolean;
};

function environment(world: World, options: Options): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(world.dir, "bin")}:${process.env.PATH ?? ""}`,
    FAKE_DIR: join(world.dir, "fake"),
    FAKE_FAULT: options.fault ?? "",
    KIND_CLUSTER_NAME: options.cluster ?? CLUSTER,
    SMOKE_KIND_EVIDENCE: join(world.dir, "evidence"),
  };
  if (options.runId) env.SMOKE_KIND_RUN_ID = options.runId;
  else delete env.SMOKE_KIND_RUN_ID;
  if (options.noDist) rmSync(join(world.repo, "dist"), { recursive: true });
  return env;
}

export function readState(world: World): State {
  return JSON.parse(
    readFileSync(join(world.dir, "fake", "state.json"), "utf8"),
  );
}

export function readCalls(world: World): Call[] {
  return readFileSync(join(world.dir, "fake", "calls.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
}

export type Outcome = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  before: State;
  after: State;
  calls: Call[];
  /** The fake port-forward's process id, when the run started one. */
  forwardPid?: number;
};

function outcome(
  world: World,
  before: State,
  result: {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  },
): Outcome {
  const marker = join(world.dir, "fake", "forward.pid");
  return {
    ...result,
    before,
    after: readState(world),
    calls: readCalls(world),
    forwardPid: existsSync(marker)
      ? Number(readFileSync(marker, "utf8"))
      : undefined,
  };
}

/** Runs the script to completion. */
export function runSmoke(world: World, options: Options = {}): Outcome {
  const env = environment(world, options);
  const before = readState(world);
  const result = spawnSync("bash", [world.script], {
    cwd: world.repo,
    env,
    encoding: "utf8",
    timeout: 90_000,
  });
  return outcome(world, before, result);
}

/**
 * Runs the script and sends `signal` to its whole process group once the fake `helm install` has started and is blocking
 * (FAKE_FAULT=helm-install-hang), as Ctrl-C or a cancelled job would.
 */
export async function runInterrupted(
  world: World,
  signal: "SIGINT" | "SIGTERM",
  options: Options = {},
): Promise<Outcome> {
  const env = environment(world, { ...options, fault: "helm-install-hang" });
  const before = readState(world);
  const child: ChildProcess = spawn("bash", [world.script], {
    cwd: world.repo,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>((done) => {
    child.on("close", (status, closedBy) => done({ status, signal: closedBy }));
  });
  const marker = join(world.dir, "fake", "helm-started");
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker) && Date.now() < deadline)
    await new Promise((wait) => setTimeout(wait, 25));
  if (!existsSync(marker)) {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    throw new Error("the fake helm install never started");
  }
  if (child.pid) process.kill(-child.pid, signal);
  const done = await exited;
  return outcome(world, before, { ...done, stdout, stderr });
}

/** Every leaf of the state as one string, so two states can be compared as sets. */
function leaves(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.map((entry) => `${path}+=${entry}`);
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, entry]) =>
      leaves(entry, path ? `${path}.${key}` : key),
    );
  return [`${path}=${String(value)}`];
}

/** What a run added to, and what it removed or changed in, the world. A changed value shows as one removal and one addition. */
export function diffState(
  before: State,
  after: State,
): { added: string[]; removed: string[] } {
  const was = new Set(leaves(before));
  const now = new Set(leaves(after));
  return {
    added: [...now].filter((leaf) => !was.has(leaf)).sort(),
    removed: [...was].filter((leaf) => !now.has(leaf)).sort(),
  };
}

/** The run id the script chose, read from its image build (the first thing it does that names it). */
export function runIdOf(calls: Call[]): string | undefined {
  const build = calls.find(
    (call) => call.tool === "docker" && call.argv[0] === "build",
  );
  const tag = build?.argv[build.argv.indexOf("-t") + 1];
  return tag?.replace("atlas-web-kind-smoke:smoke-", "");
}

/** The one thing a run legitimately leaves in the cluster: its uniquely tagged image in the kind node. */
export const nodeImageLeaf = (runId: string): string =>
  `clusters.${CLUSTER}.nodeImages+=atlas-web-kind-smoke:smoke-${runId}`;

/** Whether a process id is alive. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The words of a call that are neither flags nor the value of a global flag: the verb, the noun and the names. */
function words(argv: string[]): string[] {
  return argv.filter((word, index) => {
    const previous = argv[index - 1] ?? "";
    return (
      !word.startsWith("-") &&
      !["--kube-context", "--context", "--namespace", "-n"].includes(previous)
    );
  });
}

/** The calls that create, delete or build something (as opposed to reading). */
export function mutations(calls: Call[]): string[] {
  return calls
    .filter(({ tool, argv }) => {
      if (tool === "docker") return ["build", "rmi"].includes(argv[0] ?? "");
      if (tool === "kind") return argv[0] === "load";
      const [verb = ""] = words(argv);
      if (tool === "helm") return ["install", "uninstall"].includes(verb);
      return ["create", "delete"].includes(verb);
    })
    .map(({ tool, argv }) => `${tool} ${argv.join(" ")}`);
}

/**
 * Every helm or kubectl call that is not pinned to the run's cluster, or that reaches a namespace other than the run's own: the
 * namespace's own creation and deletion must name exactly the run's namespace, and every other call must be scoped to it.
 */
export function scopeProblems(calls: Call[], runId: string): string[] {
  const namespace = `atlas-web-smoke-${runId}`;
  const problems: string[] = [];
  for (const { tool, argv } of calls) {
    if (tool !== "helm" && tool !== "kubectl") continue;
    const text = `${tool} ${argv.join(" ")}`;
    const value = (...names: string[]) => {
      const at = names.map((name) => argv.indexOf(name)).find((i) => i >= 0);
      return at === undefined ? undefined : argv[at + 1];
    };
    const context = value("--kube-context", "--context");
    if (context !== `kind-${CLUSTER}`)
      problems.push(`not pinned to the cluster (${context}): ${text}`);
    const [verb, noun, name] = words(argv);
    if (
      tool === "kubectl" &&
      ["create", "delete"].includes(verb ?? "") &&
      noun === "namespace"
    ) {
      if (name !== namespace)
        problems.push(
          `namespace call on '${name}', not '${namespace}': ${text}`,
        );
    } else if (value("--namespace", "-n") !== namespace) {
      problems.push(`not scoped to ${namespace}: ${text}`);
    }
  }
  return problems;
}
