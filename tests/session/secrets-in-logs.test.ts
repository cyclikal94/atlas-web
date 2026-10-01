// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { Fixture } from "../support/session/harness";
import { ordinaryGet } from "../support/session/scenarios";

afterEach(() => vi.restoreAllMocks());

/**
 * F-BND-6 / EC-48: no credential, verifier, grant, CSRF token or cookie value appears in any log the harness collects (the
 * world's event log, which includes the kernel's trace) or in anything written to the console, across a whole
 * sign-in, an authenticated request, an invalidation, and a logout. Request bodies are excluded from the fake fetch log by
 * design, so this scans the events the PRODUCT emits.
 */
describe("secrets never reach a log (EC-48)", () => {
  test("password, verifier, grant, CSRF token and session cookie stay out of every log and the console", async () => {
    const consoleCalls: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => {
        consoleCalls.push(args.map((a) => JSON.stringify(a)).join(" "));
      });

    const password = "correct-horse-battery-9271";
    const f = new Fixture();
    f.server.addAccount("kieran", password);
    const page = f.addPage();
    // Capture every verifier the page generates: a verifier is a secret until the attempt is over.
    const verifiers: string[] = [];
    const ids = page.kernel.ports.ids;
    const original = ids.verifier.bind(ids);
    ids.verifier = () => {
      const value = original();
      verifiers.push(value);
      return value;
    };
    await f.boot(page);
    const outcome = await f.signIn(page, "kieran", password);
    expect(outcome.kind).toBe("settled");
    await f.settle();
    const identity = page.session.identity.get();
    if (!identity) throw new Error("not signed in");
    await f.runWith(ordinaryGet(page, identity.account_id, identity.epoch));
    // An invalidation, so the observation path runs too.
    const csrf = page.kernel.memory.csrf.get(
      page.kernel.memory.csrfKey(identity.account_id, identity.epoch),
    );
    const cookie = [...f.server.sessions.values()].map((s) => s.token);
    f.server.revoke(identity.session_id);
    await f.runWith(
      ordinaryGet(page, identity.account_id, identity.epoch).catch(
        () => undefined,
      ),
    );
    await f.settle();

    const grants = [...f.server.grants.keys()];
    const secrets = [
      password,
      ...verifiers,
      ...grants,
      ...cookie,
      ...(csrf ? [csrf] : []),
    ].filter(
      (value): value is string =>
        typeof value === "string" && value.length >= 8,
    );
    expect(verifiers.length).toBeGreaterThan(0);
    expect(secrets.length).toBeGreaterThan(3);
    // What the PRODUCT emits: its trace, the hints it posts, the requests it sends and the locks it takes. The fake store's
    // own `store.*` echo of transaction results is not a product log (it prints the durable record, which holds the
    // verifier while an attempt gates, by design: invariant I1), so it is excluded here and the record is scanned below.
    const emitted = f.world.logs.filter(
      (entry) => !entry.type.startsWith("store."),
    );
    expect(emitted.length).toBeGreaterThan(50);
    const haystack = JSON.stringify(emitted) + consoleCalls.join("\n");
    for (const secret of secrets) expect(haystack).not.toContain(secret);
    // At rest, once the attempt is over, the durable record holds none of them either (the verifier is deleted at
    // settlement; a grant, password, CSRF token and cookie are never written).
    const atRest = JSON.stringify(f.store.records);
    for (const secret of secrets) expect(atRest).not.toContain(secret);
  });
});
