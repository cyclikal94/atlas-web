import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

/** AC-15, AC-16 and the documentation promises of the session slice: the docs say what the code relies on. */
describe("docs/session.md", () => {
  const doc = read("docs/session.md");

  test("cites WEB-04 design section 7 as the authoritative account-isolation mechanism, and section 7.8 for the deletion procedure", () => {
    expect(doc).toMatch(/WEB-04 design section 7[^\n]*Account isolation/);
    expect(doc).toMatch(/authoritative account-isolation mechanism/i);
    expect(doc).toMatch(/section 7\.8/);
  });

  test.each([
    "## Public interface",
    "### What each consumer may rely on",
    "### Obligations this slice creates for WEB-09a",
    "## Module map",
    "## Boot sequence",
    "## State inventory and copy map (A1)",
    "## Gap report (design and contract)",
    "## Settings composition (for WEB-13a)",
    "## Testing, and what each layer does not prove",
  ])("has the section %s", (heading) => {
    expect(doc).toContain(heading);
  });

  test("names every neutral state the session can show", async () => {
    const { NEUTRAL_POLITENESS } = await import(
      "../../src/session/model/neutral-state"
    );
    const missing = Object.keys(NEUTRAL_POLITENESS)
      .map((id) => id.split(".")[0] as string)
      .filter((prefix, index, all) => all.indexOf(prefix) === index)
      .filter(
        (prefix) =>
          !doc.includes(`\`${prefix}`) && !doc.includes(`\`${prefix}.`),
      );
    expect(missing).toEqual([]);
  });

  test("lists the gap report G-1 to G-13", () => {
    for (let n = 1; n <= 13; n += 1) expect(doc).toContain(`| G-${n} |`);
  });

  test("states the supported API range that the code derives from the contract pin", async () => {
    const { formatRange, rangeFromPin } = await import(
      "../../src/session/model/api-version"
    );
    const pin = JSON.parse(read("contract-pin.json")) as { version: string };
    expect(doc).toContain(formatRange(rangeFromPin(pin.version)));
  });
});

describe("the documentation set", () => {
  test("lint-rules.md lists R7 to R12 as active, not as a register handed to a later slice", () => {
    const doc = read("docs/lint-rules.md");
    for (const rule of ["R7", "R8", "R9", "R10", "R11", "R12"])
      expect(doc).toContain(`**${rule} `);
    expect(doc).not.toContain("Handed to WEB-08a (register)");
  });

  test("browser-support.md records the canary and the limits of the session's real-engine runs", () => {
    const doc = read("docs/browser-support.md");
    expect(doc).toContain("atlas-auth");
    expect(doc).toMatch(/overriding `document\.visibilityState`/);
  });

  test("CONTRIBUTING.md has the session module in its map", () => {
    expect(read("CONTRIBUTING.md")).toMatch(
      /src\/session\/\s+the account lifecycle/,
    );
  });
});
