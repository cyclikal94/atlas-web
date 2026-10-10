import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R2: the persistence hold (G5) is only worth anything if production composition actually passes the session's own. The unordered gate
 * exists for a page with no session record to order against (a test world, a fixture page); nothing that ships may use it.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const source = walk("src").filter((path) => /\.tsx?$/.test(path));

describe("production composition passes the session's persistence hold", () => {
  it("the browser composition passes `session.persistence`", () => {
    const text = readFileSync("src/data/ui/browser-env.ts", "utf8");
    expect(text).toMatch(/persistence:\s*session\.persistence\b/);
    expect(text).not.toContain("unorderedPersistence");
  });

  it("`unorderedPersistence` is used only by its definition and by the fixture", () => {
    const users = source.filter((path) =>
      readFileSync(path, "utf8").includes("unorderedPersistence"),
    );
    expect(users.sort()).toEqual(
      [
        "src/data/engine/account-service.ts",
        "src/fixture/data-harness/main.ts",
      ].sort(),
    );
  });

  it("a commit starts its transaction under the hold in ONE step: the validity is checked, the store is handed the revocation signal, and the transaction is registered (R2, revision 6)", () => {
    const text = readFileSync("src/data/engine/account-service.ts", "utf8");
    const at = text.indexOf("async commit<");
    const body = text.slice(at, text.indexOf("private withHoldCheck", at));
    // The three together, in this order, with nothing awaited between them.
    const check = body.indexOf("if (!hold.valid())");
    const run = body.indexOf("this.store.run(");
    const track = body.indexOf("hold.track(running)");
    expect(check).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(check);
    expect(track).toBeGreaterThan(run);
    expect(body.slice(check, track)).not.toContain("await");
    expect(body.slice(run, track)).toContain("signal: hold.revoked");
    // And the decision of the transaction consults the hold again (the second layer).
    expect(text).toMatch(
      /decide: \(reads, input\) => \{\s*if \(!hold\.valid\(\)\)/,
    );
  });

  it("nothing that ships persists a response outside `AccountService.commit` under the hold, and `track` is called only there", () => {
    const callers = source.filter((path) =>
      /\.persistence\.hold\(|hold\.track\(/.test(readFileSync(path, "utf8")),
    );
    expect(callers).toEqual(["src/data/engine/account-service.ts"]);
  });
});
