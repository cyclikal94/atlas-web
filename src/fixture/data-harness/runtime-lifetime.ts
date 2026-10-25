/** FIXTURE ONLY: observe runtime ownership without replacing promises or changing disposal. */
export interface ObservedService {
  readonly live: boolean;
  readonly ended: boolean;
}

export interface ObservedRuntime {
  serviceFor(account: string): ObservedService | null;
  open(
    account: string,
    options?: { create?: boolean },
  ): Promise<{
    kind: string;
    reason?: string;
    service?: ObservedService;
  }>;
  dispose(): void;
}

export interface RuntimeOpenObservation {
  operation: number;
  runtime: number;
  account: string;
  create: boolean;
  requested: number;
  requestedOrder: number;
  answered: number | null;
  answeredOrder: number | null;
  outcome: string | null;
  service: number | null;
  liveAtAnswer: boolean | null;
  installedAtAnswer: boolean | null;
}

export interface RuntimeDisposalObservation {
  runtime: number;
  account: string;
  at: number;
  order: number;
  stack: string;
  service: number | null;
  live: boolean;
  pending: number[];
  closesBefore: number;
  closesAfter: number | null;
}

export interface RuntimeLifetime {
  installed: true;
  account: string;
  opens: RuntimeOpenObservation[];
  disposals: RuntimeDisposalObservation[];
}

/**
 * One observer per page/prototype; watching an account twice is idempotent. `read` refuses missing installation.
 * A service is sampled synchronously BEFORE the original terminal disposal. Promise delivery is a separate event:
 * a completed promise can be delivered after its installed service was disposed, and is never the ownership oracle.
 */
export function createRuntimeLifetimeObserver(
  prototype: ObservedRuntime,
  closureCount: (account: string) => number,
  clock: () => number = () => performance.now(),
) {
  const accounts = new Set<string>();
  const ids = new WeakMap<object, number>();
  const opens: RuntimeOpenObservation[] = [];
  const disposals: RuntimeDisposalObservation[] = [];
  let nextId = 0;
  let order = 0;
  let installed = false;
  const originalOpen = prototype.open;
  const originalDispose = prototype.dispose;
  const idOf = (object: object): number => {
    let id = ids.get(object);
    if (id === undefined) {
      id = ++nextId;
      ids.set(object, id);
    }
    return id;
  };

  function observedOpen(
    this: ObservedRuntime,
    account: string,
    options?: { create?: boolean },
  ): ReturnType<ObservedRuntime["open"]> {
    if (!accounts.has(account))
      return originalOpen.call(this, account, options);
    const entry: RuntimeOpenObservation = {
      operation: ++nextId,
      runtime: idOf(this),
      account,
      create: options?.create === true,
      requested: clock(),
      requestedOrder: ++order,
      answered: null,
      answeredOrder: null,
      outcome: null,
      service: null,
      liveAtAnswer: null,
      installedAtAnswer: null,
    };
    opens.push(entry);
    const answer = originalOpen.call(this, account, options);
    void answer.then(
      (outcome) => {
        entry.answered = clock();
        entry.answeredOrder = ++order;
        entry.outcome =
          outcome.kind === "refused"
            ? `refused:${outcome.reason}`
            : outcome.kind;
        entry.service =
          outcome.service === undefined ? null : idOf(outcome.service);
        entry.liveAtAnswer = outcome.service?.live ?? null;
        entry.installedAtAnswer =
          outcome.service === undefined
            ? null
            : this.serviceFor(account) === outcome.service;
      },
      () => {
        entry.answered = clock();
        entry.answeredOrder = ++order;
        entry.outcome = "threw";
      },
    );
    return answer;
  }

  function observedDispose(this: ObservedRuntime): void {
    const runtime = idOf(this);
    const stack = new Error().stack ?? "";
    const entries = [...accounts].map((account) => {
      const service = this.serviceFor(account);
      const entry: RuntimeDisposalObservation = {
        runtime,
        account,
        at: clock(),
        order: ++order,
        stack,
        service: service === null ? null : idOf(service),
        live: service?.live === true,
        pending: opens
          .filter(
            (open) =>
              open.runtime === runtime &&
              open.account === account &&
              open.answered === null,
          )
          .map((open) => open.operation),
        closesBefore: closureCount(account),
        closesAfter: null,
      };
      disposals.push(entry);
      return entry;
    });
    try {
      originalDispose.call(this);
    } finally {
      for (const entry of entries)
        entry.closesAfter = closureCount(entry.account);
    }
  }

  return {
    watch(account: string): void {
      if (!installed) {
        prototype.open = observedOpen;
        prototype.dispose = observedDispose;
        installed = true;
      }
      accounts.add(account);
    },
    read(account: string): RuntimeLifetime {
      if (!installed || !accounts.has(account))
        throw new Error(
          `runtime lifetime recorder not installed for ${account}`,
        );
      if (
        prototype.open !== observedOpen ||
        prototype.dispose !== observedDispose
      )
        throw new Error("runtime lifetime recorder was replaced");
      return {
        installed: true,
        account,
        opens: opens
          .filter((entry) => entry.account === account)
          .map((entry) => ({ ...entry })),
        disposals: disposals
          .filter((entry) => entry.account === account)
          .map((entry) => ({ ...entry, pending: [...entry.pending] })),
      };
    },
  };
}
