// The Docker resources of an integration run: labelled at creation, found again by label, removed and then VERIFIED gone (WEB-08d
// review r6, H4a and the design assessment's DA-1).
//
// Every container, network and volume a run creates carries `atlas.it.invocation=<invocation>` and `atlas.it.stack=<stack>`, so a
// creation whose answer was lost, or a container created while the runner was being stopped, is still found: disposal lists by label,
// it never relies on the ids it happened to receive. Removal statuses are checked, and success means the labelled inventory is
// empty afterwards (twice, a moment apart, so a creation the daemon was still completing is caught), the anonymous volumes the
// containers had mounted are gone and the images are as the image policy says. An inventory that cannot be read is `unknown`, never empty.
//
// Images: only the two PINNED images are ever considered, never "every image that was not there before" (that would remove an image
// another user or invocation added meanwhile). Before a pinned image is used, a LEASE volume is created for it that records whether
// this run's group of users pulled it (`atlas.it.pulled`). On release the lease is removed; a pulled image is removed (by exact id,
// never forced) only when no other lease for it remains and no container uses it. Another live lease means the obligation passes to
// that holder (it carries the same `pulled`). A container of someone else using it means its ownership cannot be settled: the image is
// kept and the clean-up is not ok. A user outside this protocol pulling the same pin at the same time cannot be told apart.
import { createHash } from "node:crypto";

export const DOCKER_CONTEXT = "colima-atlas";
export const LABEL_INVOCATION = "atlas.it.invocation";
export const LABEL_STACK = "atlas.it.stack";
const LABEL_LEASE = "atlas.it.lease";
const LABEL_PULLED = "atlas.it.pulled";
const LABEL_IMAGE = "atlas.it.image";

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
 * process; the reaper a plain one). Returns the operations every user of this module needs.
 */
export function dockerClient(run) {
  const must = async (args, what, options) => {
    const r = await run(args, options);
    if (r.status !== 0)
      throw new Error(
        `${what} failed (${r.timedOut ? "timed out" : `exit ${r.status}`}):\n${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
      );
    return String(r.stdout ?? "").trim();
  };
  return { run, must };
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

/**
 * Take a lease on a pinned image (labelled like every other resource of the stack), then pull it if it is not present. Returns
 * { ref, key, lease, pulled, id }.
 */
export async function acquireImage(docker, { ref, labels, name, signal }) {
  const key = pinKey(ref);
  const presentBefore = await imageId(docker, ref, { signal });
  const others = await leasesFor(docker, key);
  // The group of overlapping users pulled it if any of them did, or if nobody holds a lease and it is not here.
  const pulled =
    others.length > 0
      ? others.some((l) => l.pulled) || presentBefore === null
      : presentBefore === null;
  await docker.must(
    [
      "volume",
      "create",
      ...labelArgs({
        ...labels,
        [LABEL_LEASE]: key,
        [LABEL_PULLED]: String(pulled),
        [LABEL_IMAGE]: ref,
      }),
      name,
    ],
    `lease ${ref}`,
    { abortable: false, timeoutMs: 60_000 },
  );
  if (presentBefore === null)
    await docker.must(["pull", "--quiet", ref], `docker pull ${ref}`, {
      signal,
      timeoutMs: 600_000,
    });
  const id = await imageId(docker, ref, { signal });
  if (!id) throw new Error(`${ref} is not present after pulling it`);
  return { ref, key, lease: name, pulled, id, present_before: presentBefore };
}

async function leasesFor(docker, key) {
  const names = lines(
    await docker.must(
      ["volume", "ls", "-q", "--filter", `label=${LABEL_LEASE}=${key}`],
      "docker volume ls (leases)",
      { whenStopped: true, timeoutMs: 30_000 },
    ),
  );
  const out = [];
  for (const name of names) {
    const r = await docker.run(
      ["volume", "inspect", "--format", "{{json .Labels}}", name],
      { whenStopped: true, timeoutMs: 30_000 },
    );
    if (r.status !== 0) {
      if (absent(r)) continue; // released in between
      throw new Error(`docker volume inspect ${name} failed: ${r.stderr}`);
    }
    const labels = JSON.parse(String(r.stdout).trim() || "{}") ?? {};
    out.push({
      name,
      pulled: labels[LABEL_PULLED] === "true",
      image: labels[LABEL_IMAGE],
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
      found = await inventory(docker, filter);
      own = await leasesOf(docker, filter);
    } catch (error) {
      result.errors.push(String(error?.message ?? error));
      break;
    }
    for (const l of own)
      if (!leases.some((x) => x.name === l.name)) leases.push(l);
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
    });
  }
  return out;
}

async function releaseImage(docker, lease, refs, result) {
  const ref = lease.ref ?? refs[lease.key];
  const out = {
    lease: lease.name,
    ref: ref ?? null,
    pulled: lease.pulled,
    action: null,
    ok: false,
  };
  const rm = await docker.run(["volume", "rm", lease.name], {
    whenStopped: true,
    timeoutMs: 60_000,
  });
  if (rm.status !== 0 && !absent(rm)) {
    out.action = "lease_not_released";
    out.error = String(rm.stderr ?? "").trim();
    return out;
  }
  result.removed.volumes.push(lease.name);
  if (!lease.pulled) {
    out.action = "kept_present_before";
    out.ok = true;
    return out;
  }
  if (!ref) {
    out.action = "unknown_reference";
    return out;
  }
  try {
    const id = await imageId(docker, ref, { whenStopped: true });
    out.id = id;
    if (id === null) {
      out.action = "already_absent";
      out.ok = true;
      return out;
    }
    const others = await leasesFor(docker, lease.key);
    if (others.length > 0) {
      // Another live lease holds the same obligation (its `pulled` is the group's): it removes the image when it is the last.
      out.action = "transferred";
      out.to = others.map((l) => l.name);
      out.ok = true;
      return out;
    }
    const users = lines(
      await docker.must(
        ["ps", "-a", "-q", "--no-trunc", "--filter", `ancestor=${id}`],
        "docker ps (image users)",
        {
          whenStopped: true,
          timeoutMs: 30_000,
        },
      ),
    );
    if (users.length > 0) {
      out.action = "retained_in_use";
      out.users = users;
      return out;
    }
    const r = await docker.run(["rmi", id], {
      whenStopped: true,
      timeoutMs: 120_000,
    });
    const after = await imageId(docker, ref, { whenStopped: true });
    out.action = after === null ? "removed" : "remove_failed";
    if (after !== null) out.error = String(r.stderr ?? "").trim();
    out.ok = after === null;
  } catch (error) {
    out.action = "unknown";
    out.error = String(error?.message ?? error);
  }
  return out;
}
