import { RouterProvider } from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ProtectedProviders } from "../../../src/app/providers";
import { createAppRouter } from "../../../src/app/router";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import { DataEnvProvider } from "../../../src/data";
import { sharingItemPath } from "../../../src/features/sharing";
import * as copy from "../../../src/features/sharing/copy";
import { SharingEnvProvider } from "../../../src/features/sharing/env";
import { installMatchMedia } from "../../helpers/match-media";
import { record } from "../../support/data/sharing";
import { stubEnv } from "../../support/data/ui-env";
import { fakeSharingApi, sharingEnv } from "../../support/sharing/fake-api";
import { merged, RESOURCE } from "../../support/sharing/mount";

/**
 * D-12a-7: `/sharing`, `/sharing/defaults?kind=…` and `/sharing/items/<id>` in the application's own router, inside the protected
 * providers, over the data env and sharing env doubles. FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(cleanup);

async function mount(path: string) {
  const env = stubEnv();
  env.setDefaults(record());
  env.setResource(RESOURCE, merged());
  const api = fakeSharingApi();
  const router = createAppRouter({ initialPath: path });
  render(
    <ProtectedProviders>
      <ShellEnvProvider
        value={{
          syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
          onOpenSync: () => {},
        }}
      >
        <DataEnvProvider env={env}>
          <SharingEnvProvider value={sharingEnv(api)}>
            <RouterProvider router={router} />
          </SharingEnvProvider>
        </DataEnvProvider>
      </ShellEnvProvider>
    </ProtectedProviders>,
  );
  await screen.findByRole("heading", {
    level: 1,
    name: copy.PAGE_TITLE,
    hidden: true,
  });
  return { router, env, api };
}

describe("the sharing routes", () => {
  test("/sharing shows each kind's resolved default from the snapshot record, and the households subset", async () => {
    await mount("/sharing");
    const list = document.querySelector(
      '[data-defaults-kind="person"]',
    ) as HTMLElement;
    expect(list).toHaveTextContent("Primary household “Home” · edit");
    expect(
      document.querySelector('[data-defaults-kind="field"]'),
    ).toHaveTextContent("Private");
    expect(
      await screen.findByRole("heading", { name: copy.HOUSEHOLDS_HEADING }),
    ).toBeInTheDocument();
  });

  test("Edit defaults opens WF-SHARING-03 over the page; a kind tab changes the search; closing returns to /sharing", async () => {
    const { router } = await mount("/sharing");
    fireEvent.click(screen.getByRole("link", { name: copy.DEFAULTS_EDIT }));
    const dialog = await screen.findByRole("dialog", {
      name: copy.DEFAULTS_TITLE("People"),
    });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Tasks" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ kind: "task" }),
    );
    expect(
      await screen.findByRole("dialog", { name: copy.DEFAULTS_TITLE("Tasks") }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: copy.CLOSE,
      }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/sharing"),
    );
  });

  test("an unknown kind falls back to people", async () => {
    await mount("/sharing/defaults?kind=nonsense");
    expect(
      await screen.findByRole("dialog", {
        name: copy.DEFAULTS_TITLE("People"),
      }),
    ).toBeInTheDocument();
  });

  test("/sharing/items/<id> opens the policy editor for that resource (the deep link WEB-10/11 may use)", async () => {
    expect(sharingItemPath(RESOURCE)).toBe(`/sharing/items/${RESOURCE}`);
    await mount(sharingItemPath(RESOURCE));
    expect(
      await screen.findByRole("dialog", {
        name: copy.POLICY_TITLE("Water plants"),
      }),
    ).toBeInTheDocument();
  });
});
