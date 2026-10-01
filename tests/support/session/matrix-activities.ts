import { Fixture } from "./harness";
import { bootstrapSettled, type Delay } from "./matrix-exposure";
import { type Modules, srcModules } from "./modules";
import {
  checkExclusiveActivity,
  checkNoActByCancelled,
  checkProperties,
  checkQuiescence,
} from "./properties";
import { holdAnswers } from "./scenarios";
import type { EventMeta } from "./world";

/**
 * Check 13 (b) and (c): the page's OWN later events against its OWN earlier, asynchronous decision.
 *
 * (c) P5-M - a queued second request of the page against the page's own detection through its first: request A is
 *     answered 401, the recording aborts, stays pending or commits, and request B, whose cover was committed BEFORE
 *     the detection, must never be issued after it, however late B's completion is delivered.
 * (b) P5-L - every stage S1 to S5 of an exposure attempt against every cancellation trigger Ta to Tf, with the older
 *     completion delivered before, during and after a newer attempt's COVERING, RESERVED and displaying states.
 */
export const OWN_DETECTION_FACTORS = {
  klass: ["ordinary", "recovery"] as const,
  d4: ["abort", "pending", "commit"] as const,
  d0B: [0, 10, "unbounded", "after_record"] as readonly (
    | Delay
    | "after_record"
  )[],
  daA: [0, 10] as readonly Delay[],
  order: ["A_first", "B_first"] as const,
  pageState: ["visible", "hidden"] as const,
};
export type OwnDetectionParams = {
  [K in keyof typeof OWN_DETECTION_FACTORS]: (typeof OWN_DETECTION_FACTORS)[K][number];
};

export interface ActivityResult {
  params: unknown;
  violations: string[];
  stats: { issuedB: boolean; detected: boolean; acted: number };
}

export async function runOwnDetection(
  params: OwnDetectionParams,
  modules: Modules = srcModules,
): Promise<ActivityResult> {
  const fixture = new Fixture({ seed: 13, modules });
  const { world } = fixture;
  const recovery = params.klass === "recovery";
  const { account, epoch, session, seedToken } = await bootstrapSettled(
    fixture,
    { epoch: recovery ? 2 : 1, fences: "none" },
  );
  const n = fixture.addPage();
  seedToken(n);
  await fixture.boot(n);
  if (recovery) {
    const state = fixture.store.records.auth_state;
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
  if (params.pageState === "hidden") n.hide();
  await world.runUntilIdle();

  const path = recovery ? "/sync" : "/probe";
  // A is the request answered 401; B is the sibling whose cover was committed before the detection.
  fixture.server.addRule({
    match: (r) => r.path.endsWith(path) && r.ordinal === 1,
    rewrite: {
      status: 401,
      body: {
        code: "unauthenticated",
        message: "m",
        request_id: "r",
        details: [],
      },
    },
  });
  if (params.daA !== 0) world.setKnob("Da", params.daA, (m) => m.page === n.id);
  if (params.d4 !== "commit")
    fixture.store.inject({
      match: (tx) => tx.label === "record",
      mode: params.d4 === "abort" ? "abort" : "pending",
    });
  let recordDone = false;
  world.onLog((entry) => {
    if (entry.type === "trace.record.complete") {
      recordDone = true;
      world.release("D0", (m) => m.txSlot === "B");
    }
  });
  const send = () =>
    n.session.api
      .fetchFor(
        params.klass,
        account,
        epoch,
      )(new Request(`http://localhost/api/experimental/v1${path}`))
      .catch(() => undefined);
  // B's cover completion is delayed (or released after the recording completes).
  let bLabelSeen = 0;
  const bDelay = params.d0B === "after_record" ? "unbounded" : params.d0B;
  if (bDelay !== 0) {
    world.setKnob("D0", bDelay as Delay, (m) => {
      if (m.page !== n.id || m.label !== `cover:${params.klass}`) return false;
      bLabelSeen += 1;
      return bLabelSeen === 2; // the second cover of the page is B's
    });
  }
  if (params.order === "A_first") {
    void send();
    void send();
  } else {
    void send();
    await world.runUntilIdle();
    void send();
  }
  await world.runUntilIdle();
  world.release();
  world.clearKnobs();
  await world.runUntilIdle();
  await world.advance(70_000); // past the longest back-off, so every retry loop has run
  await world.runUntilIdle();
  void recordDone;

  const violations = [
    ...checkProperties(fixture, { invalidating: [401] }),
    ...checkQuiescence(fixture),
  ];
  const detection = world.logs.find(
    (e) => e.type === "trace.surrender" && e.status === 401,
  );
  const issued = world.logs.filter(
    (e) => e.type === "trace.request.issued" && e.page === n.id,
  );
  void session;
  return {
    params,
    violations,
    stats: {
      issuedB: issued.length > 1,
      detected: !!detection,
      acted: world.logs.filter((e) => e.type === "surface.attach").length,
    },
  };
}

// ---- P5-L: stages x triggers x delivery of the older completion ---------------------------------------------------
export const STAGE_TRIGGER_FACTORS = {
  stage: ["S1", "S2", "S3", "S4", "S5"] as const,
  trigger: [
    "hide",
    "cover_timeout",
    "own_hold",
    "settlement_changed",
    "own_closing_write",
    "newer_attempt",
  ] as const,
  delivery: [
    "before_newer",
    "during_newer_covering",
    "during_newer_reserved",
    "after_newer_displayed",
  ] as const,
  pageType: ["resumed", "boot"] as const,
};
export type StageTriggerParams = {
  [K in keyof typeof STAGE_TRIGGER_FACTORS]: (typeof STAGE_TRIGGER_FACTORS)[K][number];
};

export async function runStageTrigger(
  params: StageTriggerParams,
  modules: Modules = srcModules,
): Promise<ActivityResult> {
  const fixture = new Fixture({ seed: 17, modules });
  const { world } = fixture;
  const { account, epoch, session, seedToken } = await bootstrapSettled(
    fixture,
    { fences: "none" },
  );
  const n = fixture.addPage();
  seedToken(n);
  const z = fixture.addPage();
  seedToken(z);
  await fixture.boot(z);
  if (params.pageType === "resumed") {
    await fixture.boot(n);
    n.hide();
    await world.runUntilIdle();
  }
  const isN = (m: EventMeta) => m.page === n.id;
  const label = "cover:exposure";
  // The older attempt is the FIRST exposure cover of the page, the newer one the SECOND: identity by order of appearance.
  const seen = new Map<string, number>();
  const ordinal = (key: string): number => {
    if (!seen.has(key)) seen.set(key, seen.size + 1);
    return seen.get(key) as number;
  };
  const older = (key: string) => ordinal(key) === 1;
  const newer = (key: string) => ordinal(key) === 2;
  const lockKey = (m: EventMeta) => `lock:${String(m.name)}`;
  const txKey = (m: EventMeta) => `tx:${String(m.tx)}`;
  const taskKey = (m: EventMeta) => `task:${String(m.task)}`;
  const leaseLock = (m: EventMeta) =>
    isN(m) && String(m.name ?? "").startsWith("atlas-lease-");
  const exposureTx = (m: EventMeta) => isN(m) && m.label === label;

  // The stage of the OLDER attempt when the trigger fires.
  if (params.stage === "S1")
    world.setKnob(
      "lock_grant",
      "unbounded",
      (m) =>
        leaseLock(m) && older(lockKey(m)) && !String(m.name).includes("issue"),
    );
  else if (params.stage === "S2")
    world.setKnob(
      "store_start",
      "unbounded",
      (m) => m.txPage === n.id && m.label === label && older(txKey(m)),
    );
  else if (params.stage === "S3")
    world.setKnob("D0", "unbounded", (m) => exposureTx(m) && older(txKey(m)));
  else if (params.stage === "S5")
    world.setKnob("D3", "unbounded", (m) => isN(m) && older(taskKey(m)));
  // The state of the NEWER attempt while the older completion is delivered.
  if (params.delivery === "during_newer_covering")
    world.setKnob("D0", "unbounded", (m) => exposureTx(m) && newer(txKey(m)));
  if (params.delivery === "during_newer_reserved")
    world.setKnob(
      "D3",
      "unbounded",
      (m) =>
        isN(m) &&
        (params.stage === "S5" ? newer(taskKey(m)) : older(taskKey(m))),
    );
  let zRequest: Promise<unknown> | null = null;
  if (params.stage === "S4") {
    holdAnswers(fixture, (r) => r.page === z.id && r.path.endsWith("/probe"));
    zRequest = z.session.api
      .fetchFor(
        "ordinary",
        account,
        epoch,
      )(new Request("http://localhost/api/experimental/v1/probe"))
      .catch(() => undefined);
    await world.runUntilIdle();
  }
  // The older attempt starts.
  if (params.pageType === "resumed") n.show();
  else void n.session.start();
  await world.runUntilIdle();
  // The trigger.
  switch (params.trigger) {
    case "hide":
    case "newer_attempt":
      n.hide();
      break;
    case "cover_timeout":
      await world.advance(5000);
      break;
    case "own_hold": {
      const k = n.kernel;
      k.memory.addHold(account, "test-hold");
      k.memory.exposure?.cancel("hold");
      k.memory.releaseHold(account, "test-hold");
      break;
    }
    case "settlement_changed": {
      const st = fixture.store.records.auth_state;
      st.settled = st.settled
        ? { ...st.settled, epoch: st.settled.epoch + 1 }
        : st.settled;
      st.latest_epoch += 1;
      n.kernel.memory.settled = null;
      n.kernel.memory.exposure?.cancel("settlement_changed");
      break;
    }
    case "own_closing_write": {
      const { beginClosing, endClosing } = modules.expose;
      beginClosing(n.kernel);
      endClosing(n.kernel);
      break;
    }
  }
  const releaseOlder = () => {
    world.release("lock_grant", (m) => leaseLock(m) && older(lockKey(m)));
    world.release(
      "store_start",
      (m) => m.txPage === n.id && m.label === label && older(txKey(m)),
    );
    world.release("D0", (m) => exposureTx(m) && older(txKey(m)));
    world.release("D3", (m) => isN(m) && older(taskKey(m)));
  };
  const releaseNewer = () => {
    world.release("D0", (m) => exposureTx(m) && newer(txKey(m)));
    world.release("D3", (m) => isN(m) && newer(taskKey(m)));
  };
  if (params.delivery === "before_newer") {
    releaseOlder();
    await world.runUntilIdle();
  }
  // The newer attempt starts (a page that hid becomes visible again; otherwise the state is re-evaluated).
  if (n.env.visible === false) n.show();
  else void n.session.actions.retry();
  await world.runUntilIdle();
  if (
    params.delivery === "during_newer_covering" ||
    params.delivery === "during_newer_reserved"
  ) {
    // The newer attempt is held at COVERING (its completion) or RESERVED (its act); now the older completion arrives.
    releaseOlder();
    await world.runUntilIdle();
  }
  releaseNewer();
  await world.runUntilIdle();
  if (params.delivery === "after_newer_displayed") {
    releaseOlder();
    await world.runUntilIdle();
  }
  world.release();
  world.clearKnobs();
  await world.runUntilIdle();
  await world.advance(70_000);
  await world.runUntilIdle();
  await zRequest;
  void session;

  const violations = [
    ...checkProperties(fixture, { invalidating: [401] }),
    ...checkNoActByCancelled(fixture),
    ...checkExclusiveActivity(fixture),
    ...checkQuiescence(fixture),
  ];
  return {
    params,
    violations,
    stats: {
      issuedB: false,
      detected: false,
      acted: world.logs.filter((e) => e.type === "surface.attach").length,
    },
  };
}
