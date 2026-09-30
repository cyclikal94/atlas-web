/**
 * Browser capability check (Q12). Atlas requires Web Locks, IndexedDB, the HTML inert attribute and a secure
 * context. There is no fallback for a missing or failing capability: coordination between tabs and the
 * account-data deletion and recovery guarantees depend on them. WEB-08a extends this with the atlas-auth
 * canary and the api_version check.
 */

export type CapabilityId =
  | "secure-context"
  | "web-locks"
  | "indexeddb"
  | "inert";
export interface CapabilityIssue {
  id: CapabilityId;
  /** "absent": the feature is missing. "failed": it is present but did not work (or did not answer in time). */
  reason: "absent" | "failed";
}
export interface CapabilityReport {
  ok: boolean;
  issues: readonly CapabilityIssue[];
}

/** The parts of the browser the check reads, so tests can substitute them. */
export interface CapabilityEnv {
  isSecureContext: boolean;
  locks: Pick<LockManager, "request"> | undefined;
  indexedDB: Pick<IDBFactory, "open" | "deleteDatabase"> | undefined;
  hasInert: boolean;
}

export function browserEnv(): CapabilityEnv {
  let indexedDb: IDBFactory | undefined;
  try {
    indexedDb = globalThis.indexedDB;
  } catch {
    // Some privacy modes throw on access.
    indexedDb = undefined;
  }
  return {
    isSecureContext: globalThis.isSecureContext === true,
    locks: typeof navigator !== "undefined" ? navigator.locks : undefined,
    indexedDB: indexedDb,
    hasInert:
      typeof HTMLElement !== "undefined" && "inert" in HTMLElement.prototype,
  };
}

const report = (issues: CapabilityIssue[]): CapabilityReport => ({
  ok: issues.length === 0,
  issues,
});

/** Presence only, synchronous. */
export function checkCapabilities(
  env: CapabilityEnv = browserEnv(),
): CapabilityReport {
  const issues: CapabilityIssue[] = [];
  if (!env.isSecureContext)
    issues.push({ id: "secure-context", reason: "absent" });
  if (!env.locks || typeof env.locks.request !== "function")
    issues.push({ id: "web-locks", reason: "absent" });
  if (!env.indexedDB) issues.push({ id: "indexeddb", reason: "absent" });
  if (!env.hasInert) issues.push({ id: "inert", reason: "absent" });
  return report(issues);
}

function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve("timeout");
      },
    );
  });
}

function uniqueName(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

/** A lock request that must be granted at once. A grant that never arrives, or arrives as null, fails. */
async function locksWork(
  locks: Pick<LockManager, "request">,
): Promise<boolean> {
  const granted = await locks.request(
    uniqueName("atlas-capability-probe"),
    { ifAvailable: true },
    (lock) => lock !== null,
  );
  return granted === true;
}

/** Opens and deletes a throwaway database. Best-effort clean-up, so a failed probe leaves nothing behind. */
function indexedDbWork(
  factory: Pick<IDBFactory, "open" | "deleteDatabase">,
): Promise<boolean> {
  const name = uniqueName("atlas-capability-probe");
  return new Promise<boolean>((resolve) => {
    let request: IDBOpenDBRequest;
    const cleanUp = () => {
      try {
        factory.deleteDatabase(name);
      } catch {
        // Nothing further can be done.
      }
    };
    try {
      request = factory.open(name, 1);
    } catch {
      resolve(false);
      return;
    }
    request.onsuccess = () => {
      request.result.close();
      cleanUp();
      resolve(true);
    };
    request.onerror = () => {
      cleanUp();
      resolve(false);
    };
    request.onblocked = () => {
      cleanUp();
      resolve(false);
    };
  });
}

/** Functional probes for every capability that is present. Each probe is bounded by timeoutMs (default 3 s). */
export async function probeCapabilities(
  env: CapabilityEnv = browserEnv(),
  timeoutMs = 3000,
): Promise<CapabilityReport> {
  const presence = checkCapabilities(env);
  const issues: CapabilityIssue[] = [...presence.issues];
  const absent = new Set(presence.issues.map((issue) => issue.id));

  const probes: Array<Promise<void>> = [];
  if (!absent.has("web-locks") && env.locks) {
    const locks = env.locks;
    probes.push(
      withTimeout(locksWork(locks), timeoutMs).then((result) => {
        if (result !== true) issues.push({ id: "web-locks", reason: "failed" });
      }),
    );
  }
  if (!absent.has("indexeddb") && env.indexedDB) {
    const factory = env.indexedDB;
    probes.push(
      withTimeout(indexedDbWork(factory), timeoutMs).then((result) => {
        if (result !== true) issues.push({ id: "indexeddb", reason: "failed" });
      }),
    );
  }
  await Promise.all(probes);
  return report(issues);
}
