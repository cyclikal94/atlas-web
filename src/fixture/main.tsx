import { RouterProvider } from "@tanstack/react-router";
import { type ReactNode, useSyncExternalStore } from "react";
import { ProtectedProviders } from "../app/providers";
import { createAppRouter } from "../app/router";
import { SessionNotices } from "../app/SessionNotices";
import { ShellEnvProvider } from "../app/shell/env";
import { DataEnvProvider, useSyncStatusModel } from "../data";
import type { ChipDestination, SyncStatusModel } from "../lib/sync-chip";
import {
  getProtectedRoot,
  liftGate,
  mountProtectedTree,
} from "../protected-surface/gate";
import { SessionProvider } from "../session";
import { type FixtureData, fixtureData } from "./data-env";
import { FixturePageReady } from "./page-ready";
import { fixtureSession } from "./session-double";
import type { SessionHarness } from "./session-harness/main";
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
      /** The sync screens' data double (query-driven): `?state=`, `?drafts=N`, ... See `data-env.ts`. */
      data?: FixtureData;
      /** Present only on the `/__session` harness page (src/fixture/session-harness). */
      session?: SessionHarness;
    };
  }
}
const opened: ChipDestination[] = [];
// The sync screens (`/sync`, the banners, the cache gate) read a data env; the fixture's is a double driven by the query string.
const data = fixtureData(params);
window.__atlasFixture = { setSync: store.set, opened, data };
document.documentElement.dataset.atlasFixture = ATLAS_FIXTURE_ONLY;

const router = createAppRouter();
const session = fixtureSession(params);
/** The sync screens' data double drives the chip when the page asks for one of its states. */
const usesData =
  [
    "state",
    "drafts",
    "paused",
    "decisions",
    "rejected",
    "confirming",
    "queue",
    "label",
    "netoffline",
  ].some((key) => params.has(key)) || location.pathname === "/sync";

function FixtureShell({ children }: { children: ReactNode }) {
  // Sync screens driven by `?state=` take the chip from the same data double, so the chip and the panel can never disagree;
  // every other fixture page keeps the chip's own query-driven model (`?phase=`, `?pending=`).
  const fromData = useSyncStatusModel();
  const fixtureModel = useSyncExternalStore(store.subscribe, store.get);
  const syncModel = usesData ? fromData : fixtureModel;
  return (
    <ShellEnvProvider
      value={{
        syncModel,
        onOpenSync: (destination) => {
          opened.push(destination);
          if (usesData)
            void router.navigate({
              to: "/sync",
              search: {
                tab: destination === "conflicts" ? "conflicts" : "queue",
              },
            });
        },
        // On the icon rail there is room for one 44px control: a compact form with its own accessible name.
        accountSlot: ({ collapsed }) =>
          collapsed ? (
            <div
              role="img"
              aria-label="Fixture account"
              className="flex size-11 items-center justify-center rounded-md text-sm font-semibold text-muted-foreground"
            >
              F
            </div>
          ) : (
            <div className="px-2.5 py-2 text-sm text-muted-foreground">
              Fixture account
            </div>
          ),
      }}
    >
      {children}
    </ShellEnvProvider>
  );
}

function FixtureApp() {
  return (
    <SessionProvider session={session}>
      <DataEnvProvider env={data.env}>
        <FixtureShell>
          <RouterProvider router={router} />
          <SessionNotices />
        </FixtureShell>
      </DataEnvProvider>
    </SessionProvider>
  );
}

// The diagnostic pages (`/__neutral`, `/__controls`, `/__gate`) never render beside the shell, so they load on demand: the initial
// JavaScript the fixture budget measures (perf-budget.json) is then the signed-in shell's, not the shell's plus every gallery's
// (WEB-08d review r18 M1). They mark themselves ready once mounted (src/fixture/page-ready.tsx); specs wait for that.
if (location.pathname === "/__neutral") {
  // One neutral state or the resume gate, for rendered checks (src/fixture/neutral-page.tsx).
  void import("./neutral-page").then(({ mountNeutralPage }) =>
    mountNeutralPage(params),
  );
} else if (location.pathname === "/__data") {
  // The data harness (the production Dexie adapter, host and open predicate in a real engine): src/fixture/data-harness.
  document.getElementById("neutral-root")?.replaceChildren();
  void import("./data-harness/main");
} else if (location.pathname === "/profile-harness") {
  // The device profiling page (plan 7.5): one cold run of one workload per load; see src/fixture/data-harness/profile-page.ts.
  document.getElementById("neutral-root")?.replaceChildren();
  void import("./data-harness/main").then(async () => {
    const data = window.__atlasData;
    if (!data) throw new Error("the data harness did not start");
    const { mountProfilePage } = await import("./data-harness/profile-page");
    await mountProfilePage(data);
  });
} else if (
  location.pathname === "/__session" ||
  // The backend's OIDC callback redirects to the origin root with the grant in the fragment (BE-Q19). In an integration run
  // that root must run the PRODUCTION composition to land it, so the harness takes it (fixture only: production serves the real app).
  (location.pathname === "/" && location.hash.includes("atlas_grant="))
) {
  // The session harness (real adapters, real engine, no backend): see src/fixture/session-harness.
  void import("./session-harness/main");
} else if (
  location.pathname === "/__controls" ||
  location.pathname === "/__gate"
) {
  const page =
    location.pathname === "/__controls"
      ? import("./ControlsGallery").then(({ ControlsGallery }) => (
          <ControlsGallery />
        ))
      : import("./GateGallery").then(({ GateGallery }) => (
          <DataEnvProvider env={data.env}>
            <GateGallery />
          </DataEnvProvider>
        ));
  void page.then((gallery) => {
    const root = getProtectedRoot();
    document.getElementById("neutral-root")?.replaceChildren();
    liftGate(root);
    mountProtectedTree(
      root,
      <ProtectedProviders>
        <FixturePageReady>{gallery}</FixturePageReady>
      </ProtectedProviders>,
    );
  });
} else {
  const root = getProtectedRoot();
  // The real lifecycle (WEB-08a) decides when the boot gate goes; the fixture clears it and lifts the gate at once.
  document.getElementById("neutral-root")?.replaceChildren();
  liftGate(root);
  mountProtectedTree(
    root,
    <ProtectedProviders>
      <FixtureApp />
    </ProtectedProviders>,
  );
}
