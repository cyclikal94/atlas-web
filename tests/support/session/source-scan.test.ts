// @vitest-environment node
import { describe, expect, test } from "vitest";
import { stripComments } from "./source-scan";

describe("the source scanner used by the boundary tests", () => {
  test("removes line and block comments and keeps code", () => {
    expect(
      stripComments("a(); // localStorage\n/* sessionStorage */ b();")
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe("a(); b();");
  });
  test("keeps strings, templates and regular expressions, including comment-like text in them", () => {
    const source =
      'const u = "http://x"; const t = `a // b`; const r = /\\/\\/ x/; // gone';
    const out = stripComments(source);
    expect(out).toContain('"http://x"');
    expect(out).toContain("`a // b`");
    expect(out).toContain("/\\/\\/ x/");
    expect(out).not.toContain("gone");
  });
  test("a division is not taken for a regular expression", () => {
    expect(stripComments("const q = a / b; // c\nconst z = 1;")).toContain(
      "const z = 1;",
    );
  });
  test("a quote inside a regular expression class does not start a string", () => {
    expect(stripComments("const r = /[\"']/; // gone\nfoo();")).toContain(
      "foo();",
    );
  });
});
