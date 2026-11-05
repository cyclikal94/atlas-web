import { describe, expect, test } from "vitest";
import pin from "../../../contract-pin.json";
import {
  exactVersionRange,
  formatRange,
  judgeVersion,
  parseSemVer,
  rangeFromPin,
} from "../../../src/session/model/api-version";

describe("API compatibility (EC-45, D-08)", () => {
  const range = rangeFromPin("0.31.0-rc.1");
  test("the supported range derives from the contract pin", () => {
    expect(rangeFromPin(pin.version)).toEqual(range);
    expect(range.floor).toEqual({ major: 0, minor: 31, patch: 0 });
    expect(range.ceiling).toEqual({ major: 0, minor: 32, patch: 0 });
  });
  test.each([
    ["0.31.0", "supported"],
    ["0.31.10", "supported"], // numeric, never text: 10 > 9
    ["0.31.9", "supported"],
    ["0.32.0", "unsupported"],
    ["0.30.9", "unsupported"],
    ["1.0.0", "unsupported"],
    ["0.31", "missing"],
    ["0.31.0-rc.1", "missing"],
    ["0.31.0+build", "missing"],
    ["v0.31.0", "missing"],
    ["00.31.0", "missing"],
    ["", "missing"],
    [undefined, "missing"],
    [27, "missing"],
    [null, "missing"],
  ])("%j is %s", (value, status) => {
    expect(judgeVersion(value, range).status).toBe(status);
  });
  test("a version is compared numerically as SemVer", () => {
    expect(parseSemVer("0.31.10")?.patch).toBe(10);
    expect(parseSemVer("0.31.010")).toBeNull();
  });
});

/**
 * WEB-09c (R38-DIAG): the DIAGNOSTIC exact-version policy of a development-pair document. It admits the ONE version its verified selection
 * names and nothing beside it; a malformed version is refused outright (never widened). The released range above is unchanged.
 */
describe("the diagnostic exact-version range (R38-DIAG)", () => {
  const exact = exactVersionRange("0.30.0");
  test("it is >=0.30.0 <0.30.1, and the released range still refuses 0.30.0", () => {
    expect(formatRange(exact)).toBe(">=0.30.0 <0.30.1");
    expect(judgeVersion("0.30.0", rangeFromPin(pin.version))).toEqual({
      status: "unsupported",
      version: "0.30.0",
      supported: ">=0.31.0 <0.32.0",
    });
  });
  test.each([
    ["0.30.0", "supported"],
    ["0.30.1", "unsupported"],
    ["0.30.10", "unsupported"],
    ["0.29.0", "unsupported"],
    ["0.29.10", "unsupported"],
    ["0.31.0", "unsupported"],
    ["1.30.0", "unsupported"],
    ["0.30.0-rc.1", "missing"],
    ["0.30", "missing"],
    [undefined, "missing"],
  ])("%j is %s under the exact policy", (value, status) => {
    expect(judgeVersion(value, exact).status).toBe(status);
  });
  test.each(["0.30", "0.30.0-rc.1", "0.30.0+build", "v0.30.0", ">=0.30.0", ""])(
    "%j is refused (never a wider policy)",
    (value) => {
      expect(() => exactVersionRange(value)).toThrow(
        /Not an exact API version/,
      );
    },
  );
});
