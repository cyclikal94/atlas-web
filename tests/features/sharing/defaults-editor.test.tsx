import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TemplateKind } from "../../../src/data";
import * as copy from "../../../src/features/sharing/copy";
import { DefaultsEditor } from "../../../src/features/sharing/DefaultsEditor";
import {
  HOME,
  household,
  ME,
  record,
  SAM,
  snapshot,
} from "../../support/data/sharing";
import { stubEnv } from "../../support/data/ui-env";
import { emptyScope, fakeSharingApi, ok } from "../../support/sharing/fake-api";
import { mountSharing } from "../../support/sharing/mount";

/**
 * A4, A12 (component layer): WF-SHARING-03 over the data env double (the B5 record) and a scripted sharing API, in jsdom. FIXTURE evidence.
 */
afterEach(cleanup);

function setup(
  over: {
    role?: "manager" | "member";
    personal?: { template: object | null; version: number };
    household?: { template: object | null; version: number };
    online?: boolean;
    primary?: string | null;
  } = {},
) {
  const env = stubEnv();
  const snap = snapshot({
    primary: over.primary === undefined ? HOME : over.primary,
    households:
      over.primary === null
        ? []
        : [
            household({
              id: HOME,
              role: over.role ?? "manager",
              members: [
                { account_id: ME, username: "me", role: "manager" },
                { account_id: SAM, username: "sam", role: "member" },
              ],
            }),
          ],
  });
  env.setDefaults(
    record(snap, { fetched_at: Date.now(), issued_at: Date.now() }),
  );
  const api = fakeSharingApi();
  api.defaults.templates = (householdId) => {
    const scope = emptyScope();
    const layer = householdId === null ? over.personal : over.household;
    if (layer) scope.field = layer as never;
    return ok(scope);
  };
  const onKindChange = vi.fn();
  const onClose = vi.fn();
  const view = mountSharing(
    <DefaultsEditor
      kind="field"
      onKindChange={onKindChange}
      onClose={onClose}
    />,
    { env, api, sharing: { online: over.online ?? true } },
  );
  return { ...view, onKindChange, onClose };
}

const personalForm = () =>
  document.querySelector<HTMLElement>(
    '[data-layer-form="personal"]',
  ) as HTMLElement;
const save = (layer: string) =>
  document.querySelector<HTMLButtonElement>(
    `[data-save="${layer}"]`,
  ) as HTMLButtonElement;

describe("the resolution chain and the layers", () => {
  test("R4: with no personal override, the chain highlights the household layer and the personal row says what it inherits", async () => {
    setup({
      household: {
        template: { kind: "primary_household", edit: false },
        version: 3,
      },
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-chain="household"]'),
      ).toHaveAttribute("aria-current", "true"),
    );
    expect(
      document.querySelector('[data-chain="personal"]'),
    ).not.toHaveAttribute("aria-current");
    expect(
      screen.getByText(
        copy.PERSONAL_INHERITS("Primary household “Home” · read", 0),
      ),
    ).toBeInTheDocument();
    // "Inherit household default" is CHECKED at version 0, distinct from Private.
    const group = within(personalForm()).getByRole("radiogroup");
    expect(
      within(group).getByRole("radio", {
        name: copy.CHOICE_INHERIT_PERSONAL("Primary household “Home” · read"),
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(group).getByRole("radio", { name: copy.CHOICE_PRIVATE }),
    ).toHaveAttribute("aria-checked", "false");
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("a personal override resolves at the personal layer, and Inherit removes it with template null at ITS version", async () => {
    const t = setup({
      personal: { template: { kind: "private" }, version: 2 },
      household: {
        template: { kind: "primary_household", edit: true },
        version: 7,
      },
    });
    await waitFor(() =>
      expect(document.querySelector('[data-chain="personal"]')).toHaveAttribute(
        "aria-current",
        "true",
      ),
    );
    const group = within(personalForm()).getByRole("radiogroup");
    fireEvent.click(
      within(group).getByRole("radio", { name: /Inherit household default/ }),
    );
    fireEvent.click(save("personal"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands).toEqual([
      {
        kind: "set_defaults",
        household_id: null,
        resource_kind: "field",
        expected_version: 2,
        template: null,
      },
    ]);
  });

  test("MU-S15: a personal save is guarded by the PERSONAL template's version even while the household layer resolves", async () => {
    const t = setup({
      personal: { template: null, version: 4 },
      household: {
        template: { kind: "primary_household", edit: false },
        version: 9,
      },
    });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    fireEvent.click(
      within(within(personalForm()).getByRole("radiogroup")).getByRole(
        "radio",
        { name: copy.CHOICE_PRIVATE },
      ),
    );
    expect(
      within(personalForm()).getByText(/would start as: Private/),
    ).toBeInTheDocument();
    fireEvent.click(save("personal"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands).toEqual([
      {
        kind: "set_defaults",
        household_id: null,
        resource_kind: "field",
        expected_version: 4,
        template: { kind: "private" },
      },
    ]);
  });

  test("a manager edits the household layer with its own version; a member sees it read-only", async () => {
    const t = setup({
      household: { template: { kind: "private" }, version: 3 },
    });
    const form = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-layer-form="household"]',
      );
      if (!found) throw new Error("no household form");
      return found;
    });
    fireEvent.click(
      within(within(form).getByRole("radiogroup")).getByRole("radio", {
        name: copy.CHOICE_HOUSEHOLD_EDIT,
      }),
    );
    fireEvent.click(save("household"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands).toEqual([
      {
        kind: "set_defaults",
        household_id: HOME,
        resource_kind: "field",
        expected_version: 3,
        template: { kind: "primary_household", edit: true },
      },
    ]);
    cleanup();
    setup({
      role: "member",
      household: { template: { kind: "private" }, version: 3 },
    });
    expect(
      await screen.findByText(copy.HOUSEHOLD_MANAGER_ONLY),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-layer-form="household"]')).toBeNull();
  });

  test("Er: a stale template version shows the conflict with its request id and a Reload that reads the templates again", async () => {
    const t = setup({ personal: { template: null, version: 0 } });
    t.api.next.management.push({
      ok: false,
      kind: "conflict",
      requestId: "c2049e11-0000-4000-8000-000000000000",
    });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    fireEvent.click(
      within(within(personalForm()).getByRole("radiogroup")).getByRole(
        "radio",
        { name: copy.CHOICE_PRIVATE },
      ),
    );
    fireEvent.click(save("personal"));
    expect(await screen.findByText(copy.TEMPLATE_CONFLICT)).toBeInTheDocument();
    const before = t.api.calls.filter((c) => c.op === "readTemplates").length;
    fireEvent.click(screen.getByRole("button", { name: copy.RELOAD }));
    await waitFor(() =>
      expect(
        t.api.calls.filter((c) => c.op === "readTemplates").length,
      ).toBeGreaterThan(before),
    );
    expect(t.api.sent).toHaveLength(1);
  });

  test("without a primary household the household layer says the application default applies", async () => {
    setup({ primary: null });
    expect(await screen.findByText(copy.NO_PRIMARY)).toBeInTheDocument();
  });

  test("offline: the last snapshot's defaults are shown read-only with their time, nothing is asked, nothing can be saved", async () => {
    const t = setup({ online: false });
    expect(
      await screen.findByText(copy.DEFAULTS_OFFLINE_READONLY),
    ).toBeInTheDocument();
    expect(screen.getByText(/Fields: Private/)).toBeInTheDocument();
    expect(t.api.calls).toEqual([]);
    expect(document.querySelector("[data-save]")).toBeNull();
  });

  test("the kinds are a tablist: arrows move between them and ask for the next kind", async () => {
    const t = setup();
    const tablist = await screen.findByRole("tablist", {
      name: copy.KINDS_LABEL,
    });
    const selected = within(tablist).getByRole("tab", { selected: true });
    expect(selected).toHaveTextContent("Fields");
    fireEvent.keyDown(selected, { key: "ArrowRight" });
    expect(t.onKindChange).toHaveBeenCalledWith("task" satisfies TemplateKind);
    fireEvent.keyDown(selected, { key: "Home" });
    expect(t.onKindChange).toHaveBeenLastCalledWith("person");
  });

  test("an explicit personal template is edited with the shared grant editor and sent as a canonical policy", async () => {
    const t = setup({ personal: { template: null, version: 0 } });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    fireEvent.click(
      within(within(personalForm()).getByRole("radiogroup")).getByRole(
        "radio",
        { name: copy.CHOICE_EXPLICIT },
      ),
    );
    fireEvent.click(
      within(personalForm()).getByRole("button", { name: copy.ADD_HOUSEHOLD }),
    );
    fireEvent.click(
      within(personalForm()).getByRole("button", { name: "Home" }),
    );
    fireEvent.click(save("personal"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands).toEqual([
      {
        kind: "set_defaults",
        household_id: null,
        resource_kind: "field",
        expected_version: 0,
        template: {
          kind: "explicit",
          policy: {
            grants: [{ kind: "household", id: HOME, edit: false }],
            exclude_accounts: [],
          },
        },
      },
    ]);
  });

  test("opening asks for a fresh snapshot (refresh) when online", async () => {
    const t = setup();
    await waitFor(() =>
      expect(t.env.calls.some((c) => c.action === "refreshDefaults")).toBe(
        true,
      ),
    );
  });
});
