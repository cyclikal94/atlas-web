// @vitest-environment node
import { describe, expect, test } from "vitest";
import { apiUrl } from "../../src/lib/api-client/wire";
import { readIdentity } from "../../src/session/kernel/identity";
import { requestFromEnvelope } from "../../src/session/kernel/operations";
import {
  handleOrdinaryAnswer,
  type SendOutcome,
  send,
} from "../../src/session/kernel/send";
import type { FakePage, Fixture } from "../support/session/harness";
import {
  checkProperties,
  checkQuiescence,
} from "../support/session/properties";
import { logoutEnvelope, operation } from "../support/session/records";
import {
  fencesOf,
  holdAnswers,
  installAttempt,
  leaseIds,
  newWorld,
  openPage,
  ordinaryGet,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-COV-* (check 1): no stamped request of ANY class leaves before its own lease's `complete`; two concurrent
 * requests hold two leases on two lock names; only the login-family exchanges, `activate`, `activate/cancel` and
 * `/health` are unleased; a first failing write sends nothing; each class's precondition; Ex1 and Ex3 per class.
 */
const get = (path: string) => new Request(apiUrl(path), { method: "GET" });

function sendClass(
  page: FakePage,
  klass: "ordinary" | "verification" | "operation" | "recovery",
  account: string,
  epoch: number,
  options: {
    operationId?: string;
    request?: Request;
    identityRead?: boolean;
  } = {},
): Promise<SendOutcome<unknown>> {
  return send(page.kernel, {
    klass,
    account,
    epoch,
    request:
      options.request ??
      get(options.identityRead ? "/browser-sessions/current" : "/probe"),
    identityRead: options.identityRead,
    operationId: options.operationId,
    onAnswer: (k, inflight, response) =>
      handleOrdinaryAnswer(k, inflight, response),
  });
}
const run = async <T>(f: Fixture, p: Promise<T>): Promise<T> => f.runWith(p);

describe("write-ahead lease before every send", () => {
  test("every stamped request is issued only after its own lease's complete, whatever its class", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await run(f, ordinaryGet(l.page, l.account, l.epoch));
    await run(f, l.page.session.operations.listSessions());
    await run(f, l.page.session.operations.readDevices());
    // Verification (an identity read) and a resume verification.
    await f.world.advance(40_000);
    l.page.session.actions.retry();
    await f.world.runUntilIdle();
    const issued = f.world.logs.filter(
      (e) => e.type === "trace.request.issued",
    );
    expect(issued.length).toBeGreaterThanOrEqual(4);
    expect(new Set(issued.map((e) => e.klass))).toContain("verification");
    expect(checkProperties(f)).toEqual([]);
    expect(checkQuiescence(f)).toEqual([]);
  });

  test("two concurrent requests hold two leases on two lock names, never one shared window", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    const a = ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined);
    const b = ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined);
    await f.world.runUntilIdle();
    const ids = leaseIds(f);
    expect(ids).toHaveLength(2);
    const names = f.locks
      .allHeldNames()
      .map((h) => h.name)
      .filter((n) => n.startsWith("atlas-lease-"));
    expect(new Set(names).size).toBe(2);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    await Promise.all([a, b]);
    expect(leaseIds(f)).toEqual([]);
    expect(checkQuiescence(f)).toEqual([]);
  });

  test("only the login-family exchanges, activate, activate/cancel and /health are unleased", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const unstamped = ["/browser-sessions", "/browser-sessions/activate"].map(
      (p) => `/api/experimental/v1${p}`,
    );
    for (const path of unstamped)
      expect(
        f.world.logs.some((e) => e.type === "fetch.sent" && e.path === path),
      ).toBe(true);
    // Every unstamped call happened with no lease request issued for it: only stamped requests emit `request.issued`.
    const issuedPaths = f.world.logs.filter(
      (e) => e.type === "trace.request.issued",
    ).length;
    const sent = f.world.logs.filter((e) => e.type === "fetch.sent").length;
    expect(sent).toBeGreaterThan(issuedPaths); // health, exchange and activate are sent without a lease
    expect(l.page.session.compat.get().status).toBe("supported");
  });
});

describe("a first failing lease write sends nothing", () => {
  test.each(["abort", "error", "quota"] as const)(
    "cover write %s: the request is NOT sent, the paused status is reported, and nothing is left behind",
    async (mode) => {
      const f = await newWorld();
      const l = await signedInPage(f);
      f.store.inject({
        match: (tx) => tx.label === "cover:ordinary",
        mode,
        times: 1,
      });
      const sentBefore = f.world.logs.filter(
        (e) => e.type === "fetch.sent",
      ).length;
      const outcome = await run(
        f,
        ordinaryGet(l.page, l.account, l.epoch).then(
          () => "sent",
          (e: { kind?: string }) => e.kind,
        ),
      );
      expect(outcome).toBe("not_covered");
      expect(f.world.logs.filter((e) => e.type === "fetch.sent").length).toBe(
        sentBefore,
      );
      expect(leaseIds(f)).toEqual([]);
      expect(
        f.locks
          .allHeldNames()
          .filter((h) => h.name.startsWith("atlas-"))
          .map((h) => h.name),
      ).toEqual([]);
      // The next request covers normally: nothing was detected, nothing lost.
      expect(
        await run(f, ordinaryGet(l.page, l.account, l.epoch)),
      ).toBeInstanceOf(Response);
    },
  );

  test("a stuck lease write stalls into NOT_COVERED after 5 s and is never sent", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.store.inject({
      match: (tx) => tx.label === "cover:ordinary",
      mode: "pending_blocking",
      times: 1,
    });
    const outcome = ordinaryGet(l.page, l.account, l.epoch).then(
      () => "sent",
      (e: { kind?: string }) => e.kind,
    );
    await f.world.runUntilIdle();
    // ADAPTED (WEB-08c R4 of the review of 11 October 2026): was `advance(5000)`. A stall is decided BEYOND the bound, after the kernel's
    // `stallGraceMs`; the lease write still never completes and the request is still never sent.
    await f.world.advance(5000 + l.page.kernel.config.stallGraceMs);
    expect(await outcome).toBe("not_covered");
    expect(
      f.world.logs.some(
        (e) => e.type === "fetch.sent" && String(e.path).endsWith("/probe"),
      ),
    ).toBe(false);
  });
});

describe("each class's precondition", () => {
  test("ordinary: refused with a fence, a gating attempt, and an unresolved foreign lease; nothing is sent", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    stateOf(f).fences[l.account] = [
      {
        seq: 1,
        epoch: 1,
        obs_id: "x",
        kind: "invalid_session",
        reason: "unauthenticated",
        created_at: "x",
      },
    ];
    stateOf(f).fence_seq = 1;
    const outcome = await run(
      f,
      sendClass(l.page, "ordinary", l.account, l.epoch),
    );
    expect(outcome.kind).toBe("closed");
    delete stateOf(f).fences[l.account];
    installAttempt(f, { epoch: 2, phase: "verifying" });
    expect(
      (await run(f, sendClass(l.page, "ordinary", l.account, l.epoch))).kind,
    ).toBe("closed");
  });

  test("verification is NOT refused by a fence, an attempt or an unresolved lease: it is what resolves them", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    stateOf(f).fences[l.account] = [
      {
        seq: 1,
        epoch: 1,
        obs_id: "x",
        kind: "invalid_session",
        reason: "unauthenticated",
        created_at: "x",
      },
    ];
    stateOf(f).fence_seq = 1;
    installAttempt(f, { epoch: 2, phase: "verifying" });
    const outcome = await run(
      f,
      sendClass(l.page, "verification", l.account, l.epoch, {
        identityRead: true,
      }),
    );
    expect(["answered", "failed"]).toContain(outcome.kind);
    expect(
      f.world.logs.some(
        (e) => e.type === "trace.request.issued" && e.klass === "verification",
      ),
    ).toBe(true);
  });

  test("operation: needs the operation fence for THIS envelope", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const envelope = logoutEnvelope("op1", l.account, l.epoch, l.sessionId);
    expect(
      (
        await run(
          f,
          sendClass(l.page, "operation", l.account, l.epoch, {
            operationId: "op1",
            request: requestFromEnvelope(envelope),
          }),
        )
      ).kind,
    ).toBe("closed");
    stateOf(f).fences[l.account] = [operation(1, envelope)];
    stateOf(f).fence_seq = 1;
    const outcome = await run(
      f,
      sendClass(l.page, "operation", l.account, l.epoch, {
        operationId: "op1",
        request: requestFromEnvelope(envelope),
      }),
    );
    expect(outcome.kind).toBe("answered");
    expect(
      (
        await run(
          f,
          sendClass(l.page, "operation", l.account, l.epoch, {
            operationId: "other",
            request: requestFromEnvelope(envelope),
          }),
        )
      ).kind,
    ).toBe("closed");
  });

  test("recovery: needs eligibility (older-epoch invalid_session or drift only); paused like ordinary otherwise", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    expect(
      (await run(f, sendClass(l.page, "recovery", l.account, l.epoch))).kind,
    ).toBe("closed"); // no fence: ineligible
    expect(
      await run(f, l.page.session.attempts.begin("password")),
    ).toMatchObject({ kind: "started" });
  });
});

describe("Ex1 and Ex3 across pages", () => {
  test("a second page's cover of EVERY class defers while the first has a request outstanding, and never sends over it", async () => {
    for (const klass of ["ordinary", "verification", "recovery"] as const) {
      const f = await newWorld();
      const m = await signedInPage(f);
      const n = await openPage(f);
      const held = holdAnswers(
        f,
        (r) => r.path.endsWith("/probe") && r.page === m.page.id,
      );
      const first = ordinaryGet(m.page, m.account, m.epoch).catch(
        () => undefined,
      );
      await f.world.runUntilIdle();
      const second = sendClass(n, klass, m.account, m.epoch, {
        identityRead: klass === "verification",
      });
      let settled = false;
      void second.then(() => {
        settled = true;
      });
      await f.world.runUntilIdle();
      expect(settled).toBe(false); // waiting for M: a held lock is not evidence
      held.stop();
      held.release();
      await f.world.runUntilIdle();
      await first;
      await second;
      expect(checkProperties(f)).toEqual([]);
    }
  });

  test("Ex3: another page's UNRESOLVED lease closes ordinary and recovery, is captured by verification, and is ignored by operation", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.store.inject({ match: (tx) => tx.label === "record", mode: "abort" });
    f.server.revoke(l.sessionId);
    await run(
      f,
      ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined),
    );
    l.page.destroy();
    f.store.clearInjections();
    f.server.addRule({
      match: (r) => r.path.endsWith("/browser-sessions/current"),
      rewrite: { status: 502, body: "x", contentType: "text/plain" },
    });
    const n = f.addPage();
    await f.boot(n);
    expect(leaseIds(f)).toHaveLength(1);
    // This page's own token would come from a leased identity read; the gateway blocks that, so seed it for the cover test.
    n.kernel.memory.csrf.set(
      n.kernel.memory.csrfKey(l.account, l.epoch),
      `csrf.${l.sessionId}`,
    );
    expect(
      (await run(f, sendClass(n, "ordinary", l.account, l.epoch))).kind,
    ).toBe("closed_unresolved");
    const verification = await run(
      f,
      readIdentity(n.kernel, l.account, l.epoch, {
        kind: "general",
        expectClear: false,
        onlyIfUnresolved: true,
      }),
    );
    expect(verification.kind).toBe("incomplete"); // captured the unresolved lease, sent, and the 502 resolved nothing
    expect(fencesOf(f, l.account)).toEqual([]); // the 502 resolved nothing
  });
});
