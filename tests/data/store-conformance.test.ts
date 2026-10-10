// @vitest-environment node
import { describe, expect, test } from "vitest";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { AccountStore } from "../../src/data/store/port";
import {
  blockerPlan,
  CONFORMANCE_CASES,
  type ConformanceWorld,
} from "../../src/fixture/data-harness/conformance";
import { DataTestWorld } from "../support/data/env";

/**
 * F-A3: the ONE conformance suite that the store double and the real Dexie adapter must both pass. This file runs it against
 * the double. The same cases run against the real adapter in Chromium, Firefox and WebKit (tests/e2e/fixture.data-store.spec.ts),
 * which is what validates the double: a passing run here proves nothing about IndexedDB by itself.
 */
function worldFor(env: DataTestWorld): ConformanceWorld {
  let counter = 0;
  return {
    async fresh(): Promise<AccountStore> {
      const page = env.page("A");
      counter += 1;
      const account = `acct-${counter}`;
      page.identity.account = account;
      const opened = await page.open(account, { create: true });
      if (opened.kind !== "opened")
        throw new Error(`could not create: ${opened.kind}`);
      return opened.store;
    },
    async second(of: AccountStore): Promise<AccountStore> {
      const page = env.page("A");
      page.identity.account = of.account;
      const opened = await page.open(of.account);
      if (opened.kind !== "opened")
        throw new Error(`could not reopen: ${opened.kind}`);
      return opened.store;
    },
    // The double holds it with a fault injection (a real engine keeps it open with a loop of reads): it never starts, so everything
    // after it on the database queues, until it is ended.
    async blocker(store: AccountStore) {
      env.idb.inject({
        match: (tx) => tx.label === "conformance.blocker",
        mode: "pending_blocking",
        times: 1,
      });
      void store
        .run(
          blockerPlan(() => false),
          null,
        )
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        release: () => {
          env.idb.releaseStuck(accountDatabaseName(store.account));
        },
      };
    },
  };
}

describe("F-A3: the store double passes the shared conformance suite", () => {
  for (const testCase of CONFORMANCE_CASES) {
    test(`${testCase.id} ${testCase.title}`, async () => {
      const env = new DataTestWorld();
      env.idb.autoDrive = true;
      await testCase.run(worldFor(env), {
        ok: (value, message) => expect(Boolean(value), message).toBe(true),
        equal: (actual, expected, message) =>
          expect(actual, message).toBe(expected),
        deepEqual: (actual, expected, message) =>
          expect(actual, message).toEqual(expected),
      });
    });
  }
});
