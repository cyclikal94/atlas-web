import { createRef, type ReactNode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ProtectedProviders } from "../../../src/app/providers";
import { NeutralLiveRegion } from "../../../src/components/ui/announcer";
import { Dialog } from "../../../src/components/ui/dialog";
import { createGateDialog } from "../../../src/components/ui/gate-dialog";
import { commitSync } from "../../../src/components/ui/sync-commit";
import { SyncStatusProvider } from "../../../src/components/ui/sync-status";
import { RecoveryBanner } from "../../../src/lib/form-recovery/RecoveryBanner";
import { pageFormRegistry } from "../../../src/lib/form-recovery/registry";
import {
  type AppUpdatesActions,
  appUpdates,
  type UpdateState,
} from "../../../src/lib/pwa/store";
import {
  AppUpdateBanner,
  NeutralUpdateBanner,
} from "../../../src/lib/pwa/UpdateBanner";
import { createProtectedSurface } from "../../../src/session/adapters/protected-surface";
import type { AccountId, Epoch } from "../../../src/session/model/types";

/**
 * TEST HARNESS (WEB-14a revision 20, R26/R27; design assessment Q1/Q3, S1-S18/S30), served by `fixture.update-focus-gate.spec.ts` from its
 * own Vite dev server: the REAL protected-surface adapter (the production `attachTree`/`applyLevel0`/`unmountTree`, its synchronous commit,
 * `inert` and the modal resume gate) over a small shell with the real update banners, the restored RecoveryBanner and an app `Dialog`, so a
 * native engine decides whether focus is possible. It lives under tests/, not src/: like the unit tests, it drives the adapter directly,
 * which src/ may do only through `act` (tests/session/boundary.test.ts, F-BND-4/F-BND-5). The update states are published directly and
 * the coordinator's actions are only counted: this proves the Q4 focus transitions across the gate, not a save, a reload or a backend
 * journey (those are `fixture.pwa-forms.spec.ts`'s, including its real-kernel gate case). A form's hold is modelled by its `inert`
 * attribute, which is what the real hold sets. React runs in development mode here (StrictMode replays every effect).
 */
export interface FocusProbe {
  /** Gate, optionally publish, then the adapter's first attach (account `a`). */
  mount(options: { restored?: boolean; before?: UpdateState }): void;
  publish(state: UpdateState): void;
  /** The session's level-0 step (saving the focused keyed control first, as `hidden` does). */
  gate(): void;
  /** `act`'s attach of `account` (same account: a lift of the existing tree). */
  attach(account?: string): void;
  /** The adapter's unmount: nothing protected remains; the gate dialog closes over the neutral root. */
  unmount(): void;
  /** The neutral root's banner (shown while no account is displayed). */
  neutral(shown: boolean): void;
  /** An app dialog in the shell. */
  dialog(open: boolean): void;
  /** The form's hold (`inert`). */
  hold(held: boolean): void;
  restored(shown: boolean): void;
  calls(): Record<keyof AppUpdatesActions, number>;
  /** Every `focus()` call: its target and whether it became the active element. */
  trace(): Array<{
    target: string;
    active: boolean;
    inert: boolean;
    modal: boolean;
  }>;
}

const calls: Record<keyof AppUpdatesActions, number> = {
  accept: 0,
  retrySave: 0,
  discardAndReload: 0,
  reloadAnyway: 0,
  notNow: 0,
};
const count = (name: keyof AppUpdatesActions) => () => {
  calls[name] += 1;
};
const actions: AppUpdatesActions = {
  accept: count("accept"),
  retrySave: count("retrySave"),
  discardAndReload: count("discardAndReload"),
  reloadAnyway: count("reloadAnyway"),
  notNow: count("notNow"),
};

const trace: ReturnType<FocusProbe["trace"]> = [];
const native = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function (this: HTMLElement, ...args) {
  native.apply(this, args);
  trace.push({
    target:
      this.getAttribute("aria-label") ??
      this.textContent?.trim() ??
      this.tagName,
    active: document.activeElement === this,
    inert: this.closest("[inert]") !== null,
    modal: document.querySelector("dialog[open]") !== null,
  });
};

let flags = { restored: false, dialog: false };
const listeners = new Set<() => void>();
const setFlags = (next: Partial<typeof flags>) =>
  commitSync(() => {
    flags = { ...flags, ...next };
    for (const listener of listeners) listener();
  });
const useFlags = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => flags,
  );

const first = createRef<HTMLInputElement>();

function Shell() {
  const { restored, dialog } = useFlags();
  return (
    <main id="main" className="flex max-w-[760px] flex-col gap-4 p-6">
      <h1 data-page-heading="" tabIndex={-1}>
        Today
      </h1>
      <button type="button" data-focus-key="probe-opener">
        Opener
      </button>
      <AppUpdateBanner />
      {restored && (
        <RecoveryBanner
          state={{ kind: "restored", onDiscard: () => {} }}
          firstFieldRef={first}
        />
      )}
      <form aria-label="Note" data-probe-form="">
        <input ref={first} aria-label="Title" defaultValue="Unfinished" />
      </form>
      <Dialog open={dialog} onClose={() => {}} title="Edit thing">
        <input aria-label="Name" />
      </Dialog>
    </main>
  );
}

const tree = (): ReactNode => (
  <ProtectedProviders>
    <SyncStatusProvider
      value={{
        model: { phase: "synced", pendingCount: 0, conflictCount: 0 },
        onOpen: () => {},
      }}
    >
      <Shell />
    </SyncStatusProvider>
  </ProtectedProviders>
);

const surface = createProtectedSurface({
  renderTree: tree,
  gateDialog: createGateDialog(),
  liveRegions: { clearAll() {}, announce() {} },
});
const account = (id: string) => id as AccountId;
const epoch = 1 as Epoch;

const neutralRoot = document.getElementById("neutral-root") as HTMLElement;
neutralRoot.replaceChildren();
const neutral = createRoot(neutralRoot);

// An open, unfinished form: the "available" state is Q4's state 1.
pageFormRegistry.register({
  formContext: "fixture-focus-probe",
  isDirty: () => true,
  flush: async () => "saved",
});
const publish = (state: UpdateState) =>
  commitSync(() => appUpdates.set(state, actions));

const probe: FocusProbe = {
  mount({ restored = false, before }) {
    flags = { ...flags, restored };
    surface.applyLevel0();
    if (before) publish(before);
    surface.attachTree(account("a"), epoch);
  },
  publish,
  gate() {
    surface.saveFocusAndScroll(account("a"), epoch);
    surface.applyLevel0();
  },
  attach(id = "a") {
    surface.attachTree(account(id), epoch);
  },
  unmount: () => surface.unmountTree(),
  neutral(shown) {
    commitSync(() =>
      neutral.render(
        shown ? (
          <>
            <NeutralLiveRegion />
            <NeutralUpdateBanner />
          </>
        ) : null,
      ),
    );
  },
  dialog: (open) => setFlags({ dialog: open }),
  hold(held) {
    const form = document.querySelector("[data-probe-form]");
    if (held) form?.setAttribute("inert", "");
    else form?.removeAttribute("inert");
  },
  restored: (shown) => setFlags({ restored: shown }),
  calls: () => ({ ...calls }),
  trace: () => trace,
};

(window as unknown as { __focusProbe: FocusProbe }).__focusProbe = probe;
