import { describe, expect, test } from "vitest";
import {
  type CapabilityEnv,
  checkCapabilities,
  probeCapabilities,
} from "../../src/app/capabilities";

/** A working IndexedDB double: open succeeds and deleteDatabase is recorded. */
function workingIndexedDb() {
  const deleted: string[] = [];
  return {
    deleted,
    factory: {
      open: () => {
        const request = {
          result: { close: () => {} },
        } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => request.onsuccess?.(new Event("success")));
        return request;
      },
      deleteDatabase: (name: string) => {
        deleted.push(name);
        return {} as IDBOpenDBRequest;
      },
    },
  };
}

function env(overrides: Partial<CapabilityEnv> = {}): CapabilityEnv {
  return {
    isSecureContext: true,
    locks: {
      request: (async (
        _name: string,
        _options: unknown,
        callback: (lock: Lock | null) => unknown,
      ) => callback({} as Lock)) as LockManager["request"],
    },
    indexedDB: workingIndexedDb().factory,
    hasInert: true,
    ...overrides,
  };
}

describe("checkCapabilities (presence)", () => {
  test("a fully capable browser is ok", () => {
    expect(checkCapabilities(env())).toEqual({ ok: true, issues: [] });
  });

  test.each([
    ["an insecure context", { isSecureContext: false }, "secure-context"],
    ["no Web Locks", { locks: undefined }, "web-locks"],
    [
      "a locks object without request",
      { locks: {} as CapabilityEnv["locks"] },
      "web-locks",
    ],
    ["no IndexedDB", { indexedDB: undefined }, "indexeddb"],
    ["no inert", { hasInert: false }, "inert"],
  ] as const)("%s is reported as absent", (_name, overrides, id) => {
    expect(checkCapabilities(env(overrides))).toEqual({
      ok: false,
      issues: [{ id, reason: "absent" }],
    });
  });

  test("every missing capability is listed", () => {
    const report = checkCapabilities(
      env({
        isSecureContext: false,
        locks: undefined,
        indexedDB: undefined,
        hasInert: false,
      }),
    );
    expect(report.issues.map((issue) => issue.id).sort()).toEqual([
      "indexeddb",
      "inert",
      "secure-context",
      "web-locks",
    ]);
  });
});

describe("probeCapabilities (functional)", () => {
  test("a working browser passes both probes and leaves no database behind", async () => {
    const idb = workingIndexedDb();
    const report = await probeCapabilities(
      env({ indexedDB: idb.factory }),
      200,
    );
    expect(report.ok).toBe(true);
    expect(idb.deleted).toHaveLength(1);
    expect(idb.deleted[0]).toMatch(/^atlas-capability-probe-/);
  });

  test("locks that grant null (not immediately available) fail", async () => {
    const locks = {
      request: (async (
        _n: string,
        _o: unknown,
        cb: (lock: Lock | null) => unknown,
      ) => cb(null)) as LockManager["request"],
    };
    const report = await probeCapabilities(env({ locks }), 200);
    expect(report.issues).toEqual([{ id: "web-locks", reason: "failed" }]);
  });

  test("locks that reject fail", async () => {
    const locks = {
      request: (async () => {
        throw new Error("nope");
      }) as LockManager["request"],
    };
    expect((await probeCapabilities(env({ locks }), 200)).issues).toEqual([
      { id: "web-locks", reason: "failed" },
    ]);
  });

  test("locks that never resolve time out as failed", async () => {
    const locks = {
      request: (() => new Promise(() => {})) as LockManager["request"],
    };
    const started = Date.now();
    const report = await probeCapabilities(env({ locks }), 60);
    expect(report.issues).toEqual([{ id: "web-locks", reason: "failed" }]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("IndexedDB that throws on open (private windows) fails", async () => {
    const indexedDB = {
      open: () => {
        throw new DOMException("denied", "SecurityError");
      },
      deleteDatabase: () => ({}) as IDBOpenDBRequest,
    };
    expect((await probeCapabilities(env({ indexedDB }), 200)).issues).toEqual([
      { id: "indexeddb", reason: "failed" },
    ]);
  });

  test("IndexedDB whose open errors fails, and the probe database is deleted best-effort", async () => {
    const deleted: string[] = [];
    const indexedDB = {
      open: () => {
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => request.onerror?.(new Event("error")));
        return request;
      },
      deleteDatabase: (name: string) => {
        deleted.push(name);
        return {} as IDBOpenDBRequest;
      },
    };
    expect((await probeCapabilities(env({ indexedDB }), 200)).issues).toEqual([
      { id: "indexeddb", reason: "failed" },
    ]);
    expect(deleted).toHaveLength(1);
  });

  test("IndexedDB that is blocked fails", async () => {
    const indexedDB = {
      open: () => {
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() =>
          request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent),
        );
        return request;
      },
      deleteDatabase: () => ({}) as IDBOpenDBRequest,
    };
    expect((await probeCapabilities(env({ indexedDB }), 200)).issues).toEqual([
      { id: "indexeddb", reason: "failed" },
    ]);
  });

  test("IndexedDB that never answers times out as failed", async () => {
    const indexedDB = {
      open: () => ({}) as IDBOpenDBRequest,
      deleteDatabase: () => ({}) as IDBOpenDBRequest,
    };
    expect((await probeCapabilities(env({ indexedDB }), 60)).issues).toEqual([
      { id: "indexeddb", reason: "failed" },
    ]);
  });

  test("an absent capability is reported as absent and is not probed", async () => {
    const report = await probeCapabilities(
      env({ locks: undefined, isSecureContext: false }),
      200,
    );
    expect(report.issues).toEqual([
      { id: "secure-context", reason: "absent" },
      { id: "web-locks", reason: "absent" },
    ]);
  });

  describe("the atlas-auth canary (WEB-08a, matrix 3.7.2 item 3)", () => {
    test("a canary that writes passes, and runs only after the throwaway database opened", async () => {
      const calls: string[] = [];
      const report = await probeCapabilities(
        env({
          canary: async () => {
            calls.push("canary");
            return true;
          },
        }),
        200,
      );
      expect(report).toEqual({ ok: true, issues: [] });
      expect(calls).toEqual(["canary"]);
    });

    test.each([
      ["answers false", async () => false],
      ["rejects", async () => Promise.reject(new Error("quota"))],
      ["never answers", () => new Promise<boolean>(() => undefined)],
    ])("a canary that %s is an indexeddb failure", async (_name, canary) => {
      const report = await probeCapabilities(env({ canary }), 50);
      expect(report.ok).toBe(false);
      expect(report.issues).toEqual([{ id: "indexeddb", reason: "failed" }]);
    });

    test("when IndexedDB itself failed the canary is not run and the failure is reported once", async () => {
      let ran = false;
      const report = await probeCapabilities(
        env({
          indexedDB: {
            open: () => {
              throw new Error("private window");
            },
            deleteDatabase: () => ({}) as IDBOpenDBRequest,
          },
          canary: async () => {
            ran = true;
            return true;
          },
        }),
        200,
      );
      expect(ran).toBe(false);
      expect(report.issues).toEqual([{ id: "indexeddb", reason: "failed" }]);
    });

    test("no canary supplied: behaviour is exactly WEB-07's", async () => {
      expect((await probeCapabilities(env(), 200)).ok).toBe(true);
    });
  });
});
