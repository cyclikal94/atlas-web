import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import type { TasksResult } from "../../../src/features/tasks/api";
import {
  GRAPH_READ,
  useDependencyGraph,
} from "../../../src/features/tasks/detail/useDependencyGraph";
import { TasksEnvProvider } from "../../../src/features/tasks/env";
import {
  forgetTaskMemory,
  refusalOf,
} from "../../../src/features/tasks/memory";
import type { DependencyGraph } from "../../../src/features/tasks/model/contract";
import {
  buildGraph,
  chainSpec,
  gid,
  sharedSpec,
} from "../../support/tasks/graphs";
import { fakeApi, ME, tasksEnv } from "../../support/tasks/world";

/**
 * WEB-18 (plan §3.5, D-18-5; backend consumer obligations 1–5): ONE view of a day's graph through `useDependencyGraph` with a scripted
 * read whose answers the test releases in any order. FIXTURE evidence.
 */
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});

type Answer = TasksResult<DependencyGraph>;
interface Asked {
  occurrenceId: string;
  maxDepth: number | undefined;
  answer(result: Answer): Promise<void>;
}

/** A read that holds every request until the test answers it. */
function heldApi() {
  const asked: Asked[] = [];
  const api = fakeApi({
    readDependencyGraph: (occurrenceId, maxDepth) =>
      new Promise<Answer>((resolve) => {
        asked.push({
          occurrenceId,
          maxDepth,
          answer: async (result) => {
            await act(async () => {
              resolve(result);
              await new Promise((r) => setTimeout(r, 0));
            });
          },
        });
      }),
  });
  return { api, asked };
}

const chain = buildGraph(chainSpec());
const shared = buildGraph(sharedSpec());
const ok = (graph: DependencyGraph): Answer => ({ ok: true, value: graph });
const ROOT = chain.root_id;

function mount(
  api: ReturnType<typeof fakeApi>,
  initial: {
    root?: string;
    depth?: number;
    active?: boolean;
    settled?: string;
    identity?: string;
    online?: boolean;
  } = {},
) {
  let env = tasksEnv(api, {
    ...(initial.identity ? { identity: initial.identity } : {}),
    online: initial.online ?? true,
  });
  let props = {
    root: initial.root ?? ROOT,
    depth: initial.depth,
    active: initial.active ?? true,
    settled: initial.settled ?? "",
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TasksEnvProvider value={env}>{children}</TasksEnvProvider>
  );
  const hook = renderHook(
    (p: typeof props) =>
      useDependencyGraph(p.root, p.depth, {
        active: p.active,
        settled: p.settled,
      }),
    { wrapper, initialProps: props },
  );
  return {
    hook,
    view: () => hook.result.current.view,
    set(over: Partial<typeof props>, envOver: Partial<typeof env> = {}) {
      props = { ...props, ...over };
      env = { ...env, ...envOver };
      act(() => hook.rerender(props));
    },
  };
}

describe("H-1 ordering: only the answer to the latest request of the view is applied", () => {
  test("an earlier request answered after a later one is dropped (connection lost and back while it was out)", async () => {
    const { api, asked } = heldApi();
    const m = mount(api);
    expect(asked).toHaveLength(1);
    // The connection goes and comes back: a new request while the first is still out.
    m.set({}, { online: false });
    expect(m.view().kind).toBe("offline");
    m.set({}, { online: true });
    expect(asked).toHaveLength(2);
    await asked[1]?.answer(ok(shared));
    expect(m.view()).toMatchObject({ kind: "ready", graph: shared });
    await asked[0]?.answer(ok(chain));
    expect(m.view()).toMatchObject({ kind: "ready", graph: shared });
  });

  test("control: answered in order, the later answer replaces the earlier one whole", async () => {
    const { api, asked } = heldApi();
    const m = mount(api);
    await asked[0]?.answer(ok(chain));
    expect(m.view()).toMatchObject({ kind: "ready", graph: chain });
    act(() => {
      void m.hook.result.current.refresh();
    });
    expect(asked).toHaveLength(2);
    expect(m.view()).toMatchObject({ kind: "ready", checking: true });
    await asked[1]?.answer(ok(shared));
    expect(m.view()).toMatchObject({
      kind: "ready",
      graph: shared,
      checking: false,
    });
  });

  test("an answer for another root is never shown under this one", async () => {
    const { api, asked } = heldApi();
    const m = mount(api);
    m.set({ root: gid(20) });
    expect(asked.map((a) => a.occurrenceId)).toEqual([ROOT, gid(20)]);
    await asked[0]?.answer(ok(chain));
    expect(m.view().kind).toBe("loading");
    await asked[1]?.answer(ok(shared));
    expect(m.view()).toMatchObject({ kind: "ready", graph: shared });
  });
});

describe("H-2 identity", () => {
  test("an answer asked under one identity is dropped when the identity changes, and that identity reads afresh", async () => {
    const { api, asked } = heldApi();
    const m = mount(api);
    m.set({}, { identity: `${ME}:2` });
    expect(m.view().kind).toBe("loading");
    expect(asked).toHaveLength(2);
    await asked[0]?.answer(ok(chain));
    expect(m.view().kind).toBe("loading");
    await asked[1]?.answer(ok(shared));
    expect(m.view()).toMatchObject({ kind: "ready", graph: shared });
  });
});

describe("H-3 offline", () => {
  test("opened offline: nothing is read, and the view says it can be checked online", () => {
    const { api, asked } = heldApi();
    const m = mount(api, { online: false });
    expect(asked).toHaveLength(0);
    expect(m.view().kind).toBe("offline");
  });

  test("going offline drops a shown graph (never a stale snapshot offline); an offline answer drops it too", async () => {
    const { api, asked } = heldApi();
    const m = mount(api);
    await asked[0]?.answer(ok(chain));
    m.set({}, { online: false });
    expect(m.view().kind).toBe("offline");
    m.set({}, { online: true });
    await asked[1]?.answer({ ok: false, kind: "offline" });
    expect(m.view().kind).toBe("offline");
  });
});

describe("H-4 refusal", () => {
  test.each([["not_found"], ["forbidden"]] as const)(
    "%s removes the view and is noted for the identity",
    async (kind) => {
      const { api, asked } = heldApi();
      const m = mount(api);
      await asked[0]?.answer(ok(chain));
      act(() => {
        void m.hook.result.current.refresh();
      });
      await asked[1]?.answer({ ok: false, kind });
      expect(m.view().kind).toBe("refused");
      expect(refusalOf(`${ME}:1`, GRAPH_READ(ROOT, undefined))).toBe(kind);
    },
  );
});

describe("H-5 a failed read", () => {
  test("with nothing shown it is an error, with the request id", async () => {
    const { api, asked } = heldApi();
    const m = mount(api);
    await asked[0]?.answer({
      ok: false,
      kind: "uncertain",
      requestId: "req-9",
    });
    expect(m.view()).toEqual({ kind: "error", requestId: "req-9" });
  });

  test.each([["uncertain"], ["invalid"], ["not_sent"], ["conflict"]] as const)(
    "%s after a shown answer keeps that whole answer as STALE (with its time), never merged",
    async (kind) => {
      const { api, asked } = heldApi();
      const m = mount(api);
      await asked[0]?.answer(ok(chain));
      const at = (m.view() as { at: number }).at;
      act(() => {
        void m.hook.result.current.refresh();
      });
      await asked[1]?.answer({ ok: false, kind } as Answer);
      expect(m.view()).toMatchObject({ kind: "stale", graph: chain, at });
      // A later success replaces it whole.
      act(() => {
        void m.hook.result.current.refresh();
      });
      await asked[2]?.answer(ok(shared));
      expect(m.view()).toMatchObject({ kind: "ready", graph: shared });
    },
  );

  test("a closed session shows nothing it had", async () => {
    const { api, asked } = heldApi();
    const m = mount(api);
    await asked[0]?.answer(ok(chain));
    act(() => {
      void m.hook.result.current.refresh();
    });
    await asked[1]?.answer({ ok: false, kind: "closed" });
    expect(m.view().kind).toBe("error");
  });
});

describe("H-6 triggers and coalescing", () => {
  test("a settlement reads again; triggers during a read queue exactly ONE follow-up, never two in flight", async () => {
    const { api, asked } = heldApi();
    const m = mount(api, { settled: "a" });
    expect(asked).toHaveLength(1);
    m.set({ settled: "b" });
    m.set({ settled: "c" });
    act(() => {
      void m.hook.result.current.refresh();
    });
    expect(asked).toHaveLength(1);
    await asked[0]?.answer(ok(chain));
    // The follow-up is asked once the first is answered.
    expect(asked).toHaveLength(2);
    expect(m.view()).toMatchObject({
      kind: "ready",
      graph: chain,
      checking: true,
    });
    await asked[1]?.answer(ok(shared));
    expect(asked).toHaveLength(2);
    expect(m.view()).toMatchObject({
      kind: "ready",
      graph: shared,
      checking: false,
    });
  });

  test("refresh() resolves once the follow-up it queued is answered", async () => {
    const { api, asked } = heldApi();
    const m = mount(api);
    let done = false;
    act(() => {
      void m.hook.result.current.refresh().then(() => {
        done = true;
      });
    });
    await asked[0]?.answer(ok(chain));
    expect(done).toBe(false);
    await asked[1]?.answer(ok(shared));
    expect(done).toBe(true);
  });

  test("the editor's view asks max_depth 1; another depth is another view", async () => {
    const { api, asked } = heldApi();
    const m = mount(api, { depth: 1 });
    expect(asked[0]?.maxDepth).toBe(1);
    m.set({ depth: undefined });
    expect(asked[1]?.maxDepth).toBeUndefined();
    expect(m.view().kind).toBe("loading");
  });
});

describe("H-7..H-9 shown again", () => {
  test("H-7 the connection returning reads again", async () => {
    const { api, asked } = heldApi();
    const m = mount(api, { online: false });
    m.set({}, { online: true });
    expect(asked).toHaveLength(1);
    await asked[0]?.answer(ok(chain));
    expect(m.view().kind).toBe("ready");
  });

  test("H-8 the document becoming visible reads again", async () => {
    const { api, asked } = heldApi();
    mount(api);
    await asked[0]?.answer(ok(chain));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(asked).toHaveLength(2);
  });

  test("H-9 a BFCache hide drops the snapshot and its restore reads again; an answer asked before the hide is dropped", async () => {
    const { api, asked } = heldApi();
    const m = mount(api);
    await asked[0]?.answer(ok(chain));
    act(() => {
      void m.hook.result.current.refresh();
    });
    act(() => {
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      );
    });
    expect(m.view().kind).toBe("loading");
    await asked[1]?.answer(ok(shared));
    expect(m.view().kind).toBe("loading");
    act(() => {
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
    });
    expect(asked).toHaveLength(3);
    await asked[2]?.answer(ok(shared));
    expect(m.view()).toMatchObject({ kind: "ready", graph: shared });
  });

  test("control: a hide that is not into the BFCache keeps the view", async () => {
    const { api, asked } = heldApi();
    const m = mount(api);
    await asked[0]?.answer(ok(chain));
    act(() => {
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: false }),
      );
    });
    expect(m.view().kind).toBe("ready");
  });
});

describe("H-10 inactive", () => {
  test("inactive reads nothing and shows nothing; becoming inactive drops the view and anything still out", async () => {
    const { api, asked } = heldApi();
    const m = mount(api, { active: false });
    expect(asked).toHaveLength(0);
    expect(m.view().kind).toBe("idle");
    m.set({ active: true });
    expect(asked).toHaveLength(1);
    m.set({ active: false });
    await asked[0]?.answer(ok(chain));
    expect(m.view().kind).toBe("idle");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(asked).toHaveLength(1);
  });
});
