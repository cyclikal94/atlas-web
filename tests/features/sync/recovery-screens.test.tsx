import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DataEnvProvider } from "../../../src/data";
import * as copy from "../../../src/features/sync/copy";
import { ItemDetailDialog } from "../../../src/features/sync/ItemDetailDialog";
import { NoticeList } from "../../../src/features/sync/NoticeBanners";
import { QueuePanel } from "../../../src/features/sync/QueuePanel";
import { SessionProvider } from "../../../src/session";
import { UiProviders } from "../../helpers/providers";
import { cacheRow, draftRow } from "../../support/data/rows";
import { type StubEnv, stubEnv } from "../../support/data/ui-env";

/**
 * U-1 to U-8 (WEB-09b): the Q24 notices with a single Acknowledge that only dismisses (`sync-recovery-acknowledge.html`, verbatim),
 * the blocking budget state with Reload and Try again, the conflict inbox's non-actionable "Resyncing automatically" banner (tablet
 * amendment), and the generic WF-QUEUE-02 dialog, which offers only what the store or a registered rebuild can do. jsdom and axe; the
 * data layer is the stub controller. Copy not quoted from a wireframe is PROPOSED, not accepted.
 */
afterEach(cleanup);

const reload = vi.fn();
const session = { actions: { reload } } as never;
const mount = (env: StubEnv, node: ReactNode) =>
  render(
    <SessionProvider session={session}>
      <UiProviders>
        <DataEnvProvider env={env}>{node}</DataEnvProvider>
      </UiProviders>
    </SessionProvider>,
  );
const job = (state: object) => ({
  registered: true,
  active: false,
  state: state as never,
});

describe("U-1/U-2 the Q24 notice: automatic restart, a single Acknowledge", () => {
  for (const [reason, title, body] of [
    ["resync_required", copy.RESYNC_REQUIRED_TITLE, copy.RESYNC_REQUIRED_BODY],
    ["access_changed", copy.ACCESS_CHANGED_TITLE, copy.ACCESS_CHANGED_BODY],
  ] as const)
    test(`${reason}: the wireframe's copy, ONE button, and it only dismisses`, async () => {
      const env = stubEnv({
        inputs: {
          recovery: {
            registered: true,
            active: true,
            notice: { reason, id: `7:${reason}` },
          },
        },
      });
      const { container } = mount(env, <NoticeList />);
      const banner = container.querySelector(
        `[data-notice="resync_${reason}"]`,
      ) as HTMLElement;
      expect(
        within(banner).getByRole("heading", { level: 2 }),
      ).toHaveTextContent(title);
      expect(banner).toHaveTextContent(body);
      const buttons = within(banner).getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual([
        copy.RESYNC_ACKNOWLEDGE,
      ]);
      expect(banner.textContent).not.toMatch(
        /start the fresh copy|start again/i,
      );
      expect((await axe(container)).violations).toEqual([]);
      fireEvent.click(buttons[0] as HTMLElement);
      expect(env.calls).toEqual([
        { action: "acknowledgeResync", args: [`7:${reason}`] },
      ]);
      expect(
        container.querySelector(`[data-notice="resync_${reason}"]`),
      ).toBeNull();
    });
});

describe("U-3 the blocking state of the recovery budgets", () => {
  test("the design's wording, Reload (the session's) and Try again (the job's retry); no automatic retry is claimed", async () => {
    for (const inputs of [
      {
        recovery: job({
          kind: "stopped",
          cause: "sync_blocked",
          blocked: "attempts",
        }),
      },
      { recoveryBlocked: true },
    ]) {
      reload.mockClear();
      const env = stubEnv({ inputs });
      const { container } = mount(env, <NoticeList />);
      const banner = container.querySelector(
        '[data-notice="sync_blocked"]',
      ) as HTMLElement;
      expect(
        within(banner).getByRole("heading", { level: 2 }),
      ).toHaveTextContent(copy.SYNC_BLOCKED_TITLE);
      expect(banner.textContent).not.toMatch(/automatically|will retry/i);
      fireEvent.click(
        within(banner).getByRole("button", { name: copy.SYNC_BLOCKED_RETRY }),
      );
      expect(env.calls).toEqual([{ action: "retryUpdates", args: [] }]);
      fireEvent.click(
        within(banner).getByRole("button", { name: copy.SYNC_BLOCKED_RELOAD }),
      );
      expect(reload).toHaveBeenCalledTimes(1);
      expect((await axe(container)).violations).toEqual([]);
      cleanup();
    }
  });

  test("the job's own stops speak through the existing notices (a page that did not save, storage full, still trying)", () => {
    for (const [state, kind] of [
      [{ kind: "stopped", cause: "local_storage" }, "page_not_saved"],
      [{ kind: "stopped", cause: "storage_full" }, "storage_full"],
      [{ kind: "paused", mode: "recovery", since: 0 }, "still_trying_updates"],
    ] as const) {
      const env = stubEnv({
        inputs: { recovery: job(state), cache: "invalid" },
      });
      const { container } = mount(env, <NoticeList />);
      expect(
        container.querySelector(`[data-notice="${kind}"]`),
        kind,
      ).not.toBeNull();
      cleanup();
    }
  });
});

describe("U-4 the conflict inbox while a recovery runs", () => {
  test("a non-actionable 'Resyncing automatically' banner, never a 'Needs a decision' row", async () => {
    const env = stubEnv({
      drafts: [],
      inputs: { recovery: { registered: true, active: true } },
    });
    const { container } = mount(
      env,
      <QueuePanel tab="decision" onTabChange={() => {}} />,
    );
    const banner = container.querySelector(
      '[data-notice="resyncing"]',
    ) as HTMLElement;
    expect(banner).toHaveTextContent(copy.RESYNCING_BANNER_TITLE);
    expect(banner).toHaveTextContent(copy.RESYNCING_BANNER_BODY);
    expect(within(banner).queryAllByRole("button")).toEqual([]);
    expect(
      screen.getByRole("tab", { name: /Needs a decision/ }),
    ).toHaveTextContent("0");
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe("U-5 to U-8 WF-QUEUE-02, the generic item-detail dialog", () => {
  const conflict = (status: "version_conflict" | "operation_conflict") =>
    draftRow({
      local_id: "4e219b0a-0000-4000-8000-000000000001",
      status,
      target_resource_ids: ["r1"],
      created_at: "2026-10-01T08:04:00",
    });
  /**
   * A stub controller whose CACHE holds `cached` for every id, and whose authorised current-state read answers `read`. ADAPTED (R7 of
   * the review of 10 October 2026): these cases originally gave the dialog only a cache (`useCachedResource`) and asserted it as
   * "Currently saved"; the approved amendment requires an authorised CURRENT-STATE read. The cache is still planted (with a different,
   * stale value) so that each case also shows the cache is never what the dialog presents or rebuilds on.
   */
  const withRead = (
    env: StubEnv,
    read: StubEnv["currentRead"],
    cached: ReturnType<typeof cacheRow> | null = cacheRow({
      id: "r1",
      label: "STALE cached value",
      version: 1,
    }),
  ) => {
    const snapshot = {
      status: "ready",
      value: {
        base: cached,
        effects: [],
        creates: [],
        createsTotal: 0,
        createsNext: null,
        merged: cached,
      },
    };
    const watchable = { get: () => snapshot, subscribe: () => () => undefined };
    const service = {
      account: "a",
      incarnationId: "i",
      live: true,
      store: { watch: () => watchable },
    };
    Object.assign(env, {
      service: () => service,
      serviceStore: { get: () => service, subscribe: () => () => undefined },
      currentRead: read,
    });
    return env;
  };
  const loaded = (row: ReturnType<typeof cacheRow>) =>
    ({ kind: "loaded", value: row }) as const;

  test("U-5 a version conflict: the CURRENT saved state (the authorised read, not the cache) beside the retained change; Discard mine asks first; no resend without a registered rebuild", async () => {
    const env = withRead(
      stubEnv(),
      loaded(cacheRow({ id: "r1", label: "Fed at 08:02", version: 4 })),
    );
    const onClose = vi.fn();
    mount(
      env,
      <ItemDetailDialog
        draft={conflict("version_conflict")}
        title="Feed cat"
        variant="version_conflict"
        open
        onClose={onClose}
        onRemoved={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(copy.DETAIL_VERSION_TITLE),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(copy.DETAIL_VERSION_BODY);
    const current = dialog.querySelector(
      '[data-compare="current"]',
    ) as HTMLElement;
    await waitFor(() => expect(current).toHaveTextContent("Fed at 08:02"));
    expect(current).toHaveTextContent(copy.DETAIL_VERSION(4));
    expect(current).not.toHaveTextContent("STALE cached value");
    expect(env.reads).toEqual([conflict("version_conflict").local_id]);
    expect(dialog.querySelector('[data-compare="retained"]')).toHaveTextContent(
      "Feed cat",
    );
    expect(
      within(dialog).queryByRole("button", { name: copy.DETAIL_RESEND }),
    ).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: copy.DETAIL_DISCARD_MINE }),
    );
    expect(env.calls).toEqual([]);
    fireEvent.click(
      within(dialog).getByRole("button", { name: copy.DISCARD_CONFIRM_YES }),
    );
    await waitFor(() =>
      expect(env.calls).toEqual([
        { action: "discard", args: [conflict("version_conflict").local_id] },
      ]),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test("U-6 a registered rebuild offers 'Resend as a new operation', which asks the data layer to save it as new ON THE VALUE THE READ RETURNED", async () => {
    const server = cacheRow({ id: "r1", label: "Fed at 08:02", version: 4 });
    const env = withRead(stubEnv(), loaded(server));
    env.commands.register("edit", {
      describe: () => "Feed cat",
      rebuild: () => null,
    });
    mount(
      env,
      <ItemDetailDialog
        draft={conflict("version_conflict")}
        title="Feed cat"
        variant="version_conflict"
        open
        onClose={() => {}}
        onRemoved={() => {}}
      />,
    );
    // The action is disabled while the read loads; it is enabled (a new element) once the read has loaded.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: copy.DETAIL_RESEND }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: copy.DETAIL_RESEND }));
    await waitFor(() =>
      expect(env.calls).toEqual([
        {
          action: "saveAsNew",
          args: [conflict("version_conflict").local_id, server],
        },
      ]),
    );
    // The stub declined: the change is kept and the dialog says so.
    expect(
      await screen.findByText(copy.DETAIL_SAVE_NEW_FAILED),
    ).toBeInTheDocument();
  });

  test("U-7 an operation conflict: the corrected copy and the honest limit; the new attempt waits for the read, or an explicit choice when it fails", async () => {
    const env = withRead(
      stubEnv(),
      loaded(cacheRow({ id: "r1", label: "Fed at 08:02" })),
    );
    env.commands.register("edit", {
      describe: () => "Feed cat",
      rebuild: () => null,
    });
    const { container } = mount(
      env,
      <ItemDetailDialog
        draft={conflict("operation_conflict")}
        title="Feed cat"
        variant="operation_conflict"
        open
        onClose={() => {}}
        onRemoved={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(copy.DETAIL_OPERATION_TITLE),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(copy.DETAIL_OPERATION_BODY);
    await waitFor(() =>
      expect(dialog).toHaveTextContent(copy.DETAIL_OPERATION_LIMIT),
    );
    expect(dialog.textContent).not.toMatch(/already recorded.*sent twice/i);
    expect(
      within(dialog).getByRole("button", { name: copy.DETAIL_SAVE_NEW }),
    ).toBeEnabled();
    expect((await axe(container)).violations).toEqual([]);
    cleanup();
    const failing = withRead(stubEnv(), {
      kind: "failed",
      reason: "inaccessible",
    });
    failing.commands.register("edit", {
      describe: () => "Feed cat",
      rebuild: () => null,
    });
    mount(
      failing,
      <ItemDetailDialog
        draft={conflict("operation_conflict")}
        title="Feed cat"
        variant="operation_conflict"
        open
        onClose={() => {}}
        onRemoved={() => {}}
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-compare="current"]'),
      ).toHaveTextContent(copy.DETAIL_READ_FAILED),
    );
    expect(
      document.querySelector('[data-compare="current"]'),
    ).not.toHaveTextContent("STALE cached value");
    expect(
      screen.getByRole("button", { name: copy.DETAIL_SAVE_NEW }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.DETAIL_DISCARD_ATTEMPT }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: copy.DETAIL_PROCEED_WITHOUT }),
    );
    expect(
      screen.getByRole("button", { name: copy.DETAIL_SAVE_NEW }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: copy.DETAIL_SAVE_NEW }));
    // Continued explicitly without the read: rebuilt on nothing, never on the stale cache.
    await waitFor(() =>
      expect(failing.calls).toEqual([
        {
          action: "saveAsNew",
          args: [conflict("operation_conflict").local_id, null],
        },
      ]),
    );
  });

  test("U-7b R7: while the read loads the new attempt is disabled (both variants); a stale cache never stands in for it", async () => {
    for (const variant of ["operation_conflict", "version_conflict"] as const) {
      const env = withRead(
        stubEnv(),
        () => new Promise<never>(() => undefined),
      );
      env.commands.register("edit", {
        describe: () => "Feed cat",
        rebuild: () => null,
      });
      mount(
        env,
        <ItemDetailDialog
          draft={conflict(variant)}
          title="Feed cat"
          variant={variant}
          open
          onClose={() => {}}
          onRemoved={() => {}}
        />,
      );
      const current = document.querySelector(
        '[data-compare="current"]',
      ) as HTMLElement;
      expect(current.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(current).not.toHaveTextContent("STALE cached value");
      expect(
        screen.getByRole("button", {
          name:
            variant === "operation_conflict"
              ? copy.DETAIL_SAVE_NEW
              : copy.DETAIL_RESEND,
        }),
      ).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: copy.DETAIL_PROCEED_WITHOUT }),
      ).toBeNull();
      cleanup();
    }
  });

  test("U-7c R7: an indeterminate read is shown plainly; the queued attempt is kept, never auto-discarded or resubmitted", async () => {
    const env = withRead(stubEnv(), { kind: "indeterminate" });
    env.commands.register("edit", {
      describe: () => "Feed cat",
      rebuild: () => null,
    });
    mount(
      env,
      <ItemDetailDialog
        draft={conflict("operation_conflict")}
        title="Feed cat"
        variant="operation_conflict"
        open
        onClose={() => {}}
        onRemoved={() => {}}
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-compare="current"]'),
      ).toHaveTextContent(copy.DETAIL_INDETERMINATE),
    );
    expect(env.calls).toEqual([]);
  });

  test("U-8 the online-only variant: nothing to compare or resend (and no read is made); and a failed row of the queue opens the dialog from 'Details'", async () => {
    const env = withRead(stubEnv(), { kind: "failed", reason: "unavailable" });
    const { container } = mount(
      env,
      <ItemDetailDialog
        draft={draftRow({ status: "rejected" })}
        title="Join the rota"
        variant="online_only"
        open
        onClose={() => {}}
        onRemoved={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(copy.DETAIL_ONLINE_ONLY);
    expect(dialog.querySelector("[data-compare]")).toBeNull();
    expect(env.reads).toEqual([]);
    expect((await axe(container)).violations).toEqual([]);
    cleanup();
    const panelEnv = withRead(
      stubEnv({ drafts: [conflict("version_conflict")] }),
      { kind: "indeterminate" },
      null,
    );
    mount(panelEnv, <QueuePanel tab="decision" onTabChange={() => {}} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(`^${copy.DETAIL_ACTION}`),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveTextContent(
        copy.DETAIL_INDETERMINATE,
      ),
    );
  });
});
