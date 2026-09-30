import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  alive,
  CLUSTER,
  createWorld,
  diffState,
  mutations,
  nodeImageLeaf,
  type Outcome,
  removeWorld,
  runIdOf,
  runInterrupted,
  runSmoke,
  scopeProblems,
  type World,
} from "../helpers/kind-world";

/**
 * R7 (fourth revision review): scripts/smoke-kind.sh used the fixed Helm release name `atlas-web` and an unconditional exit trap
 * that uninstalled it. Pointed at a cluster that already held an `atlas-web` release, a failed Docker build (before anything was
 * installed), or a Helm install that refused the occupied name, deleted the release it had never created.
 *
 * These tests run the delivered script, unchanged, against fake kind/docker/helm/kubectl executables over a cluster that already
 * holds other releases (tests/helpers/kind-world.ts, fake-kind-tools.mjs). They assert on the cluster's state afterwards, not on
 * the commands that were called: whatever was there before must still be there ("removed" is empty), and the only thing a run may
 * leave is the uniquely tagged image the kind node keeps. The cases are the four the review asked for: a failure before install,
 * a collision with something that already exists, a partially created release of the run's own, and normal completion; an
 * interrupted install is added. They prove the script's control flow and the scoping of its calls; the real tools' behaviour is
 * shown by the real-cluster runs recorded in .agtx/execute.md.
 */
vi.setConfig({ testTimeout: 90_000 });

const ROOT = resolve(__dirname, "../..");
const SCRIPT = readFileSync(resolve(ROOT, "scripts/smoke-kind.sh"), "utf8");

const worlds: World[] = [];
function world(script?: string): World {
  const created = createWorld(script);
  worlds.push(created);
  return created;
}
afterEach(() => {
  for (const created of worlds.splice(0)) removeWorld(created);
});

const NAMESPACE = /^atlas-web-smoke-[0-9a-f]{8}$/;

/** The namespaces of the test cluster after the run. */
const namespacesAfter = (result: Outcome) =>
  Object.keys(result.after.clusters[CLUSTER]?.namespaces ?? {}).sort();

/** Nothing that existed before was removed or changed. */
function expectNothingLost(result: Outcome) {
  expect(diffState(result.before, result.after).removed).toEqual([]);
}

/** Nothing before was lost, and the only addition is the image the node keeps under this run's unique tag. */
function expectOnlyNodeImageAdded(result: Outcome) {
  const runId = runIdOf(result.calls) ?? "";
  expect(diffState(result.before, result.after)).toEqual({
    added: [nodeImageLeaf(runId)],
    removed: [],
  });
}

const isOurs = (call: { tool: string }) =>
  call.tool === "helm" || call.tool === "kubectl";

describe("a run that fails before it creates anything deletes and uninstalls nothing", () => {
  test.each([
    ["dist/ is missing", { noDist: true }],
    ["the cluster does not exist", { cluster: "no-such-cluster" }],
    ["its image tag is already taken", { runId: "collide" }],
    ["its run id is not a valid name", { runId: "Not Valid" }],
  ])(
    "%s: exit 2, no mutating call, cluster and host untouched",
    (_name, options) => {
      const result = runSmoke(world(), options);
      expect(result.status).toBe(2);
      expect(mutations(result.calls)).toEqual([]);
      expectNothingLost(result);
      expect(diffState(result.before, result.after).added).toEqual([]);
    },
  );

  test("the existing image that blocked the run is still there, and nothing was built over it", () => {
    const result = runSmoke(world(), { runId: "collide" });
    expect(result.stderr).toContain("already exists");
    expect(result.after.images).toContain("atlas-web-kind-smoke:smoke-collide");
    expect(result.calls.some((call) => call.argv[0] === "build")).toBe(false);
  });

  test("a failed Docker build (the reviewed case: exit 23) makes no helm or kubectl call at all", () => {
    const result = runSmoke(world(), { fault: "docker-build" });
    expect(result.status).toBe(23);
    expect(result.calls.filter(isOurs)).toEqual([]);
    expectNothingLost(result);
    expect(diffState(result.before, result.after).added).toEqual([]);
    // It built nothing, so it removes nothing: the only mutating call is the failed build itself.
    expect(mutations(result.calls)).toHaveLength(1);
  });

  test("a failed image load leaves the cluster alone and removes only the image this run built", () => {
    const result = runSmoke(world(), { fault: "kind-load" });
    expect(result.status).toBe(1);
    expect(result.calls.filter(isOurs)).toEqual([]);
    expectNothingLost(result);
    expect(diffState(result.before, result.after).added).toEqual([]);
    const runId = runIdOf(result.calls);
    expect(mutations(result.calls)).toContain(
      `docker rmi atlas-web-kind-smoke:smoke-${runId}`,
    );
    expect(result.after.images).toEqual(result.before.images);
  });
});

describe("a name that is already in use is refused, and what holds it survives", () => {
  test("a namespace with the run's name: the run stops before installing and deletes nothing in the cluster", () => {
    const result = runSmoke(world(), { runId: "collide2" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AlreadyExists");
    const words = result.calls.map(
      (call) => `${call.tool} ${call.argv.join(" ")}`,
    );
    expect(words.some((call) => call.startsWith("helm"))).toBe(false);
    expect(words.some((call) => /kubectl .*delete/.test(call))).toBe(false);
    // The namespace and the release inside it are as they were; the image this run built is gone; the node keeps its image.
    expect(namespacesAfter(result)).toContain("atlas-web-smoke-collide2");
    expect(
      result.after.clusters[CLUSTER]?.namespaces["atlas-web-smoke-collide2"],
    ).toEqual(
      result.before.clusters[CLUSTER]?.namespaces["atlas-web-smoke-collide2"],
    );
    expect(result.after.images).toEqual(result.before.images);
    expect(diffState(result.before, result.after)).toEqual({
      added: [nodeImageLeaf("collide2")],
      removed: [],
    });
  });

  test("a failed helm install (the name rejected, nothing created) removes the run's namespace and nothing else", () => {
    const result = runSmoke(world(), { fault: "helm-install" });
    expect(result.status).toBe(1);
    expect(namespacesAfter(result)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(NAMESPACE)]),
    );
    expectOnlyNodeImageAdded(result);
    expect(result.after.images).toEqual(result.before.images);
  });
});

describe("a release the run itself half-created is removed with its namespace, and only that", () => {
  test("a helm install that fails after creating its release (a timed-out --wait)", () => {
    const result = runSmoke(world(), { fault: "helm-install-partial" });
    expect(result.status).toBe(1);
    const runId = runIdOf(result.calls) ?? "";
    expect(
      result.calls.some(
        (call) => call.tool === "helm" && call.argv.includes("install"),
      ),
    ).toBe(true);
    expect(namespacesAfter(result)).toEqual(
      ["atlas-web-smoke-collide2", "default", "team-a"].sort(),
    );
    expectOnlyNodeImageAdded(result);
    expect(scopeProblems(result.calls, runId)).toEqual([]);
    expect(result.after.images).toEqual(result.before.images);
  });

  test.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)(
    "an install interrupted by %s (a cancelled job, Ctrl-C)",
    async (signal, status) => {
      const result = await runInterrupted(world(), signal);
      expect(result.status).toBe(status);
      expect(namespacesAfter(result)).toEqual(
        ["atlas-web-smoke-collide2", "default", "team-a"].sort(),
      );
      expectOnlyNodeImageAdded(result);
      expect(result.after.images).toEqual(result.before.images);
    },
  );

  test("a rollout or HTTP check that fails after a complete install: the namespace and the port-forward are removed", () => {
    const result = runSmoke(world(), { fault: "http" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FAIL");
    expectOnlyNodeImageAdded(result);
    expect(result.forwardPid).toBeGreaterThan(0);
    expect(alive(result.forwardPid ?? 0)).toBe(false);
    expect(result.after.images).toEqual(result.before.images);
  });
});

describe("normal completion", () => {
  test("passes beside an unrelated atlas-web release, then removes exactly what it made", () => {
    const result = runSmoke(world());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kind smoke ok");
    expect(result.stderr).not.toContain("FAIL");
    // The UID check counted this release's two pods, not the three of the release that was already in `default`.
    expect(result.stdout).toContain("ok:   the pods run as UID 101");
    const runId = runIdOf(result.calls) ?? "";
    expect(`atlas-web-smoke-${runId}`).toMatch(NAMESPACE);
    expectOnlyNodeImageAdded(result);
    expect(result.after.images).toEqual(result.before.images);
    expect(scopeProblems(result.calls, runId)).toEqual([]);
    // Created and deleted the run's namespace, once each, in that order.
    const changes = mutations(result.calls).filter((call) =>
      /(create|delete) namespace/.test(call),
    );
    expect(changes).toEqual([
      expect.stringMatching(
        new RegExp(`create namespace atlas-web-smoke-${runId}$`),
      ),
      expect.stringMatching(
        new RegExp(`delete namespace atlas-web-smoke-${runId} `),
      ),
    ]);
    expect(result.forwardPid).toBeGreaterThan(0);
    expect(alive(result.forwardPid ?? 0)).toBe(false);
  });

  test("every run names itself uniquely", () => {
    const first = runIdOf(runSmoke(world(), { fault: "docker-build" }).calls);
    const second = runIdOf(runSmoke(world(), { fault: "docker-build" }).calls);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(second).toMatch(/^[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  test("the script neither creates a namespace through helm (which accepts an existing one) nor uninstalls a release by name", () => {
    const code = SCRIPT.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toContain("--create-namespace");
    expect(code).not.toMatch(/helm .*\buninstall\b/);
    expect(code).not.toMatch(/^RELEASE="atlas-web"/m);
  });
});

describe("the chart creates only namespaced resources, so deleting the run's namespace removes all of them", () => {
  const templates = resolve(ROOT, "charts/atlas-web/templates");
  const files = readdirSync(templates).filter((file) => file.endsWith(".yaml"));

  test("the templates are the ones this reasoning was written for", () => {
    expect(files.sort()).toEqual([
      "deployment.yaml",
      "ingress.yaml",
      "service.yaml",
    ]);
  });

  test("every kind is namespaced, and no template picks a namespace of its own", () => {
    const kinds = files.flatMap((file) =>
      [
        ...readFileSync(resolve(templates, file), "utf8").matchAll(
          /^kind: (\S+)/gm,
        ),
      ].map((match) => match[1]),
    );
    expect(kinds.sort()).toEqual(["Deployment", "Ingress", "Service"]);
    for (const file of files)
      expect(readFileSync(resolve(templates, file), "utf8")).not.toMatch(
        /^\s*namespace:/m,
      );
  });
});

describe("the tests detect the reviewed defect and each way of losing ownership", () => {
  /** The exit clean-up as reviewed: a fixed release name, uninstalled whether or not this run installed it. */
  const REVIEWED_CLEANUP = `cleanup() {
  if [ -n "$FORWARD_PID" ]; then
    kill "$FORWARD_PID" >/dev/null 2>&1 || true
    wait "$FORWARD_PID" >/dev/null 2>&1 || true
  fi
  helm --kube-context "$CONTEXT" uninstall atlas-web >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
}
`;

  function mutate(from: string | RegExp, to: string): string {
    const mutated = SCRIPT.replace(from, to);
    expect(mutated).not.toBe(SCRIPT);
    return mutated;
  }

  test("the reviewed clean-up deletes the pre-existing release when a Docker build fails", () => {
    const script = mutate(/^cleanup\(\) \{\n[\s\S]*?\n\}\n/m, REVIEWED_CLEANUP);
    const result = runSmoke(world(script), { fault: "docker-build" });
    expect(result.status).toBe(23);
    expect(diffState(result.before, result.after).removed.join("\n")).toContain(
      "clusters.atlas-web-test.namespaces.default.releases.atlas-web.sentinel=default-atlas-web",
    );
  });

  test("the reviewed clean-up deletes it again when the install is refused", () => {
    const script = mutate(/^cleanup\(\) \{\n[\s\S]*?\n\}\n/m, REVIEWED_CLEANUP);
    const result = runSmoke(world(script), { fault: "helm-install" });
    expect(diffState(result.before, result.after).removed.join("\n")).toContain(
      "namespaces.default.releases.atlas-web",
    );
  });

  test("deleting the namespace without proof of ownership removes the namespace that caused a collision", () => {
    const script = mutate("NAMESPACE_OWNED=0", "NAMESPACE_OWNED=1");
    const result = runSmoke(world(script), { runId: "collide2" });
    expect(diffState(result.before, result.after).removed.join("\n")).toContain(
      "namespaces.atlas-web-smoke-collide2",
    );
  });

  test("removing an image without proof of ownership removes the image that blocked the run", () => {
    const script = mutate("IMAGE_OWNED=0", "IMAGE_OWNED=1");
    const result = runSmoke(world(script), { runId: "collide" });
    expect(diffState(result.before, result.after).removed.join("\n")).toContain(
      "images+=atlas-web-kind-smoke:smoke-collide",
    );
  });

  test("dropping the image-tag check lets the build take over, and the clean-up delete, a tag that was not the run's", () => {
    const script = mutate(/^if docker image inspect[\s\S]*?\nfi\n/m, "");
    const result = runSmoke(world(script), { runId: "collide" });
    expect(result.after.images).not.toContain(
      "atlas-web-kind-smoke:smoke-collide",
    );
  });

  test("a clean-up that is skipped leaves the partial release where the harness can see it", () => {
    const script = mutate("trap cleanup EXIT", ":");
    const result = runSmoke(world(script), { fault: "helm-install-partial" });
    const runId = runIdOf(result.calls) ?? "";
    expect(diffState(result.before, result.after).added.join("\n")).toContain(
      `namespaces.atlas-web-smoke-${runId}.releases.atlas-web-smoke-${runId}.status=failed`,
    );
  });

  test("a call that loses its namespace scope is reported", () => {
    const script = mutate(
      'kubectl --context "$CONTEXT" --namespace "$NAMESPACE" rollout',
      'kubectl --context "$CONTEXT" rollout',
    );
    const result = runSmoke(world(script));
    const runId = runIdOf(result.calls) ?? "";
    expect(scopeProblems(result.calls, runId).join("\n")).toContain(
      "not scoped",
    );
  });
});
