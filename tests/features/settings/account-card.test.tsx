import { RouterProvider } from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProtectedProviders } from "../../../src/app/providers";
import { createAppRouter } from "../../../src/app/router";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import { sinceLine } from "../../../src/features/settings/account/AccountCard";
import { type Operations, SessionProvider } from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import { sessionDouble, sessionRow } from "../../helpers/session-double";

installMatchMedia({ width: 1440 });
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const account = (over: Record<string, unknown> = {}) => ({
  ok: true as const,
  value: {
    id: "acct-1",
    username: "kieran",
    has_password: true,
    oidc_issuers: [] as string[],
    ...over,
  },
});

async function mount(operations: Partial<Operations> = {}) {
  const session = sessionDouble({
    readAccount: vi.fn(async () => account()),
    ...operations,
  });
  const router = createAppRouter({ initialPath: "/settings" });
  const view = render(
    <SessionProvider session={session}>
      <ProtectedProviders>
        <ShellEnvProvider
          value={{
            syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
            onOpenSync: () => {},
          }}
        >
          <RouterProvider router={router} />
        </ShellEnvProvider>
      </ProtectedProviders>
    </SessionProvider>,
  );
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  return { session, ...view };
}

/** C-ACC: WF-SETTINGS-01's account card. */
describe("the account card", () => {
  test("it reads /me fresh, shows the username as a username and the session's start, and offers Switch account beside Sign out", async () => {
    const { session, container } = await mount({
      listSessions: vi.fn(async () => ({
        ok: true as const,
        value: {
          sessions: [sessionRow({ created_at: "2026-09-30T08:57:00.000Z" })],
        },
      })),
    });
    const card = await screen.findByText("kieran");
    const region = card.closest("[data-account-card]") as HTMLElement;
    expect(
      within(region).getByRole("heading", { level: 2, name: "Account" }),
    ).toBeInTheDocument();
    expect(
      within(region).getByText("Signed in as username"),
    ).toBeInTheDocument();
    expect(
      await within(region).findByText(/^Signed in since \d{2}:\d{2} · /),
    ).toBeInTheDocument();
    // WEB-08c (G-20): "Switch account" is appended to the `accountActions` seam, before "Sign out"; it opens WF-SWITCH-01 (a dialog).
    // (WEB-08b shipped the seam empty: the switch control was omitted, not disabled and not faked, until the journey existed.)
    expect(
      within(region)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Switch account", "Sign out"]);
    expect(
      within(region).getByRole("button", { name: "Switch account" }),
    ).toHaveAttribute("aria-haspopup", "dialog");
    // The avatar initial is decoration.
    expect(region.querySelector("[aria-hidden='true']")?.textContent).toBe("K");
    // Read from the server on mount (twice under React StrictMode's development double-effect), never from a cache.
    expect(
      vi.mocked(session.operations.readAccount).mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
    expect((await axe(container)).violations).toEqual([]);
  });

  test("it loads under a skeleton and the registry list paints at once", async () => {
    let release: (value: ReturnType<typeof account>) => void = () => {};
    await mount({
      readAccount: vi.fn(
        () =>
          new Promise<ReturnType<typeof account>>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const region = document.querySelector("[data-account-card]") as HTMLElement;
    expect(region.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Appearance" }),
    ).toBeInTheDocument();
    release(account());
    expect(await screen.findByText("kieran")).toBeInTheDocument();
    expect(region.querySelector("[aria-busy='true']")).toBeNull();
  });

  test("a failed read has its own error banner and retry, and the signed-in-since line is simply omitted when only that read fails", async () => {
    let failing = true;
    const readAccount = vi.fn(async () =>
      failing
        ? {
            ok: false as const,
            error: "http" as const,
            status: 500,
            atlasError: {
              code: "internal_error",
              message: "x",
              request_id: "req-acc",
            },
          }
        : account(),
    );
    await mount({
      readAccount,
      listSessions: vi.fn(async () => ({
        ok: false as const,
        error: "offline" as const,
      })),
    });
    const region = document.querySelector("[data-account-card]") as HTMLElement;
    expect(
      await within(region).findByText(/Couldn't load your account/),
    ).toBeInTheDocument();
    expect(within(region).getByText("Request ID: req-acc")).toBeInTheDocument();
    failing = false;
    fireEvent.click(within(region).getByRole("button", { name: "Try again" }));
    expect(await within(region).findByText("kieran")).toBeInTheDocument();
    expect(within(region).queryByText(/Signed in since/)).toBeNull();
  });

  test("offline says so", async () => {
    await mount({
      readAccount: vi.fn(async () => ({
        ok: false as const,
        error: "offline" as const,
      })),
    });
    const region = document.querySelector("[data-account-card]") as HTMLElement;
    expect(
      await within(region).findByText(
        "You're offline, so we can't load your account right now.",
      ),
    ).toBeInTheDocument();
  });

  test.each(["closed", "auth_state"] as const)(
    "E-29: a `%s` answer draws nothing about any account (the neutral state is taking over)",
    async (error) => {
      await mount({
        readAccount: vi.fn(async () => ({ ok: false as const, error })),
      });
      await waitFor(() =>
        expect(
          screen.getByRole("link", { name: "Appearance" }),
        ).toBeInTheDocument(),
      );
      expect(document.querySelector("[data-account-card]")).toBeNull();
      expect(screen.queryByText("kieran")).toBeNull();
    },
  );

  test("a hostile username is text, never markup", async () => {
    const hostile = '<img src=x onerror="alert(1)"><b>x</b>';
    await mount({
      readAccount: vi.fn(async () => account({ username: hostile })),
    });
    const region = document.querySelector("[data-account-card]") as HTMLElement;
    expect(
      await within(region).findByText(hostile, { exact: false }),
    ).toBeInTheDocument();
    expect(region.querySelector("img, b, script")).toBeNull();
  });

  test("Sign out opens the existing warning dialog", async () => {
    await mount();
    await screen.findByText("kieran");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(
      await screen.findByRole("dialog", { name: "Log out?" }),
    ).toBeInTheDocument();
  });
});

describe("sinceLine", () => {
  test("[D] 'Signed in since HH:mm · <zone>'; unreadable input gives nothing", () => {
    expect(sinceLine("2026-09-30T08:57:00.000Z")).toMatch(
      /^Signed in since \d{2}:\d{2} · \S+$/,
    );
    expect(sinceLine("garbage")).toBeNull();
  });
});
