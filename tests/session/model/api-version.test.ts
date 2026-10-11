import { describe, expect, test } from "vitest";
import pin from "../../../contract-pin.json";
import {
  judgeVersion,
  parseSemVer,
  rangeFromPin,
} from "../../../src/session/model/api-version";

describe("API compatibility (EC-45, D-08)", () => {
  const range = rangeFromPin("0.28.0-rc.1");
  test("the supported range derives from the contract pin", () => {
    expect(rangeFromPin(pin.version)).toEqual(range);
    expect(range.floor).toEqual({ major: 0, minor: 28, patch: 0 });
    expect(range.ceiling).toEqual({ major: 0, minor: 29, patch: 0 });
  });
  test.each([
    ["0.28.0", "supported"],
    ["0.28.10", "supported"], // numeric, never text: 10 > 9
    ["0.28.9", "supported"],
    ["0.29.0", "unsupported"],
    ["0.27.9", "unsupported"],
    ["1.0.0", "unsupported"],
    ["0.28", "missing"],
    ["0.28.0-rc.1", "missing"],
    ["0.28.0+build", "missing"],
    ["v0.28.0", "missing"],
    ["00.28.0", "missing"],
    ["", "missing"],
    [undefined, "missing"],
    [27, "missing"],
    [null, "missing"],
  ])("%j is %s", (value, status) => {
    expect(judgeVersion(value, range).status).toBe(status);
  });
  test("a version is compared numerically as SemVer", () => {
    expect(parseSemVer("0.28.10")?.patch).toBe(10);
    expect(parseSemVer("0.28.010")).toBeNull();
  });
});
