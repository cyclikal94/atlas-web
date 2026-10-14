import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireImage,
  disposeLabelled,
  dockerClient,
  inventory,
  LABEL_INVOCATION,
  LABEL_STACK,
  pinKey,
} from "./docker-resources.mjs";
import { Cancelled } from "./ownership.mjs";
import {
  BACKEND_IMAGE,
  POSTGRES_IMAGE,
  startPostgresBackend,
} from "./postgres-backend.mjs";

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
    return no(`fake docker does not know: ${args.join(" ")}`);
  };
  return { state, docker: dockerClient(run) };
}

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
  for (const line of state.log.filter((l) =>
    /^(run|network create|volume create)/.test(l),
  ))
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
  assert.equal(first.images[0].action, "transferred");
  assert.equal(state.images.has(BACKEND_IMAGE), true, "B still uses it");
  const last = await disposeLabelled(docker, {
    filter: `${LABEL_STACK}=inv-2-0-chromium`,
  });
  assert.equal(last.images[0].action, "removed");
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
  assert.equal(result.images[0].action, "retained_in_use");
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
