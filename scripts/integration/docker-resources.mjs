// The Docker resources of an integration run: labelled at creation, found again by label, removed and then VERIFIED gone (WEB-08d
// review r6, H4a and the design assessment's DA-1).
//
// Every container, network and volume a run creates carries `atlas.it.invocation=<invocation>` and `atlas.it.stack=<stack>`, so a
// creation whose answer was lost, or a container created while the runner was being stopped, is still found: disposal lists by label,
// it never relies on the ids it happened to receive. Removal statuses are checked, and success means the labelled inventory is
// empty afterwards (twice, a moment apart, so a creation the daemon was still completing is caught), the anonymous volumes the
// containers had mounted are gone and the images are as the image policy says. An inventory that cannot be read is `unknown`, never empty.
//
// Images (review r7 DA-1, revision 8): only the two PINNED images are ever considered, never "every image that was not there before"
// (that would remove an image another user or invocation added meanwhile). For each pin, the DAEMON holds a durable OWNER RECORD (a
// volume `atlas-it-image-<key>`, not labelled with any invocation or stack) of one generation of users: whether that generation found
// the image absent (`pulled`, so it must be removed again) and an id for the generation. Each user registers a LEASE volume (labelled
// like the rest of its stack) in that generation. Taking the baseline and registering, and the last holder's release (removal, then
// retiring the record), are one decision each under a lock shared by every participant on this host (`host-lock.mjs`, keyed by the
// daemon's id and the pin): the runner, its reaper and other invocations. So no acquisition falls between a release and the removal it
// decided, and the obligation exists continuously: in the record until the image is verified gone. A failed or refused removal (an
// image someone else's container uses, `rmi` failing, an inventory that cannot be read) keeps the record, so the next user of the pin
// inherits the obligation, and the clean-up is not ok. A user outside this protocol pulling the same pin cannot be told apart.
//
// Review r8 DA-1a (revision 9): the lock is the kernel's (`host-lock.mjs`): nothing takes it over, and every docker command issued
// under it holds it too (the locked descriptor is its extra stdio entry), so a holder that dies mid-command keeps the pin locked
// until that command has ended. Each transaction notes what it is about to do beside the lock before its first effect; a holder that
// ends without settling (it died, or an answer was lost: a command that timed out or was killed) leaves that note, and the next
// holder of the pin first brings the unfinished work to a settled state from fresh reads (a release is decided again exactly as the
// releaser would have; an acquisition needs nothing, its effects are found by what they are), or refuses to decide anything.
// A record created under the lock is read back: the record on the daemon, not the one this process meant to create, is the truth.
// Not covered (no host lock can): a request a dead command had already sent that the daemon completes only after a later holder has
// looked. That needs coordination by the daemon itself.
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withHostLock } from "./host-lock.mjs";

export const DOCKER_CONTEXT = "colima-atlas";
export const LABEL_INVOCATION = "atlas.it.invocation";
export const LABEL_STACK = "atlas.it.stack";
const LABEL_LEASE = "atlas.it.lease";
const LABEL_PULLED = "atlas.it.pulled";
const LABEL_IMAGE = "atlas.it.image";
const LABEL_OWNER = "atlas.it.owner";
const LABEL_GENERATION = "atlas.it.generation";

/** The owner record of a pin (a volume on the daemon). */
export const recordName = (key) => `atlas-it-image-${key}`;

/**
 * Where the image locks live: ONE place for every participant on this host, whatever TMPDIR each was given (the shared validation
 * driver gives every step its own). `ATLAS_INTEGRATION_COORDINATION_DIR` overrides it (tests).
 */
export const coordinationDir = () =>
  process.env.ATLAS_INTEGRATION_COORDINATION_DIR ??
  join(
    process.platform === "win32" ? tmpdir() : "/tmp",
    `atlas-integration-coordination-${process.getuid?.() ?? "user"}`,
  );

export const pinKey = (ref) =>
  createHash("sha256").update(ref).digest("hex").slice(0, 16);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (text) =>
  String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const absent = (r) =>
  /no such (image|object|volume|container|network)/i.test(`${r.stderr}`);

/**
 * `run(args, options)` -> { status, stdout, stderr } runs the docker CLI (the runner gives it an owned, bounded, possibly abortable
 * process; the reaper a plain one). Returns the operations every user of this module needs. `lock` holds options for the image locks
 * (`withHostLock`: a test's bound or process-table reader); the default is the production one.
 */
export function dockerClient(run, { lock = {} } = {}) {
  const must = async (args, what, options) => {
    const r = await run(args, options);
    if (r.status !== 0)
      throw new Error(
        `${what} failed (${r.timedOut ? "timed out" : `exit ${r.status}`}):\n${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
      );
    return String(r.stdout ?? "").trim();
  };
  return { run, must, lock };
}

export const labelArgs = (labels) =>
  Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);

/** Everything carrying `filter` (`key=value`): containers (id, name), networks (id, name), volumes (name). Throws when unreadable. */
export async function inventory(docker, filter) {
  const containers = lines(
    await docker.must(
      [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `label=${filter}`,
        "--format",
        "{{.ID}} {{.Names}}",
      ],
      "docker ps",
      { whenStopped: true, timeoutMs: 30_000 },
    ),
  ).map((l) => {
    const [id, name] = l.split(" ");
    return { id, name };
  });
  const networks = lines(
    await docker.must(
      [
        "network",
        "ls",
        "--no-trunc",
        "--filter",
        `label=${filter}`,
        "--format",
        "{{.ID}} {{.Name}}",
      ],
      "docker network ls",
      { whenStopped: true, timeoutMs: 30_000 },
    ),
  ).map((l) => {
    const [id, name] = l.split(" ");
    return { id, name };
  });
  const volumes = lines(
    await docker.must(
      ["volume", "ls", "-q", "--filter", `label=${filter}`],
      "docker volume ls",
      { whenStopped: true, timeoutMs: 30_000 },
    ),
  );
  return { containers, networks, volumes };
}

/** The pinned image's id now, or null when it is not present; throws when that cannot be told. */
export async function imageId(docker, ref, options = {}) {
  const r = await docker.run(["image", "inspect", "--format", "{{.Id}}", ref], {
    timeoutMs: 30_000,
    ...options,
  });
  if (r.status === 0) return String(r.stdout).trim();
  if (absent(r)) return null;
  throw new Error(
    `docker image inspect ${ref} failed: ${r.stderr ?? ""}`.trim(),
  );
}

const daemons = new WeakMap();
/** The daemon's own id (the lock must be per daemon: a context name can point anywhere). Throws when it cannot be read. */
async function daemonId(docker) {
  if (!daemons.has(docker)) {
    const id = await docker.must(
      ["info", "--format", "{{.ID}}"],
      "docker info",
      { whenStopped: true, timeoutMs: 30_000 },
    );
    if (!/^[A-Za-z0-9:_-]+$/.test(id))
      throw new Error(
        `docker info gave no usable daemon id: ${JSON.stringify(id)}`,
      );
    daemons.set(docker, id.replaceAll(":", "_"));
  }
  return daemons.get(docker);
}

/** The lock file of pin `key` on daemon `daemon` (`.exlock`: a revision-8 lock DIRECTORY at `.lock` is another protocol). */
export const lockPath = (daemon, key) =>
  join(coordinationDir(), `${daemon}-${key}.exlock`);

/**
 * A client whose commands hold the pin's lock while they run (the locked descriptor is their fourth stdio entry), and which
 * remembers whether any answer was lost (a command that timed out, was killed or did not start): the work is then not settled.
 */
function lockedClient(docker, held) {
  const client = dockerClient(
    async (args, options = {}) => {
      const r = await docker.run(args, { ...options, hold: held.fd });
      if (r.status === null || r.status === undefined || r.timedOut)
        client.ambiguous = true;
      return r;
    },
    { lock: docker.lock },
  );
  client.ambiguous = false;
  return client;
}

/**
 * Run `fn(locked, held)` holding this daemon's lock for pin `key`, after settling any work an earlier holder left unfinished. The work
 * `fn` noted is settled when it returns with every answer known; otherwise (it threw, or an answer was lost) the note stays for the
 * next holder. `lock` passes options to `withHostLock` (tests: bounds). Returns { value, recovered }.
 */
export async function withImageLock(docker, key, fn, options = {}) {
  const path = lockPath(await daemonId(docker), key);
  return withHostLock(
    path,
    async (held) => {
      let recovered = null;
      if (held.previous) {
        const d = lockedClient(docker, held);
        const unsettled = (why) =>
          new Error(
            `the unfinished ${held.previous.op ?? "work"} an earlier holder of ${path} left could not be settled (${why}); nothing was decided`,
          );
        try {
          recovered = await settlePrevious(d, key, held.previous);
        } catch (error) {
          throw unsettled(String(error?.message ?? error));
        }
        if (d.ambiguous) throw unsettled("an answer was lost");
      }
      const d = lockedClient(docker, held);
      const value = await fn(d, held);
      if (!d.ambiguous) held.settle();
      return { value, recovered };
    },
    { ...docker.lock, ...options },
  );
}

/**
 * Bring an earlier holder's unfinished work to a settled state, from fresh reads, before anything else is decided. An acquisition's
 * effects (a record, a lease) are found by what they are: the next decision reads them. A release is decided again as its releaser
 * would have (the same function), and its lease removed when that decision leaves it holding nothing. Throws when it cannot be done.
 */
async function settlePrevious(d, key, previous) {
  const by = previous.holder ?? null;
  if (previous.unreadable)
    throw new Error(
      `an earlier holder's unfinished work cannot be read (${previous.unreadable}); nothing was decided`,
    );
  if (previous.key !== key)
    throw new Error(
      `the unfinished work beside this lock is for another pin (${previous.key}); nothing was decided`,
    );
  if (previous.op === "acquire")
    return { op: "acquire", by, step: previous.step, action: "reread" };
  if (previous.op === "release") {
    const lease = {
      name: previous.lease,
      key,
      ref: previous.ref,
      pulled: previous.pulled,
      generation: previous.generation,
    };
    const sink = { removed: { volumes: [] } };
    const { out, inert } = await decideRelease(d, lease, {}, sink, null);
    if (inert) await dropLeaseOf(d, lease, out, sink);
    return { op: "release", by, step: previous.step, ...out };
  }
  throw new Error(
    `an earlier holder left unfinished work of an unknown kind (${previous.op}); nothing was decided`,
  );
}

const volumeLabels = async (docker, name) => {
  const r = await docker.run(
    ["volume", "inspect", "--format", "{{json .Labels}}", name],
    { whenStopped: true, timeoutMs: 30_000 },
  );
  if (r.status !== 0) {
    if (absent(r)) return null;
    throw new Error(`docker volume inspect ${name} failed: ${r.stderr}`);
  }
  return JSON.parse(String(r.stdout).trim() || "{}") ?? {};
};

/** The pin's owner record, or null when there is none; throws when that cannot be told. */
async function ownerRecord(docker, key) {
  const labels = await volumeLabels(docker, recordName(key));
  if (labels === null) return null;
  return {
    name: recordName(key),
    generation: labels[LABEL_GENERATION] ?? null,
    pulled: labels[LABEL_PULLED] === "true",
    ref: labels[LABEL_IMAGE] ?? null,
  };
}

async function createRecord(docker, key, ref, pulled) {
  const record = {
    name: recordName(key),
    generation: randomBytes(8).toString("hex"),
    pulled,
    ref,
  };
  await docker.must(
    [
      "volume",
      "create",
      ...labelArgs({
        [LABEL_OWNER]: key,
        [LABEL_GENERATION]: record.generation,
        [LABEL_PULLED]: String(pulled),
        [LABEL_IMAGE]: ref,
      }),
      record.name,
    ],
    `owner record ${ref}`,
    { abortable: false, timeoutMs: 60_000 },
  );
  return record;
}

/** Remove a volume; true when it is gone (it was removed, or there was none). */
async function removeVolume(docker, name) {
  const r = await docker.run(["volume", "rm", name], {
    whenStopped: true,
    timeoutMs: 60_000,
  });
  return r.status === 0 || absent(r)
    ? { ok: true }
    : { ok: false, error: String(r.stderr ?? "").trim() || `exit ${r.status}` };
}

/**
 * Take a lease on a pinned image, then pull it if it is not present. The baseline and the registration are one decision under the
 * pin's lock: a user joins the generation the record holds (and so its `pulled`), or, when there is none, starts one from what is
 * present now. Returns { ref, key, lease, pulled, generation, joined, id, present_before }.
 */
export async function acquireImage(docker, { ref, labels, name, signal }) {
  const key = pinKey(ref);
  const {
    value: { record, presentBefore, joined },
    recovered,
  } = await withImageLock(
    docker,
    key,
    async (d, held) => {
      const step = (what) =>
        held.note({ op: "acquire", key, ref, lease: name, step: what });
      const present = await imageId(d, ref, { signal });
      let current = await ownerRecord(d, key);
      let joining = current !== null;
      if (current && !current.pulled && present === null) {
        // A record that says "present before" while the image is absent: if nobody holds its generation, it describes nothing now
        // (the image went away without us), so a new generation starts from what is here. If someone does, they use an image that
        // has gone; joining keeps their (non-)obligation, which is the truthful one for their generation.
        if ((await holdersOf(d, key, current.generation)).length === 0) {
          step("remove_stale_record");
          const removed = await removeVolume(d, current.name);
          if (!removed.ok)
            throw new Error(
              `a stale owner record could not be replaced: ${removed.error}`,
            );
          current = null;
          joining = false;
        }
      }
      if (!current) {
        step("create_record");
        const made = await createRecord(d, key, ref, present === null);
        // The record on the daemon is the truth (an earlier holder's creation may have landed first): join whatever it says.
        current = await ownerRecord(d, key);
        if (!current?.generation)
          throw new Error(
            `the owner record of ${ref} cannot be read back after it was created`,
          );
        joining = current.generation !== made.generation;
      }
      step("register_lease");
      await d.must(
        [
          "volume",
          "create",
          ...labelArgs({
            ...labels,
            [LABEL_LEASE]: key,
            [LABEL_PULLED]: String(current.pulled),
            [LABEL_IMAGE]: ref,
            [LABEL_GENERATION]: current.generation,
          }),
          name,
        ],
        `lease ${ref}`,
        { abortable: false, timeoutMs: 60_000 },
      );
      return { record: current, presentBefore: present, joined: joining };
    },
    { signal },
  );
  if (presentBefore === null)
    await docker.must(["pull", "--quiet", ref], `docker pull ${ref}`, {
      signal,
      timeoutMs: 600_000,
    });
  const id = await imageId(docker, ref, { signal });
  if (!id) throw new Error(`${ref} is not present after pulling it`);
  return {
    ref,
    key,
    lease: name,
    pulled: record.pulled,
    generation: record.generation,
    joined,
    id,
    present_before: presentBefore,
    ...(recovered ? { recovered } : {}),
  };
}

/** The leases registered in `generation` of pin `key`. */
async function holdersOf(docker, key, generation) {
  const names = lines(
    await docker.must(
      ["volume", "ls", "-q", "--filter", `label=${LABEL_LEASE}=${key}`],
      "docker volume ls (leases)",
      { whenStopped: true, timeoutMs: 30_000 },
    ),
  );
  const out = [];
  for (const name of names) {
    const labels = await volumeLabels(docker, name);
    if (labels === null) continue; // released in between
    if (labels[LABEL_GENERATION] !== generation) continue; // a settled generation's leftover holds nothing
    out.push({
      name,
      invocation: labels[LABEL_INVOCATION],
      stack: labels[LABEL_STACK],
    });
  }
  return out;
}

/**
 * Remove everything labelled `filter` and verify it is gone: containers (with their anonymous volumes, whose names are read before
 * removal and checked afterwards), networks, volumes; then release the image leases among them. `images` maps a lease volume name to
 * its pinned reference (for a lease whose labels are gone too). Never throws: every failure is in the result, which is ok only when
 * the labelled inventory is verified empty and every image is as the policy says.
 */
export async function disposeLabelled(docker, { filter, refs = {} }) {
  const result = {
    filter,
    removed: { containers: [], networks: [], volumes: [] },
    mounted_volumes: [],
    images: [],
    remaining: null,
    errors: [],
  };
  const note = (what, r) => {
    if (r.status !== 0 && !absent(r))
      result.errors.push(
        `${what}: ${r.timedOut ? "timed out" : `exit ${r.status}`} ${String(r.stderr ?? "").trim()}`.trim(),
      );
    return r.status === 0;
  };
  const leases = [];
  // Look, remove, look again a second later: done when a look after the first finds nothing left to remove (so a creation the
  // daemon was still completing at the first look is caught by the next).
  for (let pass = 0; pass < 5; pass += 1) {
    let found;
    let own;
    try {
      // The stack's own leases first, and on their own: when the rest of the inventory cannot be read, each image is still
      // released or its pending obligation named (review r7 DA-1, revision 8), never silently left behind.
      own = await leasesOf(docker, filter);
      for (const l of own)
        if (!leases.some((x) => x.name === l.name)) leases.push(l);
      found = await inventory(docker, filter);
    } catch (error) {
      result.errors.push(String(error?.message ?? error));
      break;
    }
    // Lease volumes are released with their images, after the containers that used the images are gone.
    const volumes = found.volumes.filter((v) => !own.some((l) => l.name === v));
    if (
      pass > 0 &&
      found.containers.length + found.networks.length + volumes.length === 0
    )
      break;
    for (const c of found.containers) {
      const mounts = await docker.run(
        [
          "inspect",
          "--format",
          '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}',
          c.id,
        ],
        { whenStopped: true, timeoutMs: 30_000 },
      );
      if (mounts.status === 0)
        for (const name of lines(String(mounts.stdout).replaceAll(" ", "\n")))
          if (!result.mounted_volumes.includes(name))
            result.mounted_volumes.push(name);
      // `-v`: the anonymous volumes the container had go with it.
      if (
        note(
          `docker rm ${c.name}`,
          await docker.run(["rm", "-f", "-v", c.id], {
            whenStopped: true,
            timeoutMs: 60_000,
          }),
        )
      )
        result.removed.containers.push(c);
    }
    for (const n of found.networks)
      if (
        note(
          `docker network rm ${n.name}`,
          await docker.run(["network", "rm", n.id], {
            whenStopped: true,
            timeoutMs: 60_000,
          }),
        )
      )
        result.removed.networks.push(n);
    for (const v of volumes)
      if (
        note(
          `docker volume rm ${v}`,
          await docker.run(["volume", "rm", v], {
            whenStopped: true,
            timeoutMs: 60_000,
          }),
        )
      )
        result.removed.volumes.push(v);
    await pause(1000);
  }
  for (const lease of leases)
    result.images.push(await releaseImage(docker, lease, refs, result));
  try {
    const left = await inventory(docker, filter);
    const anonymousLeft = [];
    for (const name of result.mounted_volumes) {
      const r = await docker.run(["volume", "inspect", name], {
        whenStopped: true,
        timeoutMs: 30_000,
      });
      if (r.status === 0) anonymousLeft.push(name);
      else if (!absent(r))
        result.errors.push(`docker volume inspect ${name}: ${r.stderr}`);
    }
    result.remaining = { ...left, mounted_volumes: anonymousLeft };
  } catch (error) {
    result.errors.push(String(error?.message ?? error));
    result.remaining = "unknown";
  }
  result.ok =
    result.errors.length === 0 &&
    result.remaining !== "unknown" &&
    result.remaining !== null &&
    result.remaining.containers.length +
      result.remaining.networks.length +
      result.remaining.volumes.length +
      result.remaining.mounted_volumes.length ===
      0 &&
    result.images.every((i) => i.ok);
  return result;
}

async function leasesOf(docker, filter) {
  const names = lines(
    await docker.must(
      [
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=${filter}`,
        "--filter",
        `label=${LABEL_LEASE}`,
      ],
      "docker volume ls (own leases)",
      { whenStopped: true, timeoutMs: 30_000 },
    ),
  );
  const out = [];
  for (const name of names) {
    const r = await docker.run(
      ["volume", "inspect", "--format", "{{json .Labels}}", name],
      {
        whenStopped: true,
        timeoutMs: 30_000,
      },
    );
    if (r.status !== 0) {
      if (absent(r)) continue;
      throw new Error(`docker volume inspect ${name} failed: ${r.stderr}`);
    }
    const labels = JSON.parse(String(r.stdout).trim() || "{}") ?? {};
    out.push({
      name,
      key: labels[LABEL_LEASE],
      ref: labels[LABEL_IMAGE],
      pulled: labels[LABEL_PULLED] === "true",
      generation: labels[LABEL_GENERATION] ?? null,
    });
  }
  return out;
}

/** Remove a lease volume; on failure the lease is not released and the result says so (not ok). */
async function dropLeaseOf(d, lease, out, sink) {
  const removed = await removeVolume(d, lease.name);
  if (removed.ok) {
    sink.removed.volumes.push(lease.name);
    return true;
  }
  out.action = "lease_not_released";
  out.error = removed.error;
  out.ok = false;
  return false;
}

/**
 * The release decision for one lease, under the pin's lock (`d` is the locked client). Used by the releaser and, for a releaser that
 * did not finish, by the next holder of the pin. A lease of a settled generation (no record, or a newer one) holds nothing; another
 * holder of the same generation keeps the obligation in the record ("transferred": it is that generation's, and that holder is in
 * it); the last holder settles it: nothing to remove when the generation found the image present, otherwise remove it by exact id
 * (never forced) when no container uses it, verify it is gone, and only then retire the record. Anything short of that keeps the
 * record and is not ok. `step(name)` notes each effect before it is issued. Returns { out, inert } (inert: the lease holds nothing
 * now and may be removed after the lock is given up).
 */
async function decideRelease(d, lease, refs, sink, step) {
  const note = (name) => step?.(name);
  const out = {
    lease: lease.name,
    ref: lease.ref ?? refs[lease.key] ?? null,
    pulled: lease.pulled,
    generation: lease.generation,
    action: null,
    ok: false,
  };
  const record = await ownerRecord(d, lease.key);
  if (record === null || record.generation !== lease.generation) {
    out.action = "generation_settled";
    out.ok = true;
    return { out, inert: true };
  }
  out.ref = record.ref ?? out.ref;
  out.pulled = record.pulled;
  const others = (await holdersOf(d, lease.key, record.generation)).filter(
    (h) => h.name !== lease.name,
  );
  if (others.length > 0) {
    out.action = "transferred";
    out.to = others.map((h) => h.name);
    out.ok = true;
    note("drop_lease");
    await dropLeaseOf(d, lease, out, sink);
    return { out, inert: false };
  }
  const retire = async (action) => {
    note("retire_record");
    const removed = await removeVolume(d, record.name);
    if (!removed.ok) {
      out.action = "record_not_retired";
      out.error = removed.error;
      note("drop_lease");
      await dropLeaseOf(d, lease, out, sink);
      out.ok = false;
      return { out, inert: false };
    }
    out.action = action;
    out.ok = true;
    return { out, inert: true };
  };
  if (!record.pulled) return retire("kept_present_before");
  if (!out.ref) {
    out.action = "unknown_reference";
    out.obligation = record.name;
    return { out, inert: false };
  }
  const id = await imageId(d, out.ref, { whenStopped: true });
  out.id = id;
  if (id === null) return retire("already_absent");
  const users = lines(
    await d.must(
      ["ps", "-a", "-q", "--no-trunc", "--filter", `ancestor=${id}`],
      "docker ps (image users)",
      { whenStopped: true, timeoutMs: 30_000 },
    ),
  );
  if (users.length > 0) {
    out.action = "retained_in_use";
    out.users = users;
    out.obligation = record.name;
    note("drop_lease");
    await dropLeaseOf(d, lease, out, sink);
    out.ok = false;
    return { out, inert: false };
  }
  note("remove_image");
  const r = await d.run(["rmi", id], {
    whenStopped: true,
    timeoutMs: 120_000,
  });
  const after = await imageId(d, out.ref, { whenStopped: true });
  if (after !== null) {
    out.action = "remove_failed";
    out.error = String(r.stderr ?? "").trim();
    out.obligation = record.name;
    note("drop_lease");
    await dropLeaseOf(d, lease, out, sink);
    out.ok = false;
    return { out, inert: false };
  }
  return retire("removed");
}

/**
 * Release one lease (`decideRelease`, under the pin's lock, after any unfinished work an earlier holder left there is settled). A
 * settled generation's leftover lease is removed after the lock is given up (a pause there blocks nobody).
 */
async function releaseImage(docker, lease, refs, result) {
  let out;
  let inert = false;
  let recovered = null;
  try {
    ({
      value: { out, inert },
      recovered,
    } = await withImageLock(docker, lease.key, (d, held) =>
      decideRelease(d, lease, refs, result, (step) =>
        held.note({
          op: "release",
          key: lease.key,
          lease: lease.name,
          ref: lease.ref ?? refs[lease.key] ?? null,
          pulled: lease.pulled,
          generation: lease.generation,
          step,
        }),
      ),
    ));
  } catch (error) {
    // Undecided: the pin's owner record (if there is one) still holds the obligation; say where it would be.
    return {
      lease: lease.name,
      ref: lease.ref ?? refs[lease.key] ?? null,
      pulled: lease.pulled,
      generation: lease.generation,
      action: "unknown",
      error: String(error?.message ?? error),
      obligation: recordName(lease.key),
      ok: false,
    };
  }
  if (recovered) out.recovered = recovered;
  if (inert) await dropLeaseOf(docker, lease, out, result);
  return out;
}
