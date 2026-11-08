import { RouterProvider } from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { ProtectedProviders } from "../../../src/app/providers";
import { createAppRouter } from "../../../src/app/router";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import type { SnapshotHousehold } from "../../../src/data";
import { DataEnvProvider } from "../../../src/data";
import * as base from "../../../src/features/sharing/copy";
import {
  type SharingEnv,
  SharingEnvProvider,
} from "../../../src/features/sharing/env";
import { HouseholdsEnvProvider } from "../../../src/features/sharing/households/env";
import { ME, SAM } from "../data/sharing";
import { type StubEnv, stubEnv } from "../data/ui-env";
import { type FakeSharingApi, fakeSharingApi, sharingEnv } from "./fake-api";
import { type FakeHouseholdApi, fakeHouseholdApi } from "./fake-households";

/**
 * Mounts the APPLICATION'S router at `path` inside the protected providers, over the data env double, a sharing env double and a household
 * api double (the production composition of the Sharing destination and its lazy household chunk). `setSharing` re-renders with a changed
 * env (online, identity...); `remount()` unmounts the whole tree and renders it again on the router's current location, as the session's
 * `403` handling remounts the protected tree (D-12a-13). FIXTURE evidence.
 */
export function mountHouseholds(
  path: string,
  options: {
    env?: StubEnv;
    api?: FakeHouseholdApi;
    /** The sharing env's own client (WEB-12a's: the directory lookup's exact read uses it). */
    sharingApi?: FakeSharingApi;
    sharing?: Partial<SharingEnv>;
  } = {},
) {
  const env = options.env ?? stubEnv();
  const api = options.api ?? fakeHouseholdApi();
  const sharingApi = options.sharingApi ?? fakeSharingApi();
  let sharing = sharingEnv(sharingApi, options.sharing);
  let router = createAppRouter({ initialPath: path });
  const tree = (value: SharingEnv) => (
    <ProtectedProviders>
      <ShellEnvProvider
        value={{
          syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
          onOpenSync: () => {},
        }}
      >
        <DataEnvProvider env={env}>
          <SharingEnvProvider value={value}>
            <HouseholdsEnvProvider value={{ api }}>
              <RouterProvider router={router} />
            </HouseholdsEnvProvider>
          </SharingEnvProvider>
        </DataEnvProvider>
      </ShellEnvProvider>
    </ProtectedProviders>
  );
  let view = render(tree(sharing));
  return {
    env,
    api,
    sharingApi,
    router: () => router,
    sharing: () => sharing,
    setSharing(over: Partial<SharingEnv>) {
      sharing = { ...sharing, ...over };
      view.rerender(tree(sharing));
    },
    /** The protected tree unmounted and mounted again on the same location (what a `403` does). */
    remount() {
      const at = router.state.location.href;
      view.unmount();
      router = createAppRouter({ initialPath: at });
      view = render(tree(sharing));
    },
    unmount: () => view.unmount(),
    async navigate(to: string) {
      await act(async () => {
        await router.navigate({ to } as never);
      });
    },
  };
}

/** The page's heading is shown (the shell and the sharing page rendered). */
export const pageReady = () =>
  screen.findByRole("heading", {
    level: 1,
    name: base.PAGE_TITLE,
    hidden: true,
  });

export const HOME_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const FLAT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const PRIYA_ID = "33333333-3333-4333-8333-333333333333";
export const JAMIE_ID = "44444444-4444-4444-8444-444444444444";

/** Home: you manage it with sam (member) unless `over` says otherwise. */
export function homeOf(
  over: Partial<SnapshotHousehold> = {},
): SnapshotHousehold {
  return {
    id: HOME_ID,
    name: "Home",
    version: 4,
    role: "manager",
    members: [
      { account_id: ME, username: "me", role: "manager" },
      { account_id: SAM, username: "sam", role: "member" },
    ],
    ...over,
  };
}
