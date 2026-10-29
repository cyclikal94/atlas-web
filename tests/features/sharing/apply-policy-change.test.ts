// @vitest-environment node
import { describe, expect, test } from "vitest";
import { applyPolicyChange } from "../../../src/features/sharing/apply-policy-change";
import { fakeSharingApi, ok } from "../../support/sharing/fake-api";

/**
 * WEB-11a's quick policy change (D-11a-8), an extension of WEB-12a's rules: read, version guard, ONE replace_policy, confirming read.
 * Against the sharing API double (fixture evidence: the I-P5 integration case shows the server's side).
 */
const FIELD = "66666666-6666-4666-8666-666666666666";
const HOME = "33333333-3333-4333-8333-333333333333";
const PRIVATE = { grants: [], exclude_accounts: [] };
const HOME_VIEW = {
  grants: [{ kind: "household" as const, id: HOME, edit: false }],
  exclude_accounts: [],
};
let n = 0;
const env = (api = fakeSharingApi()) => ({
  api,
  newId: () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  },
});
const sleep = async () => undefined;

describe("applyPolicyChange", () => {
  test("read → guarded replace_policy → confirming read: ok with the NEW policy version", async () => {
    const api = fakeSharingApi();
    api.next.policy.push(
      ok({ version: 4, policy: HOME_VIEW }),
      ok({ version: 5, policy: PRIVATE }),
    );
    const outcome = await applyPolicyChange(env(api), {
      resourceId: FIELD,
      from: { version: 4, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: null,
      sleep,
    });
    expect(outcome).toEqual({
      result: { ok: true, policyVersion: 5 },
      attempt: null,
    });
    expect(api.calls.map((c) => c.op)).toEqual([
      "readPolicy",
      "management",
      "readPolicy",
    ]);
    expect(api.sent[0]?.commands).toEqual([
      {
        kind: "replace_policy",
        id: FIELD,
        expected_version: 4,
        policy: PRIVATE,
      },
    ]);
  });

  test("WEB-11a R23.1: the confirming read is asked FRESH (never a read on its way since before the receipt); the base read is not", async () => {
    const api = fakeSharingApi();
    const asked: Array<{ fresh?: boolean } | undefined> = [];
    const read = api.readPolicy;
    api.readPolicy = (id, options) => {
      asked.push(options);
      return read(id, options);
    };
    api.next.policy.push(
      ok({ version: 4, policy: HOME_VIEW }),
      ok({ version: 5, policy: PRIVATE }),
    );
    await applyPolicyChange(env(api), {
      resourceId: FIELD,
      from: { version: 4, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: null,
      sleep,
    });
    expect(asked).toEqual([undefined, { fresh: true }]);
  });

  test("the version guard: a policy that moved since it was shown is 'changed', and nothing is sent", async () => {
    const api = fakeSharingApi();
    api.next.policy.push(ok({ version: 5, policy: HOME_VIEW }));
    const outcome = await applyPolicyChange(env(api), {
      resourceId: FIELD,
      from: { version: 4, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: null,
      sleep,
    });
    expect(outcome.result).toEqual({ ok: false, kind: "changed" });
    expect(api.sent).toEqual([]);
  });

  test("never 'ok' without the confirming read: a confirming read showing another policy is 'changed'", async () => {
    const api = fakeSharingApi();
    api.next.policy.push(
      ok({ version: 4, policy: HOME_VIEW }),
      ok({ version: 6, policy: HOME_VIEW }),
    );
    const outcome = await applyPolicyChange(env(api), {
      resourceId: FIELD,
      from: { version: 4, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: null,
      sleep,
    });
    expect(outcome.result).toEqual({ ok: false, kind: "changed" });
  });

  test("a confirming read that fails keeps the attempt: the receipted change is recognised on retry, never sent twice", async () => {
    const api = fakeSharingApi();
    api.next.policy.push(ok({ version: 4, policy: HOME_VIEW }), {
      ok: false,
      kind: "uncertain",
    });
    const first = await applyPolicyChange(env(api), {
      resourceId: FIELD,
      from: { version: 4, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: null,
      sleep,
    });
    expect(first.result).toEqual({ ok: false, kind: "uncertain" });
    expect(first.attempt).not.toBeNull();
    api.next.policy.push(ok({ version: 5, policy: PRIVATE }));
    const retry = await applyPolicyChange(env(api), {
      resourceId: FIELD,
      from: { version: 4, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: first.attempt,
      sleep,
    });
    expect(retry.result).toEqual({ ok: true, policyVersion: 5 });
    expect(api.sent).toHaveLength(1);
  });

  test("an uncertain send keeps the attempt; Try again resends the SAME key and body", async () => {
    const api = fakeSharingApi();
    api.next.policy.push(ok({ version: 4, policy: HOME_VIEW }));
    api.next.management.push({ ok: false, kind: "uncertain" });
    const first = await applyPolicyChange(env(api), {
      resourceId: FIELD,
      from: { version: 4, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: null,
      sleep,
    });
    expect(first.result.ok).toBe(false);
    api.next.policy.push(
      ok({ version: 4, policy: HOME_VIEW }),
      ok({ version: 5, policy: PRIVATE }),
    );
    const retry = await applyPolicyChange(env(api), {
      resourceId: FIELD,
      from: { version: 4, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: first.attempt,
      sleep,
    });
    expect(retry.result).toEqual({ ok: true, policyVersion: 5 });
    expect(api.sent.map((s) => s.key)).toEqual([
      first.attempt?.key,
      first.attempt?.key,
    ]);
  });

  test("refusals are classified; a refused read is never retried as a send", async () => {
    for (const [answer, kind] of [
      [{ ok: false, kind: "forbidden" }, "forbidden"],
      [{ ok: false, kind: "not_found" }, "not_found"],
      [{ ok: false, kind: "offline" }, "offline"],
      [{ ok: false, kind: "closed" }, "closed"],
    ] as const) {
      const api = fakeSharingApi();
      api.next.policy.push(answer);
      const outcome = await applyPolicyChange(env(api), {
        resourceId: FIELD,
        from: { version: 4, policy: HOME_VIEW },
        to: PRIVATE,
        attempt: null,
        sleep,
      });
      expect(outcome.result).toEqual({ ok: false, kind });
      expect(api.sent).toEqual([]);
    }
  });

  test("a version conflict on the send is 'conflict' and ends the attempt", async () => {
    const api = fakeSharingApi();
    api.next.policy.push(ok({ version: 4, policy: HOME_VIEW }));
    api.next.management.push({ ok: false, kind: "conflict", requestId: "r" });
    const outcome = await applyPolicyChange(env(api), {
      resourceId: FIELD,
      from: { version: 4, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: null,
      sleep,
    });
    expect(outcome).toEqual({
      result: { ok: false, kind: "conflict", requestId: "r" },
      attempt: null,
    });
  });

  test("an identity that moved on stops it before anything is sent", async () => {
    const api = fakeSharingApi();
    api.next.policy.push(ok({ version: 4, policy: HOME_VIEW }));
    const outcome = await applyPolicyChange(env(api), {
      resourceId: FIELD,
      from: { version: 4, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: null,
      isCurrent: () => false,
      sleep,
    });
    expect(outcome.result).toEqual({ ok: false, kind: "closed" });
    expect(api.sent).toEqual([]);
  });

  test("admit (WEB-11a review 2): asked with the EXACT attempt before it is sent; false sends nothing and keeps the earlier attempt", async () => {
    for (const admitted of [true, false]) {
      const api = fakeSharingApi();
      api.next.policy.push(
        ok({ version: 4, policy: HOME_VIEW }),
        ok({ version: 5, policy: PRIVATE }),
      );
      const asked: Array<{ key: string; body: string }> = [];
      const outcome = await applyPolicyChange(env(api), {
        resourceId: FIELD,
        from: { version: 4, policy: HOME_VIEW },
        to: PRIVATE,
        attempt: null,
        admit: async (attempt) => {
          asked.push(attempt);
          // Nothing was sent when it is asked.
          expect(api.sent).toEqual([]);
          return admitted;
        },
        sleep,
      });
      expect(asked).toHaveLength(1);
      if (admitted) {
        expect(api.sent).toEqual([
          { key: asked[0]?.key, commands: expect.any(Array) },
        ]);
        expect(outcome.result).toEqual({ ok: true, policyVersion: 5 });
      } else {
        expect(api.sent).toEqual([]);
        expect(outcome).toEqual({
          result: { ok: false, kind: "closed" },
          attempt: null,
        });
      }
    }
  });

  test("an identity that moves on WHILE the attempt is admitted stops it before the send", async () => {
    const api = fakeSharingApi();
    api.next.policy.push(ok({ version: 4, policy: HOME_VIEW }));
    let current = true;
    const outcome = await applyPolicyChange(env(api), {
      resourceId: FIELD,
      from: { version: 4, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: null,
      isCurrent: () => current,
      admit: async () => {
        current = false;
        return true;
      },
      sleep,
    });
    expect(outcome.result).toEqual({ ok: false, kind: "closed" });
    expect(api.sent).toEqual([]);
  });
});
