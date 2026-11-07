import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * R37 (WEB-14a revision 34): every browser spec that answers its API with the intercepted AuthStub runs on `test` from
 * tests/e2e/intercepted-auth.ts, which blocks service worker registration (a worker-controlled WebKit page's requests bypass
 * `context.route`). The merged lifecycle and switcher suites were the five callers that had missed it. The worker-enabled suites keep
 * auth-helpers' worker-neutral `test`. tests/e2e/production.intercepted-auth.spec.ts shows the boundary itself in each engine.
 */
const E2E = resolve(__dirname, "../e2e");
const read = (file: string) => readFileSync(resolve(E2E, file), "utf8");
/** The source without its comment lines (the suites' own documentation names the worker option in prose). */
const code = (file: string) =>
  read(file)
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join("\n");
const specs = readdirSync(E2E).filter((file) => file.endsWith(".spec.ts"));
/**
 * WEB-14a revision 40 adaptation (P-P8, R40-GATE), labelled for review: the worker-enabled production PWA suite may stub the network on a
 * page the worker does NOT control (the first load: no `clientsClaim`), which `context.route` reaches in every engine, because R40-GATE
 * needs the real session gate AND the real worker update together. It must assert that page uncontrolled (below); its controlled peer tab
 * only makes the update wait. Every other AuthStub suite keeps the intercepted-auth topology.
 */
const WORKER_ENABLED_STUBBED = ["production.pwa.spec.ts"];
const stubbed = specs.filter(
  (file) =>
    /\bnew AuthStub\(/.test(read(file)) &&
    !WORKER_ENABLED_STUBBED.includes(file),
);
const importsTest = (source: string, from: string) =>
  new RegExp(
    `import \\{[^}]*\\btest\\b[^}]*\\} from "${from.replace(".", "\\.")}";`,
  ).test(source);

describe("every AuthStub suite declares the intercepted-auth topology", () => {
  test("the inventory of AuthStub suites", () => {
    expect(stubbed.sort()).toEqual([
      "production.auth-flows.spec.ts",
      "production.auth-public.spec.ts",
      "production.intercepted-auth.spec.ts",
      "production.lifecycle-a11y.spec.ts",
      "production.lifecycle-browser.spec.ts",
      "production.lifecycle.spec.ts",
      "production.switcher-focus-lifetime.spec.ts",
      "production.switcher-focus.spec.ts",
    ]);
  });

  test.each(stubbed)("%s takes `test` from ./intercepted-auth", (file) => {
    expect(importsTest(read(file), "./intercepted-auth")).toBe(true);
  });

  test.each(stubbed)(
    "%s sets no other worker policy, in a test.use or a context it creates",
    (file) => {
      const source = code(file);
      for (const match of source.matchAll(/serviceWorkers\s*:\s*([^,}\n]+)/g))
        expect(match[1]?.trim(), `${file}: ${match[0]}`).toBe(
          "INTERCEPTED_AUTH_SERVICE_WORKERS",
        );
    },
  );

  test("the worker-enabled suites keep the worker: no intercepted-auth and no AuthStub", () => {
    for (const file of specs.filter((name) =>
      /^production\.(offline|pwa)\b|^fixture\.pwa/.test(name),
    )) {
      const source = code(file);
      // Revision 40 adaptation (P-P8): was "no AuthStub" for every worker-enabled suite; now no intercepted-auth anywhere here, and AuthStub
      // only in the named suite, which proves its stubbed page uncontrolled.
      expect(source, file).not.toMatch(/intercepted-auth/);
      if (WORKER_ENABLED_STUBBED.includes(file)) {
        // Each case that stubs the network asserts, in its own body, that its page is not controlled by the worker.
        const cases = source
          .split(/\ntest\(/)
          .filter((body) => /new AuthStub\(/.test(body));
        expect(cases.length, file).toBeGreaterThan(0);
        for (const body of cases)
          expect(body, file).toMatch(
            /navigator\.serviceWorker\.controller === null/,
          );
      } else expect(source, file).not.toMatch(/new AuthStub\(/);
      expect(source, file).not.toMatch(/serviceWorkers\s*:\s*"block"/);
    }
    expect(
      importsTest(read("production.offline.spec.ts"), "./auth-helpers"),
    ).toBe(true);
  });

  test("auth-helpers stays worker-neutral, since production.offline.spec.ts also uses it", () => {
    expect(code("auth-helpers.ts")).not.toMatch(/serviceWorkers\s*:/);
    expect(read("intercepted-auth.ts")).toMatch(
      /serviceWorkers: INTERCEPTED_AUTH_SERVICE_WORKERS,/,
    );
  });
});
