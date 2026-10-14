import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isPublished, publish, writeAtomic } from "./release-cache.mjs";

test("a release is published once, and a second publication of the same key never rewrites it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = publish({
    dir,
    key: "darwin-abc",
    fill: (staging) => writeFileSync(join(staging, "atlas"), "v1"),
  });
  assert.deepEqual(first, { path: join(dir, "darwin-abc"), reused: false });
  let filled = false;
  const second = publish({
    dir,
    key: "darwin-abc",
    fill: () => {
      filled = true;
    },
  });
  assert.equal(second.reused, true);
  assert.equal(filled, false, "a published release is not extracted again");
  assert.equal(readFileSync(join(dir, "darwin-abc", "atlas"), "utf8"), "v1");
});

test("two runs extracting the same release at once: the later one keeps the published copy and discards its own", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = publish({
    dir,
    key: "k",
    fill: (staging) => {
      writeFileSync(join(staging, "atlas"), "mine");
      // Meanwhile the other run published first (its executable may already be running).
      publish({
        dir,
        key: "k",
        fill: (other) => writeFileSync(join(other, "atlas"), "theirs"),
      });
    },
  });
  assert.equal(result.reused, true);
  assert.equal(readFileSync(join(dir, "k", "atlas"), "utf8"), "theirs");
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.startsWith(".staging")),
    [],
    "no staging directory is left",
  );
});

test("a failed extraction publishes nothing and leaves no staging directory; an atomic write replaces a file whole", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(
    () =>
      publish({
        dir,
        key: "bad",
        fill: () => {
          throw new Error("tar failed");
        },
      }),
    /tar failed/,
  );
  assert.equal(isPublished(dir, "bad"), false);
  assert.equal(existsSync(join(dir, "bad")), false);
  assert.deepEqual(readdirSync(dir), []);
  writeAtomic(join(dir, "archive"), "old");
  writeAtomic(join(dir, "archive"), "new");
  assert.equal(readFileSync(join(dir, "archive"), "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["archive"]);
});
