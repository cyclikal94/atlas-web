import { RouterProvider } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { ProtectedProviders } from "../app/providers";
import { createAppRouter } from "../app/router";
import { ShellEnvProvider } from "../app/shell/env";
import type { ChipDestination, SyncStatusModel } from "../lib/sync-chip";
import {
  getProtectedRoot,
  liftGate,
  mountProtectedTree,
} from "../protected-surface/gate";
import { ControlsGallery } from "./ControlsGallery";
import "../styles/index.css";

/**
 * FIXTURE ONLY. Renders the shell inside #protected-root with the gate lifted and a sync model taken from the query
 * string, so browser tests can drive every state. It is not the product and is never packaged: the production build
 * has one input (index.html), and scripts/check-no-fixture.mjs fails any artefact that contains the marker below.
 * A passing fixture test is not integration evidence.
 */
export const ATLAS_FIXTURE_ONLY = "ATLAS_FIXTURE_ONLY";

const params = new URLSearchParams(location.search);
const phases = ["offline", "resyncing", "interrupted", "synced"] as const;
const phase =
  phases.find((candidate) => candidate === params.get("phase")) ?? "synced";
let model: SyncStatusModel = {
  phase,
  pendingCount: Number(params.get("pending") ?? 0),
  conflictCount: Number(params.get("conflicts") ?? 0),
  lastSyncedAt: params.get("synced") ?? undefined,
};
const listeners = new Set<() => void>();
const store = {
  get: () => model,
  set(next: SyncStatusModel) {
    model = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

declare global {
  interface Window {
    __atlasFixture?: {
      setSync(next: SyncStatusModel): void;
      opened: ChipDestination[];
    };
  }
}
const opened: ChipDestination[] = [];
window.__atlasFixture = { setSync: store.set, opened };
document.documentElement.dataset.atlasFixture = ATLAS_FIXTURE_ONLY;

const router = createAppRouter();

function FixtureApp() {
  const syncModel = useSyncExternalStore(store.subscribe, store.get);
  return (
    <ShellEnvProvider
      value={{
        syncModel,
        onOpenSync: (destination) => {
          opened.push(destination);
        },
        // On the icon rail there is room for one 44px control: a compact form with its own accessible name.
        accountSlot: ({ collapsed }) =>
          collapsed ? (
            <div
              role="img"
              aria-label="Fixture account"
              className="flex size-11 items-center justify-center rounded-nav text-[13px] font-semibold text-ink-2"
            >
              F
            </div>
          ) : (
            <div className="px-2.5 py-2 text-[13px] text-ink-2">
              Fixture account
            </div>
          ),
      }}
    >
      <RouterProvider router={router} />
    </ShellEnvProvider>
  );
}

const root = getProtectedRoot();
// The real lifecycle (WEB-08a) decides when the boot gate goes; the fixture clears it and lifts the gate at once.
document.getElementById("neutral-root")?.replaceChildren();
liftGate(root);
mountProtectedTree(
  root,
  <ProtectedProviders>
    {location.pathname === "/__controls" ? <ControlsGallery /> : <FixtureApp />}
  </ProtectedProviders>,
);
