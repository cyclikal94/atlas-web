// Part C (plan 14.4), OPTIONAL: the released backend CONTAINER image against a disposable PostgreSQL, on the local colima profile "atlas".
// The client is engine-independent and the backend's own suite covers both engines, so this is a repeat of a few specs, not part of the
// required set. Constraints learned on this runtime: no host bind mounts (nothing is mounted), `DOCKER_CONTEXT=colima-atlas`, images are removed
// by EXACT ID against a before-list, and the runtime's build cache is never pruned.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// Pins: the backend's container image index digest (release asset container-image.txt, v0.29.0-rc.1) and the PostgreSQL index digest this repository
// already pins for its Compose example (deploy/base-images.env).
export const BACKEND_IMAGE =
  "ghcr.io/cyclikal94/atlas@sha256:261b9074a212f84e4fe10c1b82afb04807ce918951a8101b40018badaadec7da";
export const POSTGRES_IMAGE =
  "postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f";
const env = { ...process.env, DOCKER_CONTEXT: "colima-atlas" };

const docker = (args, options = {}) =>
  spawnSync("docker", args, { encoding: "utf8", env, ...options });
const must = (result, what) => {
  if (result.status !== 0)
    throw new Error(
      `${what} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  return (result.stdout ?? "").trim();
};
const imageIds = () =>
  new Set(
    must(docker(["images", "-q", "--no-trunc"]), "docker images")
      .split("\n")
      .filter(Boolean),
  );

export async function startPostgresBackend({ backendPort, origin, names }) {
  const before = imageIds();
  const tag = randomBytes(4).toString("hex");
  const network = `atlas-it-${tag}`;
  const pgPassword = randomBytes(16).toString("hex"); // hex: URL-safe, as the connection URL requires
  const url = `postgres://atlas:${pgPassword}@pg:5432/atlas`;
  const created = { containers: [], network: null };
  const stop = () => {
    // `-v` too: the PostgreSQL image declares an anonymous data volume that `rm -f` alone leaves behind.
    for (const id of created.containers) docker(["rm", "-f", "-v", id]);
    if (created.network) docker(["network", "rm", created.network]);
    // Remove only the images THIS run added, by exact id.
    const after = imageIds();
    for (const id of after) if (!before.has(id)) docker(["rmi", id]);
    const left = [...imageIds()].filter((id) => !before.has(id));
    return {
      images_added_and_left: left,
      containers_left: created.containers.length,
    };
  };
  try {
    must(docker(["network", "create", network]), "docker network create");
    created.network = network;
    created.containers.push(
      must(
        docker([
          "run",
          "-d",
          "--name",
          `${network}-pg`,
          "--network",
          network,
          "--network-alias",
          "pg",
          "-e",
          "POSTGRES_USER=atlas",
          "-e",
          "POSTGRES_DB=atlas",
          "-e",
          `POSTGRES_PASSWORD=${pgPassword}`,
          POSTGRES_IMAGE,
        ]),
        "start postgres",
      ),
    );
    for (let i = 0; i < 60; i += 1) {
      if (
        docker([
          "exec",
          `${network}-pg`,
          "pg_isready",
          "-U",
          "atlas",
          "-d",
          "atlas",
        ]).status === 0
      )
        break;
      await new Promise((r) => setTimeout(r, 1000));
      if (i === 59) throw new Error("postgres did not become ready");
    }
    const accounts = {};
    for (const name of names) {
      const password = randomBytes(16).toString("hex");
      must(
        docker(
          [
            "run",
            "--rm",
            "-i",
            "--network",
            network,
            "-e",
            `ATLAS_DATABASE_URL=${url}`,
            BACKEND_IMAGE,
            "account",
            name,
          ],
          { input: `${password}\n` },
        ),
        `create account ${name}`,
      );
      accounts[name] = { username: name, password };
    }
    created.containers.push(
      must(
        docker([
          "run",
          "-d",
          "--name",
          `${network}-backend`,
          "--network",
          network,
          "-p",
          `127.0.0.1:${backendPort}:3000`,
          "-e",
          "ATLAS_BIND=0.0.0.0:3000",
          "-e",
          `ATLAS_PUBLIC_ORIGIN=${origin}`,
          "-e",
          `ATLAS_DATABASE_URL=${url}`,
          BACKEND_IMAGE,
        ]),
        "start backend",
      ),
    );
    return {
      accounts,
      stop,
      describe: {
        backend_image: BACKEND_IMAGE,
        postgres_image: POSTGRES_IMAGE,
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
