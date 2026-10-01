import { type FakePage, Fixture } from "./harness";
import type { Delay } from "./matrix-exposure";
import { bootstrapSettled } from "./matrix-exposure";
import { type Modules, srcModules } from "./modules";
import {
  checkExclusiveActivity,
  checkProperties,
  checkQuiescence,
} from "./properties";
import { holdAnswers, holdLock } from "./scenarios";

/**
 * Checks 13 (a) and 14: a VICTIM (a covered-but-unsent request, or an exposure attempt) races a CLOSING WRITE (an
 * activating attempt, a settlement, an operation fence) made by the victim's own page or by another page. Every stage
 * of the victim's life, both creation orders, the publication delay of lock releases, and every way the write can end.
 * Properties: V3 and V5 (nothing is issued or acted on after a closing write commits), V4, W1 to W3, P-G.
 */
export type WriteKind = "activating" | "settlement" | "operation";
export const CLOSING_FACTORS = {
  victim: ["request", "exposure"] as const,
  writer: ["foreign", "own"] as const,
  write: ["activating", "settlement", "operation"] as const,
  stage: ["S1", "S2", "S3", "S4", "S5"] as const,
  order: ["victim_first", "write_first"] as const,
  release: ["during", "after"] as const,
  d1: [0, 10, "unbounded"] as readonly Delay[],
  klass: ["ordinary", "recovery"] as const,
  outcome: ["commit", "abort", "timeout", "superseded"] as const,
  d3: ["zero", "after_write", "unbounded"] as const,
};
export type ClosingParams = {
  [K in keyof typeof CLOSING_FACTORS]: (typeof CLOSING_FACTORS)[K][number];
};

/** Check 14 (P5-N): the victim is a request. d3 is irrelevant and pinned. */
export const REQUEST_FACTORS = {
  ...CLOSING_FACTORS,
  victim: ["request"] as const,
  d3: ["zero"] as const,
};
/** Check 13 (a) (P5-K): the victim is the page's own exposure attempt; klass is irrelevant and pinned. */
export const EXPOSURE_OWN_FACTORS = {
  ...CLOSING_FACTORS,
  victim: ["exposure"] as const,
  writer: ["own"] as const,
  klass: ["ordinary"] as const,
};

export interface ClosingResult {
  params: ClosingParams;
  violations: string[];
  stats: { committed: number; issued: number; attached: number };
}

const P = "p1";
const Q_FOREIGN = "p2";
const Z = "p3";

export async function runClosing(
  params: ClosingParams,
  modules: Modules = srcModules,
): Promise<ClosingResult> {
  const fixture = new Fixture({ seed: 11, modules });
  const { world } = fixture;
  const recovery = params.victim === "request" && params.klass === "recovery";
  const { account, epoch, session, seedToken } = await bootstrapSettled(
    fixture,
    { epoch: recovery ? 2 : 1, fences: "none" },
  );
  // Pages: P (victim), Q (foreign writer) and Z (a foreign outstanding request, for S4).
  const p = fixture.addPage();
  seedToken(p);
  await fixture.boot(p);
  const q: FakePage = params.writer === "own" ? p : fixture.addPage();
  if (q !== p) {
    seedToken(q);
    await fixture.boot(q);
  }
  const z = fixture.addPage();
  seedToken(z);
  await fixture.boot(z);
  if (params.victim === "exposure") p.hide();
  await world.runUntilIdle();

  const state = fixture.store.records.auth_state;
  const nextEpoch = state.latest_epoch + 1;
  if (recovery) {
    state.fences[account] = [
      {
        seq: 1,
        epoch: 1,
        obs_id: "old",
        kind: "invalid_session",
        reason: "unauthenticated",
        created_at: "x",
      },
    ];
    state.fence_seq = 1;
  }
  const targetEpoch =
    params.outcome === "superseded" ? nextEpoch + 50 : nextEpoch;
  if (params.write !== "operation") {
    state.latest_epoch = nextEpoch;
    state.attempt = {
      epoch: nextEpoch,
      method: "password",
      phase: "exchanging",
      previous_account_id: account,
      target_account_id: null,
      verifier: "v".repeat(43),
      observations_deferred: null,
      cancel_result: null,
      started_at: "2026-09-30T12:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
  } else if (params.outcome === "superseded") {
    // Another operation is already pending: this one is REFUSED and commits nothing.
    state.fences[account] = [
      ...(state.fences[account] ?? []),
      {
        seq: 9,
        epoch,
        obs_id: "x",
        kind: "operation",
        envelope: {
          operation_id: "other",
          op: "logout",
          account_id: account,
          target: { session_id: session.id },
          initiated_epoch: epoch,
        },
        created_at: "x",
      },
    ];
    state.fence_seq = 9;
  }
  if (params.outcome === "timeout") {
    // A reservation of another page that is never released: the write waits at most 20 s, then gives up.
    state.leases["lease-zz"] = {
      account_id: "somebody-else",
      epoch: 1,
      boot_id: "zz-boot",
      created_at: "x",
      class: "ordinary",
    };
    await holdLock(fixture, "ZZ", "atlas-issue-lease-zz");
  }
  if (params.outcome === "abort")
    fixture.store.inject({
      match: (tx) => tx.label.startsWith("closing:"),
      mode: "abort",
    });

  // ---- knobs for the victim's stage ----
  const victimLabel =
    params.victim === "exposure" ? "cover:exposure" : `cover:${params.klass}`;
  const held: Array<() => number> = [];
  const isVictim = (m: { page?: string | null }) => m.page === P;
  const stageKnob = () => {
    if (params.stage === "S1")
      world.setKnob(
        "lock_grant",
        "unbounded",
        (m) => isVictim(m) && String(m.name ?? "").startsWith("atlas-lease-"),
      );
    else if (params.stage === "S2")
      world.setKnob(
        "store_start",
        "unbounded",
        (m) => m.txPage === P && m.label === victimLabel,
      );
    else if (params.stage === "S3")
      world.setKnob(
        "D0",
        "unbounded",
        (m) => isVictim(m) && m.label === victimLabel,
      );
    else if (params.stage === "S5")
      world.setKnob(
        "D0",
        "unbounded",
        (m) => isVictim(m) && m.label === victimLabel,
      );
  };
  stageKnob();
  if (params.d1 !== 0) world.setKnob("D1", params.d1);
  if (params.victim === "exposure") {
    if (params.d3 === "unbounded" || params.d3 === "after_write")
      world.setKnob("D3", "unbounded", (m) => isVictim(m));
  }
  let zRequest: Promise<unknown> | null = null;
  if (params.stage === "S4") {
    const hold = holdAnswers(
      fixture,
      (r) => r.page === Z && r.path.endsWith("/probe"),
    );
    held.push(() => {
      hold.stop();
      return world.release("Da");
    });
    zRequest = z.session.api
      .fetchFor(
        "ordinary",
        account,
        epoch,
      )(new Request("http://localhost/api/experimental/v1/probe"))
      .catch(() => undefined);
    await world.runUntilIdle();
  }

  // Release moments: the victim's held events at the write's begin ("during") or after it ended ("after"); S5 and
  // "after_write" acts are released exactly when the write commits.
  const releaseVictim = () => {
    world.release("lock_grant", (m) => isVictim(m));
    world.release("store_start", (m) => m.txPage === P);
    world.release("D0", (m) => isVictim(m));
    for (const h of held) h();
  };
  let began = false;
  let committed = 0;
  world.onLog((entry) => {
    if (entry.type === "trace.closing.begin" && !began) {
      began = true;
      if (params.release === "during" && params.stage !== "S5") releaseVictim();
    }
    if (
      entry.type === "store.commit" &&
      String(entry.label).startsWith("closing:") &&
      entry.wrote === true
    ) {
      committed += 1;
      if (params.stage === "S5") world.release("D0", (m) => isVictim(m));
      if (params.victim === "exposure" && params.d3 === "after_write")
        world.release("D3", (m) => isVictim(m));
    }
  });

  // ---- the victim and the write ----
  const startVictim = () => {
    if (params.victim === "request")
      void p.session.api
        .fetchFor(
          params.klass,
          account,
          epoch,
        )(
          new Request(
            `http://localhost/api/experimental/v1/${params.klass === "recovery" ? "sync" : "probe"}`,
          ),
        )
        .catch(() => undefined);
    else p.show();
  };
  const executeWrite = async () => {
    const { beginClosing, endClosing } = modules.expose;
    const { runClosingTransaction } = modules.closing;
    const k = q.kernel;
    const now = k.ports.clock.iso();
    const activating = async () => {
      beginClosing(k);
      try {
        await runClosingTransaction(k, {
          holdsAuth: false,
          label: "closing:activating",
          body: (r) =>
            modules.attemptReducers.beginActivating(r, { epoch: targetEpoch }),
        });
      } finally {
        endClosing(k);
      }
    };
    const settlement = async () => {
      const auth = await k.ports.locks.acquire("atlas-auth", {
        signal: k.ports.clock.abortAfter(20_000),
      });
      if (!auth) return;
      beginClosing(k);
      try {
        await runClosingTransaction(k, {
          holdsAuth: true,
          label: "closing:settle",
          body: (r) =>
            modules.attemptReducers.settle(r, {
              epoch: targetEpoch,
              account_id: "acct-new",
              session_id: "s-new",
              now,
            }),
        });
      } finally {
        endClosing(k);
        auth.release();
      }
    };
    if (params.write === "activating") await activating();
    else if (params.write === "settlement") {
      await activating();
      await settlement();
    } else {
      beginClosing(k);
      try {
        await runClosingTransaction(k, {
          holdsAuth: false,
          label: "closing:operation",
          body: (r) =>
            modules.operationReducers.raiseOperationFence(r, {
              op: "logout",
              account_id: account,
              epoch,
              operation_id: "op-new",
              obs_id: "obs-new",
              now,
            }),
        });
      } finally {
        endClosing(k);
      }
    }
  };
  let writeDone: Promise<void> = Promise.resolve();
  if (params.order === "victim_first") {
    startVictim();
    await world.runUntilIdle();
    writeDone = executeWrite();
  } else {
    writeDone = executeWrite();
    startVictim();
  }
  await world.runUntilIdle();
  // A settlement is two writes; each waits its own 20 s on the reservation that is never released.
  if (params.outcome === "timeout") await world.advance(45_000);
  await world.runUntilIdle();
  if (params.release === "after") releaseVictim();
  await world.runUntilIdle();
  // Anything still held is delivered last, so a late completion meets the final state. The write is awaited only
  // AFTER the holds it may be waiting on have been released.
  world.release();
  world.clearKnobs();
  await world.runUntilIdle();
  await world.advance(70_000); // past the longest back-off, so every retry loop has run
  await world.runUntilIdle();
  await writeDone.catch(() => undefined);
  await zRequest;

  const violations = [
    ...checkProperties(fixture, { invalidating: [401] }),
    ...checkExclusiveActivity(fixture),
    ...checkQuiescence(fixture),
  ];
  return {
    params,
    violations,
    stats: {
      committed,
      issued: world.logs.filter(
        (e) => e.type === "trace.request.issued" && e.page === P,
      ).length,
      attached: world.logs.filter(
        (e) => e.type === "surface.attach" && e.page === P,
      ).length,
    },
  };
}

void Q_FOREIGN;
