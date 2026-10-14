// Part C (plan 14.4), OPTIONAL: the released backend CONTAINER image against a disposable PostgreSQL, on the local colima profile "atlas".
// The client is engine-independent and the backend's own suite covers both engines, so this is a repeat of a few specs, not part of the
// required set. Constraints learned on this runtime: no host bind mounts (the database lives in a NAMED volume, nothing of the host is
// mounted), `DOCKER_CONTEXT=colima-atlas`, the runtime's build cache is never pruned, and images are only ever removed by exact id.
//
// WEB-08d review r6 (H4a): the caller registers the disposal of everything labelled with its stack BEFORE this starts
// (scripts/integration/docker-resources.mjs), so a stop that arrives while PostgreSQL is starting, or while an account is being made,
// cannot leave a container behind: every container, the network and every volume carry the stack's labels, and disposal finds them by
// label after this function has settled. Every docker command is an owned, bounded process; a command that only waits (pull,
// readiness) ends at once on a stop, and one that creates something finishes, so its creation is never left half-reported.
import { randomBytes } from "node:crypto";
import { acquireImage, labelArgs } from "./docker-resources.mjs";
import { Cancelled } from "./ownership.mjs";

// Pins: the backend's container image index digest (release asset container-image.txt, v0.28.0-rc.1) and the PostgreSQL index digest this repository
// already pins for its Compose example (deploy/base-images.env).
export const BACKEND_IMAGE =
  "ghcr.io/cyclikal94/atlas@sha256:2b8101a8047f7e6cbc23742f3f0b4701b9e22deb38c2b88a932e09dd71ab4d20";
export const POSTGRES_IMAGE =
  "postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f";

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Cancelled(String(signal.reason?.reason ?? "aborted")));
      },
      { once: true },
    );
  });

/**
 * Start PostgreSQL and the backend container for one stack. `docker` is a docker-resources client whose commands are owned by the
 * runner; `labels` are the stack's; `at(name)` is the runner's qualification boundary. Resolves with the accounts and a description;
 * whatever it created is the caller's to dispose of by label, whether this resolves, throws or is stopped part-way.
 */
export async function startPostgresBackend({
  backendPort,
  origin,
  names,
  docker,
  labels,
  signal,
  at = async () => undefined,
  log = () => undefined,
}) {
  const check = () => {
    if (signal?.aborted)
      throw new Cancelled(String(signal.reason?.reason ?? "aborted"));
  };
  const tag = randomBytes(4).toString("hex");
  const prefix = `atlas-it-${tag}`;
  const pgPassword = randomBytes(16).toString("hex"); // hex: URL-safe, as the connection URL requires
  const url = `postgres://atlas:${pgPassword}@pg:5432/atlas`;
  const create = { abortable: false, timeoutMs: 60_000 };
  const describe = {
    backend_image: BACKEND_IMAGE,
    postgres_image: POSTGRES_IMAGE,
    prefix,
    images: [],
  };

  for (const [name, ref] of [
    ["pg", POSTGRES_IMAGE],
    ["backend", BACKEND_IMAGE],
  ]) {
    check();
    describe.images.push(
      await acquireImage(docker, {
        ref,
        labels,
        name: `${prefix}-lease-${name}`,
        signal,
      }),
    );
  }
  await at("postgres:images");
  check();
  await docker.must(
    ["network", "create", ...labelArgs(labels), prefix],
    "docker network create",
    create,
  );
  await docker.must(
    ["volume", "create", ...labelArgs(labels), `${prefix}-pgdata`],
    "docker volume create",
    create,
  );
  await at("postgres:network");
  check();
  describe.postgres_container = await docker.must(
    [
      "run",
      "-d",
      "--name",
      `${prefix}-pg`,
      ...labelArgs(labels),
      "--network",
      prefix,
      "--network-alias",
      "pg",
      // A named, labelled volume at the image's declared data path, so no anonymous volume is created.
      "-v",
      `${prefix}-pgdata:/var/lib/postgresql/data`,
      "-e",
      "POSTGRES_USER=atlas",
      "-e",
      "POSTGRES_DB=atlas",
      "-e",
      `POSTGRES_PASSWORD=${pgPassword}`,
      POSTGRES_IMAGE,
    ],
    "start postgres",
    create,
  );
  log(`postgres container ${describe.postgres_container.slice(0, 12)}`);
  await at("postgres:readiness");
  for (let i = 0; ; i += 1) {
    check();
    const ready = await docker.run(
      ["exec", `${prefix}-pg`, "pg_isready", "-U", "atlas", "-d", "atlas"],
      { signal, timeoutMs: 30_000 },
    );
    if (ready.status === 0) break;
    if (i === 59) throw new Error("postgres did not become ready");
    await pause(1000, signal);
  }
  const accounts = {};
  for (const name of names) {
    check();
    const password = randomBytes(16).toString("hex");
    await docker.must(
      [
        "run",
        "--rm",
        "-i",
        "--name",
        `${prefix}-account-${name}`,
        ...labelArgs(labels),
        "--network",
        prefix,
        "-e",
        `ATLAS_DATABASE_URL=${url}`,
        BACKEND_IMAGE,
        "account",
        name,
      ],
      `create account ${name}`,
      { ...create, timeoutMs: 120_000, input: `${password}\n` },
    );
    accounts[name] = { username: name, password };
  }
  await at("postgres:accounts");
  check();
  describe.backend_container = await docker.must(
    [
      "run",
      "-d",
      "--name",
      `${prefix}-backend`,
      ...labelArgs(labels),
      "--network",
      prefix,
      "-p",
      `127.0.0.1:${backendPort}:3000`,
      "-e",
      "ATLAS_BIND=0.0.0.0:3000",
      "-e",
      `ATLAS_PUBLIC_ORIGIN=${origin}`,
      "-e",
      `ATLAS_DATABASE_URL=${url}`,
      BACKEND_IMAGE,
    ],
    "start backend",
    create,
  );
  log(`backend container ${describe.backend_container.slice(0, 12)}`);
  await at("postgres:backend");
  return { accounts, describe };
}
