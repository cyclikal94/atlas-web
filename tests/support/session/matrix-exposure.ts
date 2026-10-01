import { type FakePage, Fixture } from "./harness";
import { type Modules, srcModules } from "./modules";
import {
  checkExclusiveActivity,
  checkProperties,
  checkQuiescence,
} from "./properties";
import { logoutEnvelope, operation } from "./records";

/**
 * Check 12 (plan 13.4): P1 to P7 and P5-A to P5-J. The parameter set is the product
 *   D0 on each of the two covers x D1 x D2 x D3 x Da x creation order x recording outcome D4 x the other page's
 *   request class x page type,
 * that is 3^2 x 3^4 x 2 x 3 x 4 x 3 = 52 488 scenarios, each run to quiescence and evaluated against V1 to V5, W1 to
 * W3 and P-A to P-G on the logs. Deterministic given the parameters.
 */
export type Delay = 0 | 10 | "unbounded";
export const DELAYS: readonly Delay[] = [0, 10, "unbounded"];
export const EXPOSURE_FACTORS = {
  d0N: DELAYS,
  d0L: DELAYS,
  d1: DELAYS,
  d2: DELAYS,
  d3: DELAYS,
  da: DELAYS,
  order: ["N_first", "L_first"] as const,
  d4: ["abort", "pending", "commit"] as const,
  klass: ["ordinary", "verification", "operation", "recovery"] as const,
  pageType: ["cold_offline", "resumed", "draining"] as const,
};
export type ExposureParams = {
  [K in keyof typeof EXPOSURE_FACTORS]: (typeof EXPOSURE_FACTORS)[K][number];
};
export const EXPOSURE_SCENARIO_COUNT = 3 ** 2 * 3 ** 4 * 2 * 3 * 4 * 3;

export interface ScenarioResult {
  params: unknown;
  violations: string[];
  stats: {
    nActed: boolean;
    nActedBeforeDetection: boolean;
    detected: boolean;
    issued: number;
  };
}

const L_ID = "p1";
const N_ID = "p2";

/** Test-only variations of the platform that the mutation tests use (a lying lock, a boundary that ignores holds). */
export type FixtureFactory = Modules;

export async function bootstrapSettled(
  fixture: Fixture,
  options: { epoch?: number; fences?: "none" | "operation" | "recovery" } = {},
) {
  const account = fixture.server.addAccount("kieran", "pw");
  const session = fixture.server.createSession(account.id, "dev-1");
  fixture.server.adoptCookie(session);
  const epoch = options.epoch ?? (options.fences === "recovery" ? 2 : 1);
  const state = fixture.store.records.auth_state;
  state.latest_epoch = epoch;
  state.settled = {
    account_id: account.id,
    epoch,
    settled_at: "2026-09-30T12:00:00.000Z",
    session_id: session.id,
  };
  if (options.fences === "operation") {
    const envelope = logoutEnvelope("op-1", account.id, epoch, session.id);
    state.fences[account.id] = [operation(1, envelope)];
    state.fence_seq = 1;
  } else if (options.fences === "recovery") {
    state.fences[account.id] = [
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
  const seedToken = (page: FakePage) =>
    page.kernel.memory.csrf.set(
      page.kernel.memory.csrfKey(account.id, epoch),
      `csrf.${session.id}`,
    );
  return { account: account.id, epoch, session, seedToken };
}

export async function runExposure(
  params: ExposureParams,
  modules: Modules = srcModules,
): Promise<ScenarioResult> {
  const { readIdentity } = modules.identity;
  const { handleOperationAnswer, requestFromEnvelope } = modules.operations;
  const { send } = modules.send;
  const fixture = new Fixture({ seed: 7, modules });
  // The fences of the operation and recovery controls are written AFTER the pages boot, so no page's own driver
  // completes the operation during set-up.
  const { account, epoch, session, seedToken } = await bootstrapSettled(
    fixture,
    {
      epoch: params.klass === "recovery" ? 2 : 1,
      fences: "none",
    },
  );
  const { world } = fixture;
  const l = fixture.addPage();
  seedToken(l);
  await fixture.boot(l);
  let n: FakePage | null = null;
  if (params.pageType !== "cold_offline") {
    n = fixture.addPage();
    seedToken(n);
    await fixture.boot(n);
    if (params.pageType === "resumed") n.hide();
  }
  await world.runUntilIdle();
  if (params.klass === "operation" || params.klass === "recovery") {
    const state = fixture.store.records.auth_state;
    state.fences[account] =
      params.klass === "operation"
        ? [operation(1, logoutEnvelope("op-1", account, epoch, session.id))]
        : [
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
  // The scenario begins: knobs, the fault, the server's answer.
  const setKnob = (
    kind: Parameters<typeof world.setKnob>[0],
    value: Delay,
    match?: Parameters<typeof world.setKnob>[2],
  ) => {
    if (value !== 0) world.setKnob(kind, value, match);
  };
  setKnob(
    "D0",
    params.d0L,
    (m) => m.page === L_ID && m.label === `cover:${params.klass}`,
  );
  setKnob(
    "D0",
    params.d0N,
    (m) =>
      m.page === N_ID &&
      (m.label === "cover:exposure" || m.label === "cover:ordinary"),
  );
  setKnob("D1", params.d1);
  setKnob("D2", params.d2);
  setKnob("D3", params.d3, (m) => m.page === N_ID);
  setKnob("Da", params.da, (m) => m.page === L_ID);
  if (params.d4 !== "commit")
    fixture.store.inject({
      match: (tx) => tx.page === L_ID && tx.label === "record",
      mode: params.d4 === "abort" ? "abort" : "pending",
    });
  fixture.server.revoke(session.id); // L's answer will be a 401: a detection

  const startL = () => {
    if (params.klass === "ordinary")
      void l.session.api
        .fetchFor(
          "ordinary",
          account,
          epoch,
        )(new Request("http://localhost/api/experimental/v1/probe"))
        .catch(() => undefined);
    else if (params.klass === "recovery")
      void l.session.api
        .fetchFor(
          "recovery",
          account,
          epoch,
        )(new Request("http://localhost/api/experimental/v1/sync"))
        .catch(() => undefined);
    else if (params.klass === "verification")
      void readIdentity(l.kernel, account, epoch, {
        kind: "general",
        expectClear: false,
      }).catch(() => undefined);
    else {
      const envelope = logoutEnvelope("op-1", account, epoch, session.id);
      void send(l.kernel, {
        klass: "operation",
        account,
        epoch,
        request: requestFromEnvelope(envelope),
        operationId: "op-1",
        selfRevoking: "logout",
        onAnswer: (k, inflight, response) =>
          handleOperationAnswer(k, inflight, response, envelope),
      }).catch(() => undefined);
    }
  };
  const startN = () => {
    if (params.pageType === "cold_offline") {
      n = fixture.addPage();
      n.goOffline();
      seedToken(n);
      void n.session.start();
    } else if (params.pageType === "resumed" && n) {
      n.show();
    } else if (n) {
      const page = n;
      void (async () => {
        for (let i = 0; i < 3; i += 1)
          await page.session.api
            .fetchFor(
              "ordinary",
              account,
              epoch,
            )(new Request("http://localhost/api/experimental/v1/probe"))
            .catch(() => undefined);
      })();
    }
  };
  if (params.order === "L_first") {
    startL();
    startN();
  } else {
    startN();
    startL();
  }
  await world.runUntilIdle();
  world.release();
  world.clearKnobs();
  await world.runUntilIdle();
  await world.advance(70_000); // past the longest back-off, so every retry loop has run
  await world.runUntilIdle();

  const violations = [
    ...checkProperties(fixture, { invalidating: [401] }),
    ...checkExclusiveActivity(fixture),
    ...checkQuiescence(fixture),
  ];
  const surrender = world.logs.find(
    (e) => e.type === "trace.surrender" && e.status === 401,
  );
  const acts = world.logs.filter(
    (e) => e.type === "surface.attach" && e.page === N_ID,
  );
  return {
    params,
    violations,
    stats: {
      nActed: acts.length > 0,
      nActedBeforeDetection:
        !!surrender && acts.some((a) => a.seq < (surrender?.seq ?? 0)),
      detected: !!surrender,
      issued: world.logs.filter((e) => e.type === "trace.request.issued")
        .length,
    },
  };
}
