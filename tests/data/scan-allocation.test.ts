// @vitest-environment node
import { afterEach, describe, expect, test } from "vitest";
import { scanSyncPage } from "../../src/data/scan/scan";
import {
  createKeyDerivers,
  createValueValidators,
  decodeChange,
  PageInvalid,
} from "../../src/data/scan/validate";
import {
  injectFault,
  restoreFaults,
  SCAN_SITES,
  type TextSite,
} from "../support/data/allocation-faults";
import { bytesOf, pageJson, uuid } from "../support/data/sync-pages";

/**
 * R44 (revision 24), at the boundary of the scanner and the decoder themselves: an ALLOCATION failure leaves each as an exception of
 * its own (a `RangeError`, for the caller's sizing policy), and is never turned into the verdict "this page is malformed" (a
 * `ScanFail` result, a `PageInvalid`). A fault of the data keeps that verdict. The failures are named injections at one site of the
 * production code (`tests/support/data/allocation-faults.ts`), not physical memory exhaustion.
 *
 * Every call is RECORDED (`attempt`) and then asserted: a defect that makes the code throw the wrong thing, or return the wrong verdict,
 * must fail an assertion, not end the test by an error.
 */
afterEach(() => {
  restoreFaults();
});

type Attempt<T> = { value: T } | { threw: unknown };
const attempt = <T>(call: () => T): Attempt<T> => {
  try {
    return { value: call() };
  } catch (threw) {
    return { threw };
  }
};
const threwRange = expect.objectContaining({ threw: expect.any(RangeError) });

const change = (n: number) => ({
  kind: "upsert" as const,
  resource: {
    id: uuid(n),
    kind: "person",
    parent_id: null,
    label: `Person ${n}`,
    value: { n },
    version: 1,
    can_edit: true,
    archived: false,
  },
});
const page = (count: number) =>
  bytesOf(
    pageJson({
      phase: "delta",
      hasMore: false,
      nextCursor: "after-page",
      batches: [
        {
          revision: 1,
          changes: Array.from({ length: count }, (_, i) => change(i + 1)),
        },
      ],
    }),
  );
const SMALL = 3;
const GROWN = 520;

describe("the scan: an allocation failure leaves it as a RangeError", () => {
  test("control: no fault, the page scans", () => {
    for (const count of [SMALL, GROWN]) {
      const done = attempt(() => scanSyncPage(page(count)));
      expect(done).toMatchObject({ value: { ok: true, totalChanges: count } });
    }
  });

  test.each(
    SCAN_SITES.flatMap((site) =>
      site.endsWith("growth")
        ? [{ site, count: GROWN, grown: true }]
        : [
            { site, count: SMALL, grown: false },
            { site, count: GROWN, grown: true },
          ],
    ),
  )(
    "$site ($count changes) throws the RangeError itself, not a ScanFail",
    ({ site, count, grown }) => {
      const fault = injectFault(site, { grown });
      const done = attempt(() => scanSyncPage(page(count)));
      expect(fault.hits).toBe(1);
      expect(fault.stacks[0]).toMatch(/src\/data\/scan\/scan\.ts/);
      expect(done).toEqual(threwRange);
    },
  );

  test.each([
    "key.decode",
    "key.parse",
    "cursor.decode",
    "cursor.parse",
  ] as const)(
    "a small token's allocation failure (%s) is the RangeError too",
    (site) => {
      const fault = injectFault(site, { cursor: "after-page" });
      const done = attempt(() => scanSyncPage(page(SMALL)));
      expect(fault.hits).toBe(1);
      expect(done).toEqual(threwRange);
    },
  );

  const DATA: Array<{ site: TextSite; kind: "syntax" | "utf8" }> = [
    { site: "key.decode", kind: "syntax" },
    { site: "key.decode", kind: "utf8" },
    { site: "key.parse", kind: "syntax" },
    { site: "cursor.decode", kind: "utf8" },
    { site: "cursor.parse", kind: "syntax" },
  ];
  test.each(DATA)(
    "control: a $kind fault at $site is a fault of the page: the verdict `syntax / invalid text`",
    ({ site, kind }) => {
      const fault = injectFault(site, { kind, cursor: "after-page" });
      const done = attempt(() => scanSyncPage(page(SMALL)));
      expect(fault.hits).toBe(1);
      expect(done).toMatchObject({
        value: { ok: false, stage: "syntax", reason: "invalid text" },
      });
    },
  );

  test("control: a REAL invalid byte in a key (no injection) is the same verdict", () => {
    const text = pageJson({
      phase: "delta",
      hasMore: false,
      nextCursor: "after-page",
      batches: [],
    }).replace('"phase"', '"phaZe"');
    const bytes = new TextEncoder().encode(text);
    bytes[text.indexOf("Z")] = 0xff;
    expect(attempt(() => scanSyncPage(bytes))).toMatchObject({
      value: { ok: false, stage: "syntax", reason: "invalid text" },
    });
  });
});

describe("decodeChange: an allocation failure leaves it as a RangeError", () => {
  const defaults = () => ({
    validators: createValueValidators(),
    derivers: createKeyDerivers(),
  });
  const decode = (value: unknown, deps = defaults()) => {
    const bytes = bytesOf(JSON.stringify(value));
    return attempt(() => decodeChange(bytes, 0, bytes.length, 1, deps));
  };
  const removal = { kind: "remove", id: uuid(9) };

  test("control: no fault, both kinds decode", () => {
    expect(decode(change(1))).toMatchObject({ value: { kind: "upsert" } });
    expect(decode(removal)).toEqual({
      value: { kind: "remove", id: uuid(9) },
    });
  });

  test.each([
    { site: "change.decode", of: "upsert" },
    { site: "change.parse", of: "upsert" },
    { site: "change.decode", of: "remove" },
    { site: "change.parse", of: "remove" },
  ] as const)(
    "$site of a $of element throws the RangeError itself, not a PageInvalid",
    ({ site, of }) => {
      const fault = injectFault(site);
      const done = decode(of === "upsert" ? change(1) : removal);
      expect(fault.hits).toBe(1);
      expect(fault.stacks[0]).toMatch(/src\/data\/scan\/validate\.ts/);
      expect(done).toEqual(threwRange);
      expect("threw" in done && done.threw instanceof PageInvalid).toBe(false);
    },
  );

  test.each([
    { site: "change.decode", kind: "syntax" },
    { site: "change.decode", kind: "utf8" },
    { site: "change.parse", kind: "syntax" },
    { site: "change.parse", kind: "utf8" },
  ] as const)(
    "control: a $kind fault at $site is a fault of the page: PageInvalid(element, not_decodable)",
    ({ site, kind }) => {
      const fault = injectFault(site, { kind });
      const done = decode(change(1));
      expect(fault.hits).toBe(1);
      expect(done).toMatchObject({ threw: expect.any(PageInvalid) });
      expect(done).toMatchObject({
        threw: { stage: "element", reason: "not_decodable" },
      });
    },
  );

  test("control: REAL invalid UTF-8 and REAL truncated JSON (no injection) are not_decodable", () => {
    const bytes = bytesOf(
      JSON.stringify(change(1)).replace("Person 1", "PersonZZ"),
    );
    const at = new TextDecoder().decode(bytes).indexOf("ZZ");
    bytes[at] = 0xff;
    expect(
      attempt(() => decodeChange(bytes, 0, bytes.length, 1, defaults())),
    ).toMatchObject({ threw: { stage: "element", reason: "not_decodable" } });
    const truncated = bytesOf('{"kind":"upsert","resource":{');
    expect(
      attempt(() =>
        decodeChange(truncated, 0, truncated.length, 1, defaults()),
      ),
    ).toMatchObject({ threw: { stage: "element", reason: "not_decodable" } });
  });

  test("a validator's allocation failure is the RangeError", () => {
    const oom = defaults();
    oom.validators.register("person", () => {
      throw new RangeError("named validator allocation failure");
    });
    expect(decode(change(1), oom)).toEqual(threwRange);
  });

  test("a validator's ORDINARY defect is still `validator_failed` (control)", () => {
    const defect = defaults();
    defect.validators.register("person", () => {
      throw new Error("a defect of the registrant");
    });
    expect(decode(change(1), defect)).toMatchObject({
      threw: { stage: "value", reason: "validator_failed" },
    });
  });

  test("a deriver's allocation failure is not caught on the way", () => {
    const oom = defaults();
    oom.derivers.register("person", () => {
      throw new RangeError("named deriver allocation failure");
    });
    expect(decode(change(1), oom)).toEqual(threwRange);
  });
});
