// A stand-in for the `kind`, `docker`, `helm` and `kubectl` executables, for tests/static/kind-smoke.test.ts (through
// tests/helpers/kind-world.ts). It is run as `node fake-kind-tools.mjs <tool> <arguments...>` by one-line wrapper scripts, so the
// real scripts/smoke-kind.sh runs unchanged against it.
//
// It models exactly the parts of a cluster whose ownership matters: which clusters, namespaces and releases exist, which images the
// host and the kind nodes hold, and how the real tools refuse (an existing namespace or release name, a missing namespace, a
// missing cluster). Its state is a JSON file, so a test can compare the cluster before and after a run and see what a script
// deleted, not only which commands it called. It is NOT a Kubernetes API: it proves the script's control flow and the scoping of
// its calls, and the real-cluster runs recorded in .agtx/execute.md are what prove the tools' own behaviour.
//
// Environment: FAKE_DIR (state.json, calls.jsonl and markers live there) and FAKE_FAULT, one of
//   docker-build          `docker build` exits 23 (nothing is tagged)
//   kind-load             `kind load docker-image` fails
//   helm-install          `helm install` fails before it creates anything
//   helm-install-partial  `helm install` creates its release and then fails, as a timed-out --wait does
//   helm-install-hang     as above, then blocks until it is killed (an interrupted install)
//   http                  the forwarded site answers 200 for a backend path, so an HTTP check fails
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [tool = "", ...argv] = process.argv.slice(2);
const dir = process.env.FAKE_DIR ?? "";
const fault = process.env.FAKE_FAULT ?? "";
const statePath = join(dir, "state.json");
const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (state) =>
  writeFileSync(statePath, JSON.stringify(state, null, 2));
appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ tool, argv })}\n`);

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const VALUE_FLAGS = new Set([
  "--kube-context",
  "--context",
  "--namespace",
  "-n",
  "--name",
  "--set",
  "--set-string",
  "--timeout",
  "-l",
  "-o",
  "--address",
  "--build-arg",
  "-t",
]);

/** Splits arguments into flags (each a list of values) and positional words. */
function parse(args) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 0) {
      const key = arg.slice(0, equals);
      flags[key] = [...(flags[key] ?? []), arg.slice(equals + 1)];
    } else if (VALUE_FLAGS.has(arg)) {
      index += 1;
      flags[arg] = [...(flags[arg] ?? []), args[index] ?? ""];
    } else {
      flags[arg] = [...(flags[arg] ?? []), "true"];
    }
  }
  return { flags, positional };
}

const { flags, positional } = parse(argv);

/** The cluster a helm or kubectl call reaches: its explicit context, otherwise the kubeconfig's current one. */
function clusterFor(state) {
  const context =
    flags["--kube-context"]?.[0] ??
    flags["--context"]?.[0] ??
    state.currentContext;
  const name = String(context).replace(/^kind-/, "");
  const cluster = String(context).startsWith("kind-")
    ? state.clusters[name]
    : undefined;
  if (!cluster) die(`error: context "${context}" does not exist`);
  return cluster;
}

const namespaceName = () =>
  flags["--namespace"]?.[0] ?? flags["-n"]?.[0] ?? "default";

function podsMatching(namespace, selector) {
  const wanted = Object.fromEntries(
    String(selector)
      .split(",")
      .map((pair) => pair.split("=")),
  );
  const pods = [];
  for (const [release, record] of Object.entries(namespace.releases)) {
    const labels = {
      "app.kubernetes.io/name": "atlas-web",
      "app.kubernetes.io/instance": release,
    };
    if (Object.entries(wanted).every(([key, value]) => labels[key] === value)) {
      for (let index = 0; index < record.replicas; index += 1)
        pods.push({ name: `${release}-${index}`, runAsUser: record.runAsUser });
    }
  }
  return pods;
}

function kind() {
  const state = load();
  const [verb, noun, image] = positional;
  if (verb === "get" && noun === "clusters") {
    process.stdout.write(`${Object.keys(state.clusters).join("\n")}\n`);
    return;
  }
  if (verb === "load" && noun === "docker-image") {
    const name = flags["--name"]?.[0] ?? "kind";
    const cluster = state.clusters[name];
    if (!cluster) die(`ERROR: no nodes found for cluster "${name}"`);
    if (fault === "kind-load") die("ERROR: failed to load image");
    if (!state.images.includes(image))
      die(`ERROR: image: "${image}" not present locally`);
    cluster.nodeImages.push(image);
    save(state);
    return;
  }
  die(`fake kind: unsupported ${positional.join(" ")}`, 64);
}

function docker() {
  const state = load();
  const [verb, second] = positional;
  if (verb === "image" && second === "inspect") {
    process.exit(state.images.includes(positional[2]) ? 0 : 1);
  }
  if (verb === "build") {
    if (fault === "docker-build")
      die("ERROR: failed to solve: process did not complete successfully", 23);
    const tag = flags["-t"]?.[0];
    // Like the real thing, an existing tag is moved to the new image, not refused.
    if (!state.images.includes(tag)) state.images.push(tag);
    save(state);
    return;
  }
  if (verb === "rmi") {
    const image = positional[1];
    if (!state.images.includes(image))
      die(`Error response from daemon: No such image: ${image}`);
    state.images = state.images.filter((entry) => entry !== image);
    save(state);
    return;
  }
  die(`fake docker: unsupported ${positional.join(" ")}`, 64);
}

function helm() {
  const state = load();
  const cluster = clusterFor(state);
  const namespace = cluster.namespaces[namespaceName()];
  const [verb, release] = positional;
  if (verb === "install") {
    if (!namespace)
      die(
        `Error: INSTALLATION FAILED: create: failed to create: namespaces "${namespaceName()}" not found`,
      );
    if (namespace.releases[release])
      die(
        "Error: INSTALLATION FAILED: cannot re-use a name that is still in use",
      );
    if (fault === "helm-install")
      die("Error: INSTALLATION FAILED: chart requires a value");
    const replicas = Number(
      (flags["--set"] ?? [])
        .find((entry) => entry.startsWith("replicaCount="))
        ?.split("=")[1] ?? 1,
    );
    const partial =
      fault === "helm-install-partial" || fault === "helm-install-hang";
    namespace.releases[release] = {
      replicas,
      runAsUser: 101,
      status: partial ? "failed" : "deployed",
    };
    save(state);
    if (fault === "helm-install-hang") {
      writeFileSync(join(dir, "helm-started"), "1");
      setTimeout(() => process.exit(1), 60_000);
      return;
    }
    if (partial) die("Error: INSTALLATION FAILED: context deadline exceeded");
    process.stdout.write(`NAME: ${release}\nSTATUS: deployed\n`);
    return;
  }
  if (verb === "uninstall") {
    if (!namespace?.releases[release])
      die(
        `Error: uninstall: Release not loaded: ${release}: release: not found`,
      );
    delete namespace.releases[release];
    save(state);
    process.stdout.write(`release "${release}" uninstalled\n`);
    return;
  }
  die(`fake helm: unsupported ${positional.join(" ")}`, 64);
}

function kubectl() {
  const state = load();
  const cluster = clusterFor(state);
  const [verb, noun, target] = positional;
  if (verb === "create" && noun === "namespace") {
    if (cluster.namespaces[target])
      die(
        `Error from server (AlreadyExists): namespaces "${target}" already exists`,
      );
    cluster.namespaces[target] = { releases: {} };
    save(state);
    process.stdout.write(`namespace/${target} created\n`);
    return;
  }
  if (verb === "delete" && noun === "namespace") {
    if (!cluster.namespaces[target])
      die(`Error from server (NotFound): namespaces "${target}" not found`);
    delete cluster.namespaces[target];
    save(state);
    process.stdout.write(`namespace "${target}" deleted\n`);
    return;
  }
  const namespace = cluster.namespaces[namespaceName()];
  if (verb === "rollout" && noun === "status") {
    const name = String(target).replace(/^deployment\//, "");
    if (!namespace?.releases[name])
      die(`Error from server (NotFound): deployments.apps "${name}" not found`);
    process.stdout.write(`deployment "${name}" successfully rolled out\n`);
    return;
  }
  if (verb === "get" && noun === "pods") {
    const pods = namespace
      ? podsMatching(namespace, flags["-l"]?.[0] ?? "")
      : [];
    const output = flags["-o"]?.[0] ?? "";
    if (output.startsWith("jsonpath="))
      process.stdout.write(pods.map((pod) => pod.runAsUser).join(" "));
    else process.stdout.write(`${pods.map((pod) => pod.name).join("\n")}\n`);
    return;
  }
  if (verb === "port-forward") {
    const name = String(noun).replace(/^svc\//, "");
    if (!namespace?.releases[name])
      die(`Error from server (NotFound): services "${name}" not found`);
    const [port] = String(target).split(":");
    const address = flags["--address"]?.[0] ?? "127.0.0.1";
    const server = createServer((request, response) => {
      const path = String(request.url).split("?")[0];
      const answer = (code, body) => {
        response.writeHead(code, { "content-type": "text/plain" });
        response.end(body);
      };
      if (path === "/_web/health") answer(200, "ok");
      else if (path === "/settings/appearance") answer(200, "<!doctype html>");
      else if (fault === "http" && path === "/api/x")
        answer(200, "<!doctype html>");
      else answer(404, "not found");
    });
    server.listen(Number(port), address, () => {
      writeFileSync(join(dir, "forward.pid"), String(process.pid));
      process.stdout.write(`Forwarding from ${address}:${port} -> 80\n`);
    });
    return;
  }
  die(`fake kubectl: unsupported ${positional.join(" ")}`, 64);
}

const tools = { kind, docker, helm, kubectl };
const run = tools[tool];
if (!run) die(`fake ${tool}: unknown tool`, 64);
run();
