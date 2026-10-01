import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { loadModules, type Modules } from "./modules";

/**
 * Mutation detection (plan WP0 exit criteria): "a fake that cannot fail a broken protocol is not evidence". Each mutant
 * is a PATCHED COPY of the production tree that removes exactly ONE rule of the matrix's send-model or
 * exposure-model check (section 3.6.3), and must produce at least one property violation in the scenario matrices.
 * The copy lives in tests/.mutants/ (git-ignored, excluded from lint); nothing in `src/` is touched.
 */
const ROOT = resolve(__dirname, "../../..");

export interface Patch {
  file: string;
  from: string;
  to: string;
  /** Replace every occurrence (default: exactly one must exist). */
  all?: boolean;
}
export interface Mutant {
  name: string;
  rule: string;
  /** The property expected to fail. */
  expect: string;
  patches: Patch[];
}

export const MUTANTS: Mutant[] = [
  // ---- the send model (R23, R24) ----
  {
    name: "hold-only-guard",
    rule: "a boundary guard that consults the hold but not the per-request cancellation or the closing counter",
    expect: "V2 or V5",
    patches: [
      {
        file: "src/session/kernel/send.ts",
        from: `    refuses: () =>
      activity.state === "CANCELLED" ||
      callerAborted() ||
      (queued && (k.memory.hasHold(spec.account) || k.memory.closing > 0)),`,
        to: `    refuses: () => queued && k.memory.hasHold(spec.account),`,
      },
      {
        file: "src/session/kernel/cover.ts",
        from: `  if (cancelled()) {
    // A completion for a cancelled activity never assigns`,
        to: `  if (false as boolean) {
    // A completion for a cancelled activity never assigns`,
      },
    ],
  },
  {
    name: "no-boundary-guard",
    rule: "no guard at the send boundary",
    expect: "V2 or V5",
    patches: [
      {
        file: "src/session/kernel/send.ts",
        from: `    refuses: () =>
      activity.state === "CANCELLED" ||
      callerAborted() ||
      (queued && (k.memory.hasHold(spec.account) || k.memory.closing > 0)),`,
        to: `    refuses: () => false,`,
      },
      {
        file: "src/session/kernel/cover.ts",
        from: `  if (cancelled()) {
    // A completion for a cancelled activity never assigns`,
        to: `  if (false as boolean) {
    // A completion for a cancelled activity never assigns`,
      },
    ],
  },
  {
    name: "refused-lease-kept",
    rule: "a refused request's lease is not deleted",
    expect: "W2",
    patches: [
      {
        file: "src/session/kernel/send.ts",
        from: `            void retireLease(k, c.lease, handle);
            k.emit("request.not_sent"`,
        to: `            handle?.release();
            k.emit("request.not_sent"`,
      },
      {
        file: "src/session/kernel/activity.ts",
        from: `  void retireLease(k, leaseId, leaseHandle);`,
        to: `  leaseHandle?.release();`,
      },
    ],
  },
  {
    name: "closing-no-issue-wait",
    rule: "closing writes that do not wait for issue locks (Ex2 on issue locks)",
    expect: "V5",
    patches: [
      {
        file: "src/session/kernel/closing.ts",
        from: `    else if (lease.class === "ordinary" || lease.class === "recovery")
      out.push({ id, name: LOCKS.issue(id), kind: "issue" });`,
        to: ``,
      },
    ],
  },
  {
    name: "closing-no-cancel-unsent",
    rule: "an own begin_closing() that does not cancel unsent requests (Ex6)",
    expect: "V5",
    patches: [
      {
        file: "src/session/kernel/expose.ts",
        from: `  for (const set of [...k.memory.unsent.values()]) {
    for (const activity of [...set]) activity.cancel("closing_write");
  }`,
        to: ``,
      },
    ],
  },
  {
    name: "closing-not-refused",
    rule: "a closing interval that does not refuse a request that starts or issues during it (page.closing)",
    expect: "V5",
    patches: [
      {
        file: "src/session/kernel/send.ts",
        from: `k.memory.closing > 0`,
        to: `false`,
        all: true,
      },
    ],
  },
  {
    name: "issue-lock-released-early",
    rule: "an issue lock released before the request is issued (at acquisition, not at the issue)",
    expect: "V5",
    patches: [
      {
        file: "src/session/kernel/cover.ts",
        from: `    activity.issueHandle = issueHandle;
    if (cancelled()) {`,
        to: `    activity.issueHandle = issueHandle;
    issueHandle.release();
    if (cancelled()) {`,
      },
    ],
  },
  {
    name: "cancelled-keeps-issue-lock",
    rule: "a cancelled or refused request that keeps its issue lock",
    expect: "W3",
    patches: [
      {
        file: "src/session/kernel/activity.ts",
        from: `  issue?.release();`,
        to: ``,
      },
    ],
  },
  // ---- the exposure model (R1) ----
  {
    name: "no-ex1",
    rule: "Ex1: a lease is committed although another page's lease is outstanding",
    expect: "P-G or V1",
    patches: [
      {
        file: "src/session/model/reducers/cover.ts",
        from: `  if (outstanding.length > 0)\n    return nothing({ kind: "DEFER", ids: outstanding });`,
        to: ``,
      },
    ],
  },
  {
    name: "no-ex2-exposure",
    rule: "Ex2: a closing write does not wait for another page's exposure lease",
    expect: "V3",
    patches: [
      {
        file: "src/session/kernel/closing.ts",
        from: `    if (lease.class === "exposure")
      out.push({ id, name: LOCKS.lease(id), kind: "lease" });
    else if (lease.class === "ordinary" || lease.class === "recovery")`,
        to: `    if (lease.class === "ordinary" || lease.class === "recovery")`,
      },
    ],
  },
  {
    name: "no-ex3",
    rule: "Ex3: the ordinary and exposure covers do not refuse another page's unresolved lease",
    expect: "V1 or V2",
    patches: [
      {
        file: "src/session/model/reducers/cover.ts",
        from: `      if (unresolved.length > 0)
        return nothing({ kind: "CLOSED_UNRESOLVED", unresolved });
      break;
    case "verification":`,
        to: `      break;
    case "verification":`,
      },
    ],
  },
  {
    name: "exposure-lock-released-before-act",
    rule: "Ex4: the exposure lease's lock is released before the act, not in the same step",
    expect: "P-G or V4 or V1",
    patches: [
      {
        file: "src/session/kernel/cover.ts",
        from: `    case "COVERED":
      if (activity.klass !== "exposure")`,
        to: `    case "COVERED":
      if (activity.klass === "exposure") activity.leaseHandle?.release();
      if (activity.klass !== "exposure")`,
      },
    ],
  },
  {
    name: "cancel-only-reserved",
    rule: "cancellation of a pending or committed cover (only an already-returned reservation is cancelled)",
    expect: "V3",
    patches: [
      {
        file: "src/session/kernel/expose.ts",
        from: `  if (k.memory.exposure !== null) k.memory.exposure.cancel("closing_write");`,
        to: `  if (k.memory.exposure?.state === "RESERVED") k.memory.exposure.cancel("closing_write");`,
      },
    ],
  },
  {
    name: "completion-accepted-for-cancelled",
    rule: "Lemma A weakened: a delivered completion for a CANCELLED attempt is accepted and the act guard checks neither registration nor lock ownership (Ex5(b))",
    expect: "P-H or V4 or V3",
    patches: [
      {
        file: "src/session/kernel/expose.ts",
        from: `if (isCancelled(a) && c.kind !== "NOT_COVERED") {`,
        to: `if (false as boolean) {`,
      },
      {
        file: "src/session/kernel/expose.ts",
        from: `      if (isCancelled(a)) return cleanup(k, a);\n      const c = await cover(k, a);`,
        to: `      const c = await cover(k, a);`,
      },
      {
        file: "src/session/kernel/cover.ts",
        from: `  if (cancelled()) {\n    // A completion for a cancelled activity never assigns`,
        to: `  if (false as boolean) {\n    // A completion for a cancelled activity never assigns`,
      },
      {
        file: "src/session/kernel/expose.ts",
        from: `    memory.exposure !== a ||\n    a.leaseHandle === null ||\n`,
        to: ``,
      },
      {
        file: "src/session/kernel/expose.ts",
        from: `  const handle = a.leaseHandle;\n  a.leaseHandle = null;\n  handle.release();\n  k.view.set`,
        to: `  const handle = a.leaseHandle;\n  a.leaseHandle = null;\n  handle?.release();\n  k.view.set`,
      },
    ],
  },
  {
    name: "no-closing-block",
    rule: "Ex6: the closing counter does not stop an exposure attempt or an act",
    expect: "V3",
    patches: [
      {
        file: "src/session/kernel/expose.ts",
        from: `memory.closing > 0`,
        to: `false`,
        all: true,
      },
    ],
  },
  {
    name: "cancel-keeps-exposure-lock",
    rule: "W1: the cancellation of an exposure attempt does not release its lock",
    expect: "W1",
    patches: [
      {
        file: "src/session/kernel/activity.ts",
        from: `    // A finished exposure lease closes nothing: release first, delete best-effort.
    leaseHandle?.release();`,
        to: `    // A finished exposure lease closes nothing: release first, delete best-effort.
    void leaseHandle;`,
      },
    ],
  },
];

const cache = new Map<string, Modules>();

export async function buildMutant(mutant: Mutant): Promise<Modules> {
  const cached = cache.get(mutant.name);
  if (cached) return cached;
  const base = join(ROOT, "tests/.mutants", mutant.name);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(join(base, "src/lib"), { recursive: true });
  cpSync(join(ROOT, "src/session"), join(base, "src/session"), {
    recursive: true,
  });
  cpSync(join(ROOT, "src/lib/api-client"), join(base, "src/lib/api-client"), {
    recursive: true,
  });
  for (const patch of mutant.patches) {
    const file = join(base, patch.file);
    if (!existsSync(file))
      throw new Error(`mutant ${mutant.name}: ${patch.file} does not exist`);
    const source = readFileSync(file, "utf8");
    const occurrences = source.split(patch.from).length - 1;
    if (occurrences === 0)
      throw new Error(
        `mutant ${mutant.name}: patch text not found in ${patch.file}:\n${patch.from}`,
      );
    if (!patch.all && occurrences !== 1)
      throw new Error(
        `mutant ${mutant.name}: patch text found ${occurrences} times in ${patch.file}`,
      );
    writeFileSync(
      file,
      patch.all
        ? source.split(patch.from).join(patch.to)
        : source.replace(patch.from, patch.to),
    );
  }
  const modules = await loadModules(base);
  cache.set(mutant.name, modules);
  return modules;
}
