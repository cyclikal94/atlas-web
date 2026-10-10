// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { CalendarResult } from "../../../src/features/calendars/model/result";
import {
  classifySubmission,
  createSubmission,
} from "../../../src/features/calendars/model/submission";

/**
 * D-13a-7: an online-only submission is a PAIR pinned per attempt. "Retry" is the same key and the same body; an edit is a new pair;
 * and a refusal that follows an uncertain attempt of the same pair proves nothing (the backend validates a connection before it looks
 * the key up), so it stays uncertain.
 */
const counter = () => {
  let n = 0;
  return () => `key-${++n}`;
};
type Answer = CalendarResult<{ revision: number }>;
const refused = (status: number, code: string): Answer => ({
  ok: false,
  kind: "refused",
  status,
  code,
  requestId: "r",
});

describe("the pair", () => {
  test("the same body is the same pair; retry is the same pair", () => {
    const s = createSubmission<{ url: string }>(counter());
    const first = s.attempt({ url: "a" });
    expect(first).toEqual({ key: "key-1", body: { url: "a" } });
    expect(s.attempt({ url: "a" })).toBe(first);
    expect(s.current()).toBe(first);
  });
  test("an edit mints a new pair, even back to the old value; a changed body never reuses a key", () => {
    const s = createSubmission<{ url: string }>(counter());
    s.attempt({ url: "a" });
    s.invalidate();
    expect(s.current()).toBeNull();
    expect(s.attempt({ url: "a" }).key).toBe("key-2");
    expect(s.attempt({ url: "b" }).key).toBe("key-3");
  });
  test("uncertainty belongs to the pair: a new pair starts certain", () => {
    const s = createSubmission<{ url: string }>(counter());
    s.markUncertain();
    expect(s.uncertain).toBe(false);
    s.attempt({ url: "a" });
    s.markUncertain();
    expect(s.uncertain).toBe(true);
    s.attempt({ url: "a" });
    expect(s.uncertain).toBe(true);
    s.attempt({ url: "b" });
    expect(s.uncertain).toBe(false);
  });
});

describe("classifySubmission", () => {
  test.each<[string, Answer, boolean, unknown]>([
    ["200", { ok: true, value: { revision: 1 } }, false, { kind: "succeeded" }],
    [
      "a network failure",
      { ok: false, kind: "uncertain" },
      false,
      { kind: "uncertain", check: false },
    ],
    [
      "a 500",
      refused(500, "internal_error"),
      false,
      { kind: "uncertain", check: false },
    ],
    [
      "a 503 temporarily_unavailable",
      refused(503, "temporarily_unavailable"),
      false,
      { kind: "uncertain", check: false },
    ],
    [
      "502 fetch_failed (first attempt)",
      refused(502, "fetch_failed"),
      false,
      { kind: "refused", reason: "fetch_failed", requestId: "r" },
    ],
    [
      "422 invalid_endpoint",
      refused(422, "invalid_endpoint"),
      false,
      { kind: "refused", reason: "url_refused", requestId: "r" },
    ],
    [
      "422 outbound_denied",
      refused(422, "outbound_denied"),
      false,
      { kind: "refused", reason: "url_not_allowed", requestId: "r" },
    ],
    [
      "422 invalid_value",
      refused(422, "invalid_value"),
      false,
      { kind: "refused", reason: "invalid", requestId: "r" },
    ],
    [
      "503 integration_unconfigured",
      refused(503, "integration_unconfigured"),
      false,
      { kind: "refused", reason: "unconfigured", requestId: "r" },
    ],
    [
      "409 conflict",
      refused(409, "conflict"),
      false,
      { kind: "refused", reason: "conflict", requestId: "r" },
    ],
    [
      "403",
      refused(403, "forbidden"),
      false,
      { kind: "refused", reason: "access", requestId: "r" },
    ],
    [
      "404",
      refused(404, "not_found"),
      false,
      { kind: "refused", reason: "gone", requestId: "r" },
    ],
    [
      "409 operation_conflict",
      refused(409, "operation_conflict"),
      false,
      { kind: "refused", reason: "other", requestId: "r" },
    ],
    ["not sent", { ok: false, kind: "not_sent" }, false, { kind: "not_sent" }],
    ["offline", { ok: false, kind: "offline" }, false, { kind: "offline" }],
    ["closed", { ok: false, kind: "closed" }, false, { kind: "closed" }],
  ])("%s", (_name, answer, after, outcome) => {
    expect(classifySubmission(answer, after)).toEqual(outcome);
  });

  test.each([
    refused(502, "fetch_failed"),
    refused(422, "invalid_endpoint"),
    refused(422, "outbound_denied"),
    refused(503, "temporarily_unavailable"),
    refused(503, "integration_unconfigured"),
  ])(
    "after an uncertain attempt, $code proves nothing: uncertain, with Check",
    (answer) => {
      expect(classifySubmission(answer, true)).toEqual({
        kind: "uncertain",
        check: true,
      });
    },
  );
  test("after an uncertain attempt, a conflict or a lost access is still a decision", () => {
    expect(classifySubmission(refused(409, "conflict"), true)).toMatchObject({
      kind: "refused",
      reason: "conflict",
    });
    expect(classifySubmission(refused(403, "forbidden"), true)).toMatchObject({
      kind: "refused",
      reason: "access",
    });
  });
});
