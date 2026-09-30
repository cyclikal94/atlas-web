import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { packageDirectoryOf } from "../../build/bundled-packages";

const ROOT = resolve(__dirname, "../..");
const script = (name: string) => resolve(ROOT, "scripts", name);

interface Pkg {
  name: string;
  version: string;
}
const APP: Pkg[] = [{ name: "react", version: "19.3.0" }];
const WORKER: Pkg[] = ["core", "precaching", "routing", "strategies"].map(
  (name) => ({ name: `workbox-${name}`, version: "7.4.1" }),
);
/** What a Workbox-built service worker contains: one version marker per module. */
const SW_CODE = ["core", "precaching", "routing", "strategies"]
  .map((name) => `try{self["workbox:${name}:7.4.0"]&&_()}catch{}`)
  .join("");

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "atlas-notices-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A dist-shaped directory holding the two build records and a service worker. */
function output(
  name: string,
  records: { app?: Pkg[]; worker?: Pkg[] },
  worker: string | null = SW_CODE,
) {
  const dist = join(scratch, name);
  mkdirSync(join(dist, "_web"), { recursive: true });
  const write = (build: string, packages: Pkg[] | undefined) => {
    if (packages)
      writeFileSync(
        join(dist, `_web/bundled-packages-${build}.json`),
        JSON.stringify({ schema: 1, build, packages }),
      );
  };
  write("app", records.app);
  write("service-worker", records.worker);
  if (worker !== null) writeFileSync(join(dist, "sw.js"), worker);
  return dist;
}

const generate = (dist: string) =>
  spawnSync(
    "node",
    [
      script("generate-notices.mjs"),
      join(dist, "_web/third-party-notices.txt"),
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
const check = (dist: string, ...extra: string[]) =>
  spawnSync("node", [script("check-notices.mjs"), dist, ...extra], {
    cwd: ROOT,
    encoding: "utf8",
  });

describe("packageDirectoryOf (which package a bundled file belongs to)", () => {
  test("names the innermost package, for pnpm's layout and scoped packages", () => {
    expect(
      packageDirectoryOf(
        "/p/node_modules/.pnpm/workbox-core@7.4.1/node_modules/workbox-core/build/workbox-core.prod.js",
      ),
    ).toEqual({
      name: "workbox-core",
      directory:
        "/p/node_modules/.pnpm/workbox-core@7.4.1/node_modules/workbox-core",
    });
    expect(
      packageDirectoryOf(
        "/p/node_modules/.pnpm/@fontsource-variable+geist@5.3.0/node_modules/@fontsource-variable/geist/files/a.woff2?inline",
      )?.name,
    ).toBe("@fontsource-variable/geist");
  });

  test("ignores the project's own files and virtual modules", () => {
    expect(packageDirectoryOf("/p/src/main.tsx")).toBeNull();
    expect(packageDirectoryOf("\0vite/preload-helper.js")).toBeNull();
  });
});

describe("the generator covers what the build bundled, not only the declared production dependencies", () => {
  test("Workbox (development dependencies compiled into sw.js) is in the notices with its licence text", () => {
    const dist = output("generated", { app: APP, worker: WORKER });
    const result = generate(dist);
    expect(result.status, result.stderr).toBe(0);
    const notices = readFileSync(
      join(dist, "_web/third-party-notices.txt"),
      "utf8",
    );
    for (const { name, version } of WORKER)
      expect(notices, name).toContain(`\n${name}@${version}  (MIT)`);
    expect(notices).toContain("Copyright 2018 Google LLC");
    // The declared production dependencies stay in.
    expect(notices).toContain("\nreact@19.3.0  (MIT)");
    expect(notices).toContain("(OFL-1.1)");
  });

  test("the notices it generates pass the artefact check", () => {
    const dist = output("roundtrip", { app: APP, worker: WORKER });
    expect(generate(dist).status).toBe(0);
    const result = check(dist);
    expect(result.status, result.stderr).toBe(0);
  });

  test("it refuses to run without the build's record", () => {
    const dist = output("no-record", {});
    const result = generate(dist);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bundled-packages-app.json");
  });

  test("it fails on a bundled package that is not installed", () => {
    const dist = output("stale", {
      app: [{ name: "not-a-real-package", version: "1.0.0" }],
    });
    const result = generate(dist);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not-a-real-package@1.0.0");
  });
});

describe("the artefact check refuses incomplete notices", () => {
  /** Notices generated for a full build, then damaged. */
  function withNotices(name: string, damage: (text: string) => string) {
    const dist = output(name, { app: APP, worker: WORKER });
    expect(generate(dist).status).toBe(0);
    const file = join(dist, "_web/third-party-notices.txt");
    writeFileSync(file, damage(readFileSync(file, "utf8")));
    return dist;
  }

  test("notices that omit a Workbox package, as the production-only listing did, fail", () => {
    const dist = withNotices("omits-workbox", (text) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("workbox-"))
        .join("\n"),
    );
    const result = check(dist);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workbox-core");
    expect(result.stderr).toContain("compiled into sw.js");
  });

  test("a package listed without a licence section fails", () => {
    const dist = withNotices("no-section", (text) =>
      text.replace(
        "workbox-routing@7.4.1 - MIT",
        "workbox-routing@7.4.1 (heading damaged)",
      ),
    );
    const result = check(dist);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workbox-routing@7.4.1");
  });

  test("a licence that the package does not carry fails rather than passing silently", () => {
    const dist = withNotices("placeholder", (text) =>
      text.replace(
        /(react@19\.3\.0 - MIT\n=+\n)[\s\S]*?\n\n/,
        "$1(licence text not found in the installed package)\n\n",
      ),
    );
    const result = check(dist);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("react@19.3.0");
  });

  test("Workbox in sw.js is caught even when the build's record forgot it", () => {
    const dist = output("record-forgot", { app: APP, worker: [] });
    expect(generate(dist).status).toBe(0);
    const result = check(dist);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "workbox-core is compiled into sw.js but is not in the service-worker record",
    );
  });

  test("a service worker with no record file at all fails", () => {
    const dist = output("no-worker-record", { app: APP });
    expect(generate(dist).status).toBe(0);
    expect(check(dist).stderr).toContain(
      "bundled-packages-service-worker.json is missing",
    );
  });

  test("a missing application record fails", () => {
    const dist = output("no-app-record", { worker: WORKER }, null);
    writeFileSync(join(dist, "_web/third-party-notices.txt"), "\n");
    expect(check(dist).stderr).toContain(
      "bundled-packages-app.json is missing",
    );
  });

  test("an archive is checked the same way, with its own notices file", () => {
    const site = output("archive-site", { app: APP, worker: WORKER });
    expect(generate(site).status).toBe(0);
    const root = join(scratch, "archive-root-notices.txt");
    writeFileSync(
      root,
      readFileSync(join(site, "_web/third-party-notices.txt")),
    );
    expect(check(site, "--notices", root).status).toBe(0);
    writeFileSync(root, "nothing\n");
    expect(check(site, "--notices", root).status).toBe(1);
  });
});

test("the checks are wired into the artefact gate", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts["check:artefacts"]).toContain("check-notices.mjs dist");
});
