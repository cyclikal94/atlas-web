import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireImage,
  disposeLabelled,
  dockerClient,
  inventory,
  LABEL_INVOCATION,
  LABEL_STACK,
  lockPath,
  pinKey,
  recordName,
} from "./docker-resources.mjs";
import { intentOf } from "./host-lock.mjs";
import { Cancelled } from "./ownership.mjs";
import {
  BACKEND_IMAGE,
  POSTGRES_IMAGE,
  startPostgresBackend,
} from "./postgres-backend.mjs";

// The image locks of these tests live in a directory of their own (production: one fixed place per host).
const coordination = mkdtempSync(join(tmpdir(), "atlas-it-coordination-"));
process.env.ATLAS_INTEGRATION_COORDINATION_DIR = coordination;
test.after(() => rmSync(coordination, { recursive: true, force: true }));

/**
 * A fake daemon for exactly the docker commands the integration harness issues (the real daemon is exercised by the maintained
 * runner's PostgreSQL cases). `fail(args)` may answer a command with a failure instead; `hooks.afterLook` runs after an inventory.
 */
function fakeDaemon({ images = {}, fail = () => null } = {}) {
  const state = {
    containers: new Map(), // id -> { name, labels, image, mounts: [volume] }
    networks: new Map(), // id -> { name, labels }
    volumes: new Map(), // name -> { labels }
    images: new Map(Object.entries(images)), // ref -> id
    log: [],
    hooks: {},
    daemon: `fake-${Math.random().toString(16).slice(2)}`,
  };
  let seq = 0;
  const id = () => `${(++seq).toString(16).padStart(12, "0")}${"0".repeat(52)}`;
  const labelsOf = (args) => {
    const out = {};
    for (let i = 0; i < args.length; i += 1)
      if (args[i] === "--label") {
        const [k, ...v] = args[i + 1].split("=");
        out[k] = v.join("=");
      }
    return out;
  };
  const filters = (args) => {
    const out = [];
    for (let i = 0; i < args.length; i += 1)
      if (args[i] === "--filter") out.push(args[i + 1]);
    return out;
  };
  const matches = (labels, fs) =>
    fs.every((f) => {
      if (!f.startsWith("label=")) return true;
      const [k, ...v] = f.slice(6).split("=");
      return v.length === 0 ? k in labels : labels[k] === v.join("=");
    });
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const no = (stderr) => ({ status: 1, stdout: "", stderr });
  const run = async (args) => {
    state.log.push(args.join(" "));
    const injected = fail(args, state);
    if (injected) return injected;
    const [a, b] = args;
    if (a === "ps") {
      const fs = filters(args);
      const ancestor = fs.find((f) => f.startsWith("ancestor="))?.slice(9);
      const rows = [...state.containers]
        .filter(([, c]) => matches(c.labels, fs))
        .filter(([, c]) => !ancestor || state.images.get(c.image) === ancestor);
      const out = args.includes("-q")
        ? rows.map(([cid]) => cid).join("\n")
        : rows.map(([cid, c]) => `${cid} ${c.name}`).join("\n");
      state.hooks.afterLook?.(state);
      return ok(out);
    }
    if (a === "network" && b === "ls")
      return ok(
        [...state.networks]
          .filter(([, n]) => matches(n.labels, filters(args)))
          .map(([nid, n]) => `${nid} ${n.name}`)
          .join("\n"),
      );
    if (a === "network" && b === "create") {
      state.networks.set(id(), { name: args.at(-1), labels: labelsOf(args) });
      return ok(id());
    }
    if (a === "network" && b === "rm") {
      for (const [nid, n] of state.networks)
        if (nid === args[2] || n.name === args[2]) {
          state.networks.delete(nid);
          return ok();
        }
      return no("Error: No such network");
    }
    if (a === "volume" && b === "ls")
      return ok(
        [...state.volumes]
          .filter(([, v]) => matches(v.labels, filters(args)))
          .map(([name]) => name)
          .join("\n"),
      );
    if (a === "volume" && b === "create") {
      // Revision 9 adaptation of the fake: a name that exists is answered as it is, labels unchanged, as the real daemon does
      // (checked on colima "atlas", 14 October 2026); revision 8's fake replaced the labels.
      if (!state.volumes.has(args.at(-1)))
        state.volumes.set(args.at(-1), { labels: labelsOf(args) });
      return ok(args.at(-1));
    }
    if (a === "volume" && b === "inspect") {
      const v = state.volumes.get(args.at(-1));
      if (!v) return no("Error: No such volume");
      return ok(args.includes("--format") ? JSON.stringify(v.labels) : "{}");
    }
    if (a === "volume" && b === "rm") {
      if (!state.volumes.delete(args[2])) return no("Error: No such volume");
      return ok();
    }
    if (a === "image" && b === "inspect") {
      const iid = state.images.get(args.at(-1));
      return iid ? ok(iid) : no("Error: No such image");
    }
    if (a === "pull") {
      state.images.set(args.at(-1), `sha256:${pinKey(args.at(-1))}`);
      return ok();
    }
    if (a === "rmi") {
      for (const [ref, iid] of state.images)
        if (iid === args[1]) {
          if (
            [...state.containers.values()].some(
              (c) => state.images.get(c.image) === iid,
            )
          )
            return no("Error: image is being used");
          state.images.delete(ref);
          return ok();
        }
      return no("Error: No such image");
    }
    if (a === "inspect") {
      const c = state.containers.get(args.at(-1));
      return c
        ? ok(c.mounts.map((m) => `${m} `).join(""))
        : no("Error: No such object");
    }
    if (a === "rm") {
      const c = state.containers.get(args.at(-1));
      if (!c) return no("Error: No such container");
      state.containers.delete(args.at(-1));
      for (const m of c.mounts)
        if (m.startsWith("anon-")) state.volumes.delete(m);
      return ok();
    }
    if (a === "run") {
      const image = args.find((x) => x.includes("@sha256:"));
      if (!state.images.has(image))
        state.images.set(image, `sha256:${pinKey(image)}`); // docker run would pull
      const cid = id();
      const named = args[args.indexOf("--name") + 1];
      const mounts = [];
      const v = args.indexOf("-v");
      if (v >= 0) mounts.push(args[v + 1].split(":")[0]);
      if (args.includes("--rm")) return ok("");
      state.containers.set(cid, {
        name: named,
        labels: labelsOf(args),
        image,
        mounts,
      });
      return ok(cid);
    }
    if (a === "exec") return ok("accepting connections");
    if (a === "info") return ok(state.daemon);
    return no(`fake docker does not know: ${args.join(" ")}`);
  };
  return {
    state,
    docker: dockerClient(run),
    /** Another client of the SAME daemon whose command `when(args)` waits for `gate` after (or, with `before`, before) it runs. */
    paused: (when, gate, { before = false } = {}) =>
      dockerClient(async (args) => {
        if (before && when(args)) await gate();
        const answer = await run(args);
        if (!before && when(args)) await gate();
        return answer;
      }),
  };
}

/** A gate: `reached` resolves when the paused command gets there; `release()` lets it go on. */
function gate() {
  let reach;
  let release;
  const reached = new Promise((r) => {
    reach = r;
  });
  const go = new Promise((r) => {
    release = r;
  });
  return {
    reached,
    release: () => release(),
    wait: async () => {
      reach();
      await go;
    },
  };
}
const settledWithin = (promise, ms) =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ]);

const LABELS = {
  [LABEL_INVOCATION]: "inv-1",
  [LABEL_STACK]: "inv-1-0-chromium",
};
const FILTER = `${LABEL_STACK}=inv-1-0-chromium`;

/** Someone else's resources on the same daemon: never touched. */
function foreign(state) {
  state.containers.set("f".repeat(64), {
    name: "someone-else",
    labels: { team: "other" },
    image: "other:1",
    mounts: ["anon-foreign"],
  });
  state.volumes.set("anon-foreign", { labels: {} });
  state.volumes.set("their-volume", { labels: { team: "other" } });
  state.networks.set("e".repeat(64), { name: "their-network", labels: {} });
  state.images.set("other:1", "sha256:other");
}

test("a stack's PostgreSQL pair is created labelled, and disposal by label leaves nothing of it and nothing else changed", async () => {
  const { state, docker } = fakeDaemon();
  foreign(state);
  const started = await startPostgresBackend({
    backendPort: 1,
    origin: "http://127.0.0.1:2",
    names: ["alice", "bob"],
    docker,
    labels: LABELS,
  });
  assert.deepEqual(Object.keys(started.accounts), ["alice", "bob"]);
  for (const c of state.containers.values())
    if (c.name !== "someone-else")
      assert.equal(c.labels[LABEL_STACK], LABELS[LABEL_STACK]);
  // Adapted, labelled (review r7 DA-1, revision 8): every resource of the STACK is labelled with it. The pins' owner records are
  // deliberately not: they belong to the daemon's generation of users and outlive any one stack (they are retired by the last holder,
  // which the final inventory below checks: no volume of this run is left).
  const created = state.log.filter((l) =>
    /^(run|network create|volume create)/.test(l),
  );
  const records = created.filter((l) => /--label atlas\.it\.owner=/.test(l));
  assert.equal(records.length, 2, "one owner record per pin");
  for (const line of records)
    assert.doesNotMatch(line, /atlas\.it\.(stack|invocation)=/, line);
  for (const line of created.filter((l) => !records.includes(l)))
    assert.match(line, /--label atlas\.it\.stack=inv-1-0-chromium/, line);
  assert.equal(
    state.log.some((l) =>
      / -v [^ ]*pgdata:\/var\/lib\/postgresql\/data/.test(` ${l}`),
    ),
    true,
    "a named data volume, no anonymous one",
  );
  const result = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.remaining, {
    containers: [],
    networks: [],
    volumes: [],
    mounted_volumes: [],
  });
  assert.deepEqual(
    result.images.map((i) => [i.ref, i.action]),
    [
      [POSTGRES_IMAGE, "removed"],
      [BACKEND_IMAGE, "removed"],
    ],
  );
  assert.deepEqual(
    [...state.containers.values()].map((c) => c.name),
    ["someone-else"],
  );
  assert.deepEqual([...state.volumes.keys()].sort(), [
    "anon-foreign",
    "their-volume",
  ]);
  assert.deepEqual(
    [...state.networks.values()].map((n) => n.name),
    ["their-network"],
  );
  assert.deepEqual([...state.images.keys()], ["other:1"]);
});

test("a removal that fails, or a mounted volume that stays, is reported with the survivor and is not ok", async () => {
  const { state, docker } = fakeDaemon({
    fail: (args) =>
      args[0] === "rm"
        ? { status: 1, stdout: "", stderr: "permission denied" }
        : null,
  });
  state.containers.set("c".repeat(64), {
    name: "atlas-it-x-pg",
    labels: { ...LABELS },
    image: POSTGRES_IMAGE,
    mounts: ["anon-1"],
  });
  state.volumes.set("anon-1", { labels: {} });
  const result = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.remaining.containers.map((c) => c.name),
    ["atlas-it-x-pg"],
  );
  assert.deepEqual(result.remaining.mounted_volumes, ["anon-1"]);
  assert.match(
    result.errors.join("\n"),
    /docker rm atlas-it-x-pg: exit 1 permission denied/,
  );
});

test("an inventory that cannot be read is unknown, never empty", async () => {
  const { state, docker } = fakeDaemon({
    fail: (args) =>
      args[0] === "ps"
        ? {
            status: 1,
            stdout: "",
            stderr: "Cannot connect to the Docker daemon",
          }
        : null,
  });
  state.containers.set("c".repeat(64), {
    name: "atlas-it-x-pg",
    labels: { ...LABELS },
    image: POSTGRES_IMAGE,
    mounts: [],
  });
  const result = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(result.remaining, "unknown");
  assert.equal(result.ok, false);
  await assert.rejects(inventory(docker, FILTER), /Cannot connect/);
});

test("a container the daemon finishes creating after the first look is found by the next look and removed", async () => {
  const { state, docker } = fakeDaemon();
  let looks = 0;
  state.hooks.afterLook = (s) => {
    looks += 1;
    if (looks === 1)
      // The creation request was already under way when the stack was stopped: it lands just after the first look.
      s.containers.set("d".repeat(64), {
        name: "atlas-it-x-backend",
        labels: { ...LABELS },
        image: BACKEND_IMAGE,
        mounts: [],
      });
  };
  const result = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.removed.containers.map((c) => c.name),
    ["atlas-it-x-backend"],
  );
  assert.equal(state.containers.size, 0);
});

test("DA-1: an image someone else adds meanwhile is never removed; a pinned image that was present before is kept", async () => {
  const { state, docker } = fakeDaemon({
    images: { [POSTGRES_IMAGE]: "sha256:pg-present-before" },
  });
  const pg = await acquireImage(docker, {
    ref: POSTGRES_IMAGE,
    labels: LABELS,
    name: "atlas-it-x-lease-pg",
  });
  const backend = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "atlas-it-x-lease-backend",
  });
  assert.equal(pg.pulled, false);
  assert.equal(backend.pulled, true);
  // Between this run's start and its end, an unrelated user adds an image (the old after-minus-before rule would remove it).
  state.images.set("unrelated:latest", "sha256:unrelated");
  const result = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(result.ok, true, JSON.stringify(result.images));
  assert.equal(state.images.get("unrelated:latest"), "sha256:unrelated");
  assert.equal(state.images.get(POSTGRES_IMAGE), "sha256:pg-present-before");
  assert.equal(state.images.has(BACKEND_IMAGE), false);
  assert.deepEqual(
    Object.fromEntries(result.images.map((i) => [i.lease, i.action])),
    {
      "atlas-it-x-lease-pg": "kept_present_before",
      "atlas-it-x-lease-backend": "removed",
    },
  );
  assert.equal(
    state.log.some(
      (l) => l.startsWith("rmi") && !l.includes(pinKey(BACKEND_IMAGE)),
    ),
    false,
  );
});

test("DA-1: two overlapping invocations share a pulled pin; the first to finish transfers it, the last removes it", async () => {
  const { state, docker } = fakeDaemon();
  const B = { [LABEL_INVOCATION]: "inv-2", [LABEL_STACK]: "inv-2-0-chromium" };
  const a = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  const b = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: B,
    name: "b-lease",
  });
  assert.equal(a.pulled, true);
  assert.equal(
    b.pulled,
    true,
    "present only because A pulled it: the group pulled it",
  );
  const first = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(first.ok, true);
  assert.equal(first.images[0]?.action, "transferred");
  assert.equal(state.images.has(BACKEND_IMAGE), true, "B still uses it");
  const last = await disposeLabelled(docker, {
    filter: `${LABEL_STACK}=inv-2-0-chromium`,
  });
  assert.equal(last.images[0]?.action, "removed");
  assert.equal(state.images.has(BACKEND_IMAGE), false);
});

test("DA-1: a pulled pin that someone else's container uses is kept, and its ownership is reported unsettled (not ok)", async () => {
  const { state, docker } = fakeDaemon();
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  state.containers.set("9".repeat(64), {
    name: "someone-else",
    labels: {},
    image: BACKEND_IMAGE,
    mounts: [],
  });
  const result = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(result.images[0]?.action, "retained_in_use");
  assert.equal(result.ok, false);
  assert.equal(state.images.has(BACKEND_IMAGE), true);
  assert.equal(state.containers.has("9".repeat(64)), true);
});

test("H4a: a stop while PostgreSQL is starting ends the readiness wait; what was created is found by label and removed", async () => {
  const { state, docker } = fakeDaemon();
  const controller = new AbortController();
  const starting = startPostgresBackend({
    backendPort: 1,
    origin: "http://127.0.0.1:2",
    names: ["alice"],
    docker,
    labels: LABELS,
    signal: controller.signal,
    at: async (name) => {
      if (name === "postgres:readiness")
        controller.abort(new Cancelled("received SIGTERM"));
    },
  });
  await assert.rejects(starting, Cancelled);
  assert.equal(
    [...state.containers.values()].filter((c) => c.labels[LABEL_STACK]).length,
    1,
    "PostgreSQL itself was created before the stop",
  );
  assert.equal(
    state.log.some((l) => l.includes("account")),
    false,
    "nothing more was created after the stop",
  );
  const result = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(result.ok, true);
  assert.equal(state.containers.size, 0);
  assert.equal(state.networks.size, 0);
  assert.equal(state.volumes.size, 0);
});

// ---- review r7 DA-1 (revision 8): the obligation to remove a pulled pin is never lost between users ------------------------------
const B = { [LABEL_INVOCATION]: "inv-2", [LABEL_STACK]: "inv-2-0-chromium" };
const FILTER_B = `${LABEL_STACK}=inv-2-0-chromium`;
const isRmi = (args) => args[0] === "rmi";

test("DA-1 control: serial acquisition while A still holds its lease; the last disposal removes the image and retires the record", async () => {
  const { state, docker } = fakeDaemon();
  const a = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  const b = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: B,
    name: "b-lease",
  });
  assert.equal(a.pulled, true);
  assert.equal(b.joined, true);
  assert.equal(b.generation, a.generation);
  assert.equal(
    (await disposeLabelled(docker, { filter: FILTER })).images[0]?.action,
    "transferred",
  );
  const last = await disposeLabelled(docker, { filter: FILTER_B });
  assert.equal(last.ok, true);
  assert.equal(last.images[0]?.action, "removed");
  assert.equal(state.images.has(BACKEND_IMAGE), false);
  assert.equal(state.volumes.has(recordName(pinKey(BACKEND_IMAGE))), false);
});

test("DA-1 (the reviewer's schedule): A paused just after its lease is removed, B acquires, A resumes: the image is still removed", async () => {
  const { state, docker, paused } = fakeDaemon();
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  const g = gate();
  const aClient = paused(
    (args) => args[0] === "volume" && args[1] === "rm" && args[2] === "a-lease",
    g.wait,
  );
  const disposing = disposeLabelled(aClient, { filter: FILTER });
  await g.reached;
  let b;
  try {
    b = await acquireImage(docker, {
      ref: BACKEND_IMAGE,
      labels: B,
      name: "b-lease",
    });
  } finally {
    g.release();
  }
  const a = await disposing;
  assert.equal(a.ok, true, JSON.stringify(a.images));
  assert.equal(
    a.images[0]?.action,
    "removed",
    "A was the last holder: it removed the image before giving up the lock",
  );
  assert.equal(
    b.pulled,
    true,
    "B found the image absent and started a new generation that must remove it",
  );
  assert.equal(b.joined, false);
  const last = await disposeLabelled(docker, { filter: FILTER_B });
  assert.equal(last.ok, true, JSON.stringify(last.images));
  assert.equal(last.images[0]?.action, "removed");
  assert.equal(
    state.images.has(BACKEND_IMAGE),
    false,
    "the initially absent image is gone",
  );
  assert.equal(state.volumes.size, 0, "no lease and no owner record is left");
});

test("DA-1: an acquisition while the last holder is removing waits for the lock; it never registers into the image being removed", async () => {
  const { state, docker, paused } = fakeDaemon();
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  const g = gate();
  // A has decided it is the last holder and is about to remove the image (inside the lock).
  const disposing = disposeLabelled(paused(isRmi, g.wait, { before: true }), {
    filter: FILTER,
  });
  await g.reached;
  const acquiring = acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: B,
    name: "b-lease",
  });
  assert.equal(
    await settledWithin(acquiring, 300),
    false,
    "B waits while A holds the lock",
  );
  assert.equal(
    state.volumes.has("b-lease"),
    false,
    "B registered nothing meanwhile",
  );
  g.release();
  const [a, b] = [await disposing, await acquiring];
  assert.equal(a.images[0]?.action, "removed");
  assert.equal(b.joined, false);
  assert.equal(b.pulled, true);
  assert.ok(
    state.log.findIndex((l) => l.startsWith("rmi")) <
      state.log.findIndex((l) => l.endsWith(" b-lease")),
    "B's registration comes after A's removal",
  );
  assert.equal(
    (await disposeLabelled(docker, { filter: FILTER_B })).images[0]?.action,
    "removed",
  );
  assert.equal(state.images.has(BACKEND_IMAGE), false);
});

test("DA-1: B held between its baseline look and its registration; A's release waits, then sees B in its generation", async () => {
  const { state, docker, paused } = fakeDaemon();
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  const g = gate();
  const bClient = paused(
    (args) => args[0] === "image" && args[1] === "inspect",
    g.wait,
  );
  const acquiring = acquireImage(bClient, {
    ref: BACKEND_IMAGE,
    labels: B,
    name: "b-lease",
  });
  await g.reached;
  const disposing = disposeLabelled(docker, { filter: FILTER });
  assert.equal(
    await settledWithin(disposing, 300),
    false,
    "A's release waits for B's decision",
  );
  assert.equal(
    state.log.some((l) => l.startsWith("rmi")),
    false,
    "nothing was removed while B was deciding",
  );
  g.release();
  const b = await acquiring;
  const a = await disposing;
  assert.equal(b.joined, true);
  assert.equal(
    b.pulled,
    true,
    "B joined A's generation, so it inherits the obligation",
  );
  assert.equal(a.images[0]?.action, "transferred");
  assert.deepEqual(a.images[0]?.to, ["b-lease"]);
  assert.equal(state.images.has(BACKEND_IMAGE), true, "B uses it");
  assert.equal(
    (await disposeLabelled(docker, { filter: FILTER_B })).images[0]?.action,
    "removed",
  );
  assert.equal(state.images.has(BACKEND_IMAGE), false);
});

test("DA-1: simultaneous acquisitions share one generation; simultaneous releases remove the image exactly once", async () => {
  const { state, docker } = fakeDaemon();
  const [a, b] = await Promise.all([
    acquireImage(docker, {
      ref: BACKEND_IMAGE,
      labels: LABELS,
      name: "a-lease",
    }),
    acquireImage(docker, { ref: BACKEND_IMAGE, labels: B, name: "b-lease" }),
  ]);
  assert.equal(a.generation, b.generation);
  assert.equal(a.pulled && b.pulled, true);
  assert.equal([a.joined, b.joined].filter(Boolean).length, 1);
  const results = await Promise.all([
    disposeLabelled(docker, { filter: FILTER }),
    disposeLabelled(docker, { filter: FILTER_B }),
  ]);
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true],
  );
  assert.deepEqual(results.map((r) => r.images[0]?.action).sort(), [
    "removed",
    "transferred",
  ]);
  assert.equal(state.log.filter((l) => l.startsWith("rmi")).length, 1);
  assert.equal(state.images.has(BACKEND_IMAGE), false);
  assert.equal(state.volumes.size, 0);
});

test("DA-1: released in either order, the last of two holders removes the image", async () => {
  for (const order of [
    [FILTER, FILTER_B],
    [FILTER_B, FILTER],
  ]) {
    const { state, docker } = fakeDaemon();
    await acquireImage(docker, {
      ref: POSTGRES_IMAGE,
      labels: LABELS,
      name: "a-lease",
    });
    await acquireImage(docker, {
      ref: POSTGRES_IMAGE,
      labels: B,
      name: "b-lease",
    });
    const first = await disposeLabelled(docker, { filter: order[0] });
    const last = await disposeLabelled(docker, { filter: order[1] });
    assert.equal(first.images[0]?.action, "transferred");
    assert.equal(last.images[0]?.action, "removed");
    assert.equal(state.images.has(POSTGRES_IMAGE), false);
  }
});

test("DA-1: the runner's disposal and its reaper's, racing on one stack, remove the image once and both say what is true", async () => {
  const { state, docker } = fakeDaemon();
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  const [runner, reaper] = await Promise.all([
    disposeLabelled(docker, { filter: FILTER }),
    disposeLabelled(dockerClient(docker.run), { filter: FILTER }),
  ]);
  assert.deepEqual([runner.ok, reaper.ok], [true, true]);
  assert.deepEqual(
    [...runner.images, ...reaper.images].map((i) => i.action).sort(),
    ["generation_settled", "removed"],
  );
  assert.equal(state.log.filter((l) => l.startsWith("rmi")).length, 1);
  assert.equal(state.images.has(BACKEND_IMAGE), false);
});

test("DA-1: a removal that fails keeps the obligation in the record; the next user inherits it and removes the image", async () => {
  let refuse = true;
  const { state, docker } = fakeDaemon({
    fail: (args) =>
      refuse && args[0] === "rmi"
        ? { status: 1, stdout: "", stderr: "Error: conflict" }
        : null,
  });
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  const failed = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(failed.ok, false);
  assert.equal(failed.images[0]?.action, "remove_failed");
  assert.equal(failed.images[0]?.obligation, recordName(pinKey(BACKEND_IMAGE)));
  assert.equal(state.images.has(BACKEND_IMAGE), true);
  assert.equal(
    state.volumes.has(recordName(pinKey(BACKEND_IMAGE))),
    true,
    "the obligation survives the failure",
  );
  refuse = false;
  // The image is PRESENT now, but the record says this generation pulled it: the next user joins and inherits the obligation.
  const b = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: B,
    name: "b-lease",
  });
  assert.equal(b.joined, true);
  assert.equal(b.pulled, true);
  const last = await disposeLabelled(docker, { filter: FILTER_B });
  assert.equal(last.images[0]?.action, "removed");
  assert.equal(state.images.has(BACKEND_IMAGE), false);
  assert.equal(state.volumes.size, 0);
});

test("DA-1: an image someone else's container uses is kept with its obligation, and the clean-up is not ok", async () => {
  const { state, docker } = fakeDaemon();
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  state.containers.set("9".repeat(64), {
    name: "someone-else",
    labels: {},
    image: BACKEND_IMAGE,
    mounts: [],
  });
  const result = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(result.ok, false);
  assert.equal(result.images[0]?.action, "retained_in_use");
  assert.equal(state.volumes.has(recordName(pinKey(BACKEND_IMAGE))), true);
  assert.equal(state.containers.has("9".repeat(64)), true);
  assert.equal(state.images.has(BACKEND_IMAGE), true);
});

test("DA-1: when the daemon cannot be identified, nothing is acquired and a release is unknown and not ok; the lease stays", async () => {
  let broken = false;
  const { state, docker } = fakeDaemon({
    fail: (args) =>
      broken && args[0] === "info"
        ? { status: 1, stdout: "", stderr: "Cannot connect" }
        : null,
  });
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  broken = true;
  const other = fakeDaemon({
    fail: (args) =>
      args[0] === "info"
        ? { status: 1, stdout: "", stderr: "Cannot connect" }
        : null,
  });
  await assert.rejects(
    acquireImage(other.docker, {
      ref: BACKEND_IMAGE,
      labels: B,
      name: "b-lease",
    }),
    /docker info failed/,
  );
  assert.equal(other.state.volumes.size, 0);
  // A fresh client (no remembered daemon id) cannot take the lock: the release cannot be decided.
  const result = await disposeLabelled(dockerClient(docker.run), {
    filter: FILTER,
  });
  assert.equal(result.ok, false);
  assert.equal(result.images[0]?.action, "unknown");
  assert.equal(
    result.images[0]?.obligation,
    recordName(pinKey(BACKEND_IMAGE)),
    "an undecided release names the record that may still hold its obligation",
  );
  assert.equal(state.volumes.has("a-lease"), true);
  assert.equal(state.images.has(BACKEND_IMAGE), true);
});

test("DA-1: a stale record that says 'present before' for an image that has gone, with no holder, does not hide a new pull", async () => {
  const { state, docker } = fakeDaemon({
    images: { [BACKEND_IMAGE]: "sha256:was-here" },
  });
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  // The controller died before it released: its lease went with the reaper's stack clean-up, the record stayed.
  state.volumes.delete("a-lease");
  state.images.delete(BACKEND_IMAGE); // someone removed the image later
  const b = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: B,
    name: "b-lease",
  });
  assert.equal(b.joined, false);
  assert.equal(b.pulled, true);
  assert.equal(
    (await disposeLabelled(docker, { filter: FILTER_B })).images[0]?.action,
    "removed",
  );
  assert.equal(state.images.has(BACKEND_IMAGE), false);
});

test("DA-1: a leftover lease of a settled generation holds nothing: the next generation's last user still removes the image", async () => {
  let keepLease = true;
  const { state, docker } = fakeDaemon({
    fail: (args) =>
      keepLease && args.join(" ") === "volume rm a-lease"
        ? { status: 1, stdout: "", stderr: "Error: volume is in use" }
        : null,
  });
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  const a = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(
    a.ok,
    false,
    "A's lease could not be removed: its clean-up is not ok",
  );
  assert.equal(
    state.images.has(BACKEND_IMAGE),
    false,
    "but its generation was settled: the image is gone",
  );
  assert.equal(state.volumes.has("a-lease"), true);
  const b = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: B,
    name: "b-lease",
  });
  assert.equal(b.joined, false);
  const last = await disposeLabelled(docker, { filter: FILTER_B });
  assert.equal(
    last.images[0]?.action,
    "removed",
    "A's leftover is not a holder of B's generation",
  );
  assert.equal(state.images.has(BACKEND_IMAGE), false);
  keepLease = false;
  const retry = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(retry.ok, true);
  assert.equal(retry.images[0]?.action, "generation_settled");
  assert.equal(state.volumes.size, 0);
});

test("DA-1: when the containers cannot be listed, the stack's image release is still attempted and names its pending obligation", async () => {
  let broken = false;
  const { state, docker } = fakeDaemon({
    fail: (args) =>
      broken && args[0] === "ps"
        ? {
            status: 1,
            stdout: "",
            stderr: "Cannot connect to the Docker daemon",
          }
        : null,
  });
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  state.containers.set("c".repeat(64), {
    name: "atlas-it-x-backend",
    labels: { ...LABELS },
    image: BACKEND_IMAGE,
    mounts: [],
  });
  broken = true;
  const result = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(result.remaining, "unknown");
  assert.equal(result.ok, false);
  assert.equal(
    result.images.length,
    1,
    "the lease was found although the containers could not be listed",
  );
  assert.equal(result.images[0]?.action, "unknown");
  assert.equal(result.images[0]?.obligation, recordName(pinKey(BACKEND_IMAGE)));
  assert.equal(
    state.images.has(BACKEND_IMAGE),
    true,
    "nothing is removed while its users cannot be seen",
  );
  assert.equal(state.volumes.has(recordName(pinKey(BACKEND_IMAGE))), true);
  assert.equal(state.volumes.has("a-lease"), true);
});

// ---- review r8 DA-1a (revision 9): unfinished work left beside the lock is settled by the next holder --------------------------------

const LOST = { status: null, stdout: "", stderr: "", timedOut: true };
/** A client of the same daemon whose matching command's answer is lost (`land`: the daemon did it anyway) or that dies there (`die`). */
function lossy(docker, when, { land = true, die = false } = {}) {
  return dockerClient(async (args, options) => {
    if (!when(args)) return docker.run(args, options);
    if (die) throw new Error(`the holder died at: docker ${args.join(" ")}`);
    if (land) await docker.run(args, options);
    return LOST;
  });
}
const isRecordRemoval = (args) =>
  args[0] === "volume" &&
  args[1] === "rm" &&
  args[2] === recordName(pinKey(BACKEND_IMAGE));
const noteOf = (state) =>
  intentOf(lockPath(state.daemon, pinKey(BACKEND_IMAGE)));

test("DA-1a: a release whose removal answer was lost (and that did not happen) leaves its note; the next acquisition finishes it first", async () => {
  const { state, docker } = fakeDaemon();
  foreign(state);
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  const a = await disposeLabelled(
    lossy(docker, (args) => args[0] === "rmi", { land: false }),
    { filter: FILTER },
  );
  assert.equal(a.ok, false);
  assert.equal(a.images[0]?.action, "remove_failed");
  assert.equal(
    noteOf(state)?.op,
    "release",
    "the answer was lost: the work is not settled",
  );
  assert.equal(noteOf(state)?.step, "drop_lease");
  const b = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: B,
    name: "b-lease",
  });
  assert.equal(b.recovered?.op, "release");
  assert.equal(
    b.recovered?.action,
    "removed",
    "the next holder removed what the releaser could not confirm",
  );
  assert.equal(b.pulled, true, "a new generation, which pulled again");
  assert.equal(b.joined, false);
  assert.equal(noteOf(state), null, "settled");
  const last = await disposeLabelled(docker, { filter: FILTER_B });
  assert.equal(last.ok, true, JSON.stringify(last.images));
  assert.equal(state.images.has(BACKEND_IMAGE), false);
  assert.equal(state.volumes.has(recordName(pinKey(BACKEND_IMAGE))), false);
  assert.equal(
    state.images.get("other:1"),
    "sha256:other",
    "unrelated image kept",
  );
  assert.equal(
    state.volumes.has("their-volume"),
    true,
    "unrelated volume kept",
  );
});

test("DA-1a: a releaser that died after removing the image, before retiring the record: the next holder retires it and removes the lease", async () => {
  const { state, docker } = fakeDaemon();
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  const a = await disposeLabelled(
    lossy(docker, isRecordRemoval, { die: true }),
    { filter: FILTER },
  );
  assert.equal(a.images[0]?.action, "unknown");
  assert.equal(a.images[0]?.ok, false);
  assert.equal(noteOf(state)?.step, "retire_record");
  assert.equal(
    state.images.has(BACKEND_IMAGE),
    false,
    "the image went before the death",
  );
  assert.equal(
    state.volumes.has(recordName(pinKey(BACKEND_IMAGE))),
    true,
    "its record did not",
  );
  const b = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: B,
    name: "b-lease",
  });
  assert.equal(b.recovered?.action, "already_absent");
  assert.equal(
    state.volumes.has("a-lease"),
    false,
    "the dead releaser's lease holds nothing and is gone",
  );
  assert.equal(b.pulled, true);
  assert.notEqual(b.generation, undefined);
  const last = await disposeLabelled(docker, { filter: FILTER_B });
  assert.equal(last.ok, true, JSON.stringify(last.images));
  assert.equal(state.images.has(BACKEND_IMAGE), false);
  assert.equal(state.volumes.has(recordName(pinKey(BACKEND_IMAGE))), false);
});

test("DA-1a: a releaser that died before the removal: the next holder decides it again, and a holder that joined meanwhile is never possible", async () => {
  const { state, docker } = fakeDaemon();
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  const a = await disposeLabelled(
    lossy(docker, (args) => args[0] === "rmi", { die: true }),
    { filter: FILTER },
  );
  assert.equal(a.images[0]?.action, "unknown");
  assert.equal(noteOf(state)?.step, "remove_image");
  assert.equal(state.images.has(BACKEND_IMAGE), true);
  // The next holder is the dead releaser's own reaper (its disposal by label finds the lease again).
  const reaper = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(reaper.ok, true, JSON.stringify(reaper.images));
  assert.equal(reaper.images[0]?.recovered?.action, "removed");
  assert.equal(state.images.has(BACKEND_IMAGE), false);
  assert.equal(state.volumes.has(recordName(pinKey(BACKEND_IMAGE))), false);
  assert.equal(noteOf(state), null);
});

test("DA-1a: an acquisition that died after creating the record and before its lease: the next one joins that generation (read back)", async () => {
  const { state, docker } = fakeDaemon();
  const isLease = (args) =>
    args[0] === "volume" && args[1] === "create" && args.at(-1) === "a-lease";
  await assert.rejects(
    acquireImage(lossy(docker, isLease, { die: true }), {
      ref: BACKEND_IMAGE,
      labels: LABELS,
      name: "a-lease",
    }),
    /died/,
  );
  assert.equal(noteOf(state)?.op, "acquire");
  assert.equal(noteOf(state)?.step, "register_lease");
  const record = state.volumes.get(recordName(pinKey(BACKEND_IMAGE)));
  const b = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: B,
    name: "b-lease",
  });
  assert.equal(b.recovered?.op, "acquire");
  assert.equal(b.joined, true);
  assert.equal(b.generation, record.labels["atlas.it.generation"]);
  assert.equal(b.pulled, true);
  assert.equal(noteOf(state), null);
  const last = await disposeLabelled(docker, { filter: FILTER_B });
  assert.equal(last.images[0]?.action, "removed");
  assert.equal(state.images.has(BACKEND_IMAGE), false);
});

test("DA-1a: a record that landed first (an earlier holder's late creation) is the generation every later decision uses", async () => {
  const { state, docker } = fakeDaemon();
  const name = recordName(pinKey(BACKEND_IMAGE));
  const landing = dockerClient(async (args, options) => {
    if (args[0] === "volume" && args[1] === "create" && args.at(-1) === name)
      state.volumes.set(name, {
        labels: {
          "atlas.it.owner": pinKey(BACKEND_IMAGE),
          "atlas.it.generation": "landed-first",
          "atlas.it.pulled": "true",
          "atlas.it.image": BACKEND_IMAGE,
        },
      });
    return docker.run(args, options);
  });
  const a = await acquireImage(landing, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  assert.equal(a.generation, "landed-first");
  assert.equal(a.joined, true);
  assert.equal(
    state.volumes.get("a-lease")?.labels["atlas.it.generation"],
    "landed-first",
  );
  const done = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(
    done.images[0]?.action,
    "removed",
    "the lease counts in the generation the record names",
  );
  assert.equal(state.images.has(BACKEND_IMAGE), false);
});

test("DA-1a: unfinished work that cannot be settled (an answer lost again), or a note that cannot be read: nothing is decided", async () => {
  const { state, docker } = fakeDaemon();
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  await disposeLabelled(
    lossy(docker, (args) => args[0] === "rmi", { die: true }),
    { filter: FILTER },
  );
  const before = noteOf(state);
  assert.equal(before?.step, "remove_image");
  const blind = lossy(
    docker,
    (args) => args[0] === "image" && args[1] === "inspect",
    { land: true },
  );
  await assert.rejects(
    acquireImage(blind, { ref: BACKEND_IMAGE, labels: B, name: "b-lease" }),
    /could not be settled/,
  );
  assert.equal(state.volumes.has("b-lease"), false, "nothing registered");
  assert.deepEqual(noteOf(state), before, "the note stays for the next holder");
  writeFileSync(
    `${lockPath(state.daemon, pinKey(BACKEND_IMAGE))}.intent`,
    "{ torn",
  );
  const refused = await disposeLabelled(docker, { filter: FILTER });
  assert.equal(refused.ok, false);
  assert.equal(refused.images[0]?.action, "unknown");
  assert.match(refused.images[0]?.error ?? "", /cannot be read/);
  assert.equal(
    state.images.has(BACKEND_IMAGE),
    true,
    "nothing removed on an unreadable note",
  );
  assert.equal(
    existsSync(`${lockPath(state.daemon, pinKey(BACKEND_IMAGE))}.intent`),
    true,
  );
});

test("DA-1a: a re-drive whose removal answer is lost (the removal landed) refuses; the next holder then finds the work settled", async () => {
  const { state, docker } = fakeDaemon();
  await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: LABELS,
    name: "a-lease",
  });
  await disposeLabelled(
    lossy(docker, (args) => args[0] === "rmi", { die: true }),
    { filter: FILTER },
  );
  assert.equal(noteOf(state)?.step, "remove_image");
  // B settles A's release, but the answer to its own removal is lost (the daemon did remove it).
  await assert.rejects(
    acquireImage(
      lossy(docker, (args) => args[0] === "rmi", { land: true }),
      { ref: BACKEND_IMAGE, labels: B, name: "b-lease" },
    ),
    /could not be settled \(an answer was lost\)/,
  );
  assert.equal(
    state.volumes.has("b-lease"),
    false,
    "B decided nothing of its own",
  );
  assert.equal(noteOf(state)?.step, "remove_image", "A's note stays");
  assert.equal(state.images.has(BACKEND_IMAGE), false);
  // The next holder settles it from what is there now: nothing left to remove.
  const c = await acquireImage(docker, {
    ref: BACKEND_IMAGE,
    labels: B,
    name: "b-lease",
  });
  assert.equal(c.recovered?.op, "release");
  assert.equal(noteOf(state), null);
  const last = await disposeLabelled(docker, { filter: FILTER_B });
  assert.equal(last.ok, true, JSON.stringify(last.images));
  assert.equal(state.images.has(BACKEND_IMAGE), false);
  assert.equal(state.volumes.has(recordName(pinKey(BACKEND_IMAGE))), false);
});
