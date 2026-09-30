import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * R6 (third revision review): the Kubernetes job created its cluster with helm/kind-action, which names it "chart-testing", and
 * then ran `kind load docker-image` without `--name`, which looks for a cluster called "kind". On a fresh runner the load failed
 * before Helm ran, so none of the rollout or HTTP checks could pass. The chart smoke (scripts/smoke-helm.sh) runs no cluster and
 * could not see it.
 *
 * No cluster is started here. This pins the wiring that failed: cluster creation and image loading name the same cluster, from
 * one variable, and the script pins every cluster call to it. A real disposable-cluster run is recorded separately in
 * .agtx/execute.md.
 *
 * R7 (fourth revision review) added the second half: the script deploys into a namespace of its own and every call after the
 * namespace exists is scoped to it. This file only checks the text of that scoping; tests/static/kind-smoke.test.ts runs the
 * script against a cluster that already holds other releases and shows what survives.
 */

const ROOT = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");
/** The workflow expression that hands the job's cluster name to the action (written as a template so it is not a stray placeholder). */
const CLUSTER_EXPRESSION = `\${{ env.KIND_CLUSTER_NAME }}`;

/** The text of one job: from its key to the next job key (two-space indent) or the end of the file. */
function job(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}\S/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Every reason the kind wiring would send an image to a cluster other than the one that was created. */
function kindWiringProblems(workflow: string, script: string): string[] {
  const problems: string[] = [];
  const kindJob = job(workflow, "web-helm-kind");
  if (!kindJob) return ["the workflow has no web-helm-kind job"];

  const named = /^ {6}KIND_CLUSTER_NAME: (\S+)\s*$/m.exec(kindJob);
  if (!named)
    problems.push("the job does not define KIND_CLUSTER_NAME in its env");

  const action = /uses: helm\/kind-action@\S+\n((?: {8,}\S.*\n?)*)/.exec(
    kindJob,
  );
  if (!action)
    problems.push("the job does not create its cluster with helm/kind-action");
  else if (
    !/^ {10}cluster_name: \$\{\{ env\.KIND_CLUSTER_NAME \}\}\s*$/m.test(
      action[1] ?? "",
    )
  )
    problems.push(
      `helm/kind-action is not given cluster_name: ${CLUSTER_EXPRESSION} (its default is chart-testing)`,
    );

  const workflowCode = workflow
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  if (/\bkind (load|get|export|delete|create)\b/.test(workflowCode))
    problems.push(
      "the workflow calls kind directly; cluster calls belong in scripts/smoke-kind.sh, which names the cluster",
    );
  if (!/run: \.\/scripts\/smoke-kind\.sh\s*$/m.test(kindJob))
    problems.push("the job does not run scripts/smoke-kind.sh");
  else if (
    kindJob.indexOf("helm/kind-action") > kindJob.indexOf("smoke-kind.sh")
  )
    problems.push("the smoke script runs before the cluster is created");

  if (!/: "\$\{KIND_CLUSTER_NAME:\?/.test(script))
    problems.push("the script does not require KIND_CLUSTER_NAME");
  const calls = script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));
  const kindCalls = calls.filter((line) => /(^|[\s(&|;])kind (\S+)/.test(line));
  for (const line of kindCalls) {
    if (/\bkind (create|delete)\b/.test(line))
      problems.push(`the script creates or deletes a cluster: ${line.trim()}`);
    else if (
      /\bkind load\b/.test(line) &&
      !/--name "\$KIND_CLUSTER_NAME"/.test(line)
    )
      problems.push(`kind load without --name: ${line.trim()}`);
  }
  if (!kindCalls.some((line) => /\bkind load docker-image\b/.test(line)))
    problems.push("the script never loads the image with kind");
  for (const line of calls.filter((entry) =>
    /^\s*(helm|kubectl)\b/.test(entry),
  )) {
    if (!/--(kube-)?context "\$CONTEXT"/.test(line))
      problems.push(`helm/kubectl not pinned to the cluster: ${line.trim()}`);
    if (/\b(create|delete) namespace\b/.test(line)) {
      if (!/\bnamespace "\$NAMESPACE"/.test(line))
        problems.push(
          `namespace created or deleted by another name than the run's: ${line.trim()}`,
        );
    } else if (!/--namespace "\$NAMESPACE"/.test(line))
      problems.push(
        `helm/kubectl not scoped to the run's namespace: ${line.trim()}`,
      );
  }
  if (!/^NAMESPACE="atlas-web-smoke-\$RUN_ID"$/m.test(script))
    problems.push("the run's namespace is not named from its unique run id");
  if (!/^RELEASE="atlas-web-smoke-\$RUN_ID"$/m.test(script))
    problems.push("the run's release is not named from its unique run id");
  if (!/^CONTEXT="kind-\$KIND_CLUSTER_NAME"$/m.test(script))
    problems.push(
      "the script does not derive its kubectl context from the cluster name",
    );
  return problems;
}

describe("the Kubernetes job names one cluster for creation and image loading", () => {
  test("the delivered workflow and script have no naming mismatch", () => {
    expect(
      kindWiringProblems(
        read(".github/workflows/web.yml"),
        read("scripts/smoke-kind.sh"),
      ),
    ).toEqual([]);
  });

  test("the cluster name is a real, non-default name (neither kind's nor the action's)", () => {
    const named = /KIND_CLUSTER_NAME: (\S+)/.exec(
      job(read(".github/workflows/web.yml"), "web-helm-kind"),
    );
    expect(named?.[1]).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(["kind", "chart-testing"]).not.toContain(named?.[1]);
  });

  describe("it detects the reviewed defect", () => {
    // The job as reviewed: no cluster_name, and a bare `kind load`.
    const defective = `jobs:
  web-helm-kind:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm build
      - uses: helm/kind-action@v1
      - name: Build, load and deploy
        run: |
          set -euo pipefail
          docker build -t atlas-web:ci .
          kind load docker-image atlas-web:ci
          helm install atlas-web charts/atlas-web
`;
    const script = read("scripts/smoke-kind.sh");
    const workflow = read(".github/workflows/web.yml");

    test("the workflow as reviewed is rejected", () => {
      const problems = kindWiringProblems(defective, script);
      expect(problems.join("\n")).toContain("KIND_CLUSTER_NAME in its env");
      expect(problems.join("\n")).toContain("cluster_name");
      expect(problems.join("\n")).toContain("calls kind directly");
    });

    test("dropping cluster_name from the action is rejected", () => {
      const broken = workflow.replace(
        `          cluster_name: ${CLUSTER_EXPRESSION}\n`,
        "",
      );
      expect(broken).not.toBe(workflow);
      expect(kindWiringProblems(broken, script).join("\n")).toContain(
        "cluster_name",
      );
    });

    test("a different name in the action is rejected", () => {
      const broken = workflow.replace(
        `cluster_name: ${CLUSTER_EXPRESSION}`,
        "cluster_name: chart-testing",
      );
      expect(kindWiringProblems(broken, script).join("\n")).toContain(
        "cluster_name",
      );
    });

    test("kind load without --name in the script is rejected", () => {
      const broken = script.replace(' --name "$KIND_CLUSTER_NAME"', "");
      expect(broken).not.toBe(script);
      expect(kindWiringProblems(workflow, broken).join("\n")).toContain(
        "kind load without --name",
      );
    });

    test("a kubectl or helm call outside the run's namespace is rejected", () => {
      const broken = script.replace(
        'kubectl --context "$CONTEXT" --namespace "$NAMESPACE" rollout',
        'kubectl --context "$CONTEXT" rollout',
      );
      expect(broken).not.toBe(script);
      expect(kindWiringProblems(workflow, broken).join("\n")).toContain(
        "not scoped to the run's namespace",
      );
    });

    test("a fixed namespace or release name (shared with whatever is already there) is rejected", () => {
      const fixedNamespace = script.replace(
        'NAMESPACE="atlas-web-smoke-$RUN_ID"',
        'NAMESPACE="atlas-web"',
      );
      expect(fixedNamespace).not.toBe(script);
      expect(kindWiringProblems(workflow, fixedNamespace).join("\n")).toContain(
        "namespace is not named from its unique run id",
      );
      const fixedRelease = script.replace(
        'RELEASE="atlas-web-smoke-$RUN_ID"',
        'RELEASE="atlas-web"',
      );
      expect(fixedRelease).not.toBe(script);
      expect(kindWiringProblems(workflow, fixedRelease).join("\n")).toContain(
        "release is not named from its unique run id",
      );
    });

    test("deleting a namespace other than the run's own is rejected", () => {
      const broken = script.replace(
        'delete namespace "$NAMESPACE"',
        "delete namespace atlas-web",
      );
      expect(broken).not.toBe(script);
      expect(kindWiringProblems(workflow, broken).join("\n")).toContain(
        "another name than the run's",
      );
    });

    test("an unpinned kubectl or helm call is rejected", () => {
      const broken = script.replace(
        'kubectl --context "$CONTEXT" --namespace "$NAMESPACE" rollout',
        'kubectl --namespace "$NAMESPACE" rollout',
      );
      expect(broken).not.toBe(script);
      expect(kindWiringProblems(workflow, broken).join("\n")).toContain(
        "not pinned to the cluster",
      );
    });
  });
});
