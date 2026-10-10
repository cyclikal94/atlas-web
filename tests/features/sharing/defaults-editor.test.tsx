import {
  act,
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
import { forgetAllRetained } from "../../../src/features/sharing/retained";
import {
  FLAT,
  HOME,
  household,
  ME,
  record,
  SAM,
  snapshot,
} from "../../support/data/sharing";
import { stubEnv } from "../../support/data/ui-env";
import {
  type Answer,
  emptyScope,
  fakeSharingApi,
  ok,
} from "../../support/sharing/fake-api";
import { mountSharing } from "../../support/sharing/mount";

/**
 * A4, A12 (component layer): WF-SHARING-03 over the data env double (the B5 record) and a scripted sharing API, in jsdom. FIXTURE evidence.
 */
afterEach(() => {
  cleanup();
  forgetAllRetained();
});

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

// ---- WEB-12a review cycle 1 --------------------------------------------------------------------------------------------------------
const householdForm = () =>
  document.querySelector<HTMLElement>('[data-layer-form="household"]');
/** The layer's own choice group (the first radiogroup of the form; an explicit policy adds its grants' groups after it). */
const layerGroup = (form: HTMLElement) =>
  within(form).getAllByRole("radiogroup")[0] as HTMLElement;
const choose = (form: HTMLElement, name: string) =>
  fireEvent.click(within(layerGroup(form)).getByRole("radio", { name }));
const chosen = (form: HTMLElement) =>
  within(layerGroup(form))
    .getAllByRole("radio")
    .find((radio) => radio.getAttribute("aria-checked") === "true")
    ?.textContent;
const scopeWith = (field: { template: object | null; version: number }) => {
  const scope = emptyScope();
  scope.field = field as never;
  return scope;
};
const snapWith = (primary: string, name: string) =>
  record(
    snapshot({
      primary,
      households: [
        household({
          id: primary,
          name,
          role: "manager",
          members: [{ account_id: ME, username: "me", role: "manager" }],
        }),
      ],
    }),
    { fetched_at: Date.now(), issued_at: Date.now() },
  );

/** The editor over a primary household H1, with each household layer read answered in turn, and a fixed clock (equal read times). */
function householdSetup(
  householdReads: Answer<ReturnType<typeof emptyScope>>[],
) {
  const env = stubEnv();
  env.setDefaults(snapWith(HOME, "Home"));
  const api = fakeSharingApi();
  api.next.templates.push(...[]);
  const reads = [...householdReads];
  api.defaults.templates = () => ok(emptyScope());
  const original = api.readTemplates.bind(api);
  api.readTemplates = async (householdId) => {
    if (householdId === null) return original(null);
    api.calls.push({ op: "readTemplates", args: [householdId] });
    const next = reads.shift();
    if (next === undefined) return ok(emptyScope());
    return typeof next === "function" ? next() : next;
  };
  const view = mountSharing(
    <DefaultsEditor kind="field" onKindChange={vi.fn()} onClose={vi.fn()} />,
    { env, api, sharing: { now: () => 1_000 } },
  );
  return { ...view, env, api };
}
const householdReads = (api: ReturnType<typeof fakeSharingApi>) =>
  api.calls
    .filter((c) => c.op === "readTemplates" && c.args[0] !== null)
    .map((c) => c.args[0]);

describe("R1: the household layer belongs to the primary household it was read for", () => {
  test("MU-S32: H1 → H2 mid-edit (equal versions, equal read times): H2 is read before anything can be saved, and Save sends H2's own version", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = householdSetup([
      ok(scopeWith({ template: { kind: "private" }, version: 3 })),
      async () => {
        await gate;
        return ok(scopeWith({ template: { kind: "private" }, version: 3 }));
      },
    ]);
    const first = await waitFor(() => {
      const found = householdForm();
      if (!found) throw new Error("no household form");
      return found;
    });
    choose(first, copy.CHOICE_HOUSEHOLD_EDIT);
    act(() => t.env.setDefaults(snapWith(FLAT, "Flat")));
    // While FLAT is being read, nothing of HOME's can be saved for it.
    await waitFor(() => expect(householdForm()).toBeNull());
    expect(document.querySelector('[data-save="household"]')).toBeNull();
    release();
    const second = await waitFor(() => {
      const found = householdForm();
      if (!found) throw new Error("no household form");
      return found;
    });
    expect(householdReads(t.api)).toEqual([HOME, FLAT]);
    // FLAT's own template, not HOME's unsaved choice.
    expect(chosen(second)).toBe(copy.CHOICE_PRIVATE);
    choose(second, copy.CHOICE_HOUSEHOLD_READ);
    fireEvent.click(save("household"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands).toEqual([
      {
        kind: "set_defaults",
        household_id: FLAT,
        resource_kind: "field",
        expected_version: 3,
        template: { kind: "primary_household", edit: false },
      },
    ]);
  });

  test("MU-S32: H1's read answered AFTER the switch never becomes H2's template or version", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = householdSetup([
      async () => {
        await gate;
        return ok(scopeWith({ template: { kind: "private" }, version: 9 }));
      },
      ok(scopeWith({ template: null, version: 0 })),
    ]);
    await waitFor(() => expect(householdReads(t.api)).toEqual([HOME]));
    act(() => t.env.setDefaults(snapWith(FLAT, "Flat")));
    const form = await waitFor(() => {
      const found = householdForm();
      if (!found) throw new Error("no household form");
      return found;
    });
    release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    choose(form, copy.CHOICE_HOUSEHOLD_EDIT);
    fireEvent.click(save("household"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands[0]).toMatchObject({
      household_id: FLAT,
      expected_version: 0,
    });
  });
});

describe("R5: unsaved choices survive going offline and the sync control; Done discards them", () => {
  test("MU-S33: Inherit → Private, offline, then online: Private is still chosen, and nothing was saved", async () => {
    const t = setup({ personal: { template: null, version: 0 } });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    choose(personalForm(), copy.CHOICE_PRIVATE);
    t.setSharing({ online: false });
    // The re-render is synchronous: the forms are still there, with the offline note, never the read-only snapshot in their place.
    expect(
      document.querySelector("[data-defaults-offline-editing]"),
    ).not.toBeNull();
    expect(document.querySelector("[data-defaults-offline]")).toBeNull();
    expect(personalForm()).not.toBeNull();
    expect(chosen(personalForm())).toBe(copy.CHOICE_PRIVATE);
    // Offline, Save waits for the connection with the reason beside it.
    expect(save("personal")).toBeDisabled();
    t.setSharing({ online: true });
    await waitFor(() =>
      expect(screen.queryByText(copy.DEFAULTS_OFFLINE_EDITING)).toBeNull(),
    );
    expect(chosen(personalForm())).toBe(copy.CHOICE_PRIVATE);
    expect(t.api.sent).toEqual([]);
    fireEvent.click(save("personal"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands[0]).toMatchObject({
      household_id: null,
      expected_version: 0,
      template: { kind: "private" },
    });
  });

  test("MU-S34: the sync control keeps both layers' choices (an explicit policy included) and reopening shows them; nothing is sent until Save", async () => {
    const t = setup({
      personal: { template: null, version: 0 },
      household: { template: { kind: "private" }, version: 3 },
    });
    await waitFor(() => expect(householdForm()).toBeTruthy());
    choose(householdForm() as HTMLElement, copy.CHOICE_HOUSEHOLD_EDIT);
    choose(personalForm(), copy.CHOICE_EXPLICIT);
    fireEvent.click(
      within(personalForm()).getByRole("button", { name: copy.ADD_HOUSEHOLD }),
    );
    fireEvent.click(
      await within(personalForm()).findByRole("button", { name: "Home" }),
    );
    fireEvent.click(
      screen.getByRole("dialog").querySelector("[data-sync-tone]") as Element,
    );
    expect(t.onClose).toHaveBeenCalled();
    cleanup();
    // Reopened (the same identity): both forms come back as they were left.
    const again = setup({
      personal: { template: null, version: 0 },
      household: { template: { kind: "private" }, version: 3 },
    });
    await waitFor(() => expect(householdForm()).toBeTruthy());
    expect(chosen(householdForm() as HTMLElement)).toBe(
      copy.CHOICE_HOUSEHOLD_EDIT,
    );
    expect(chosen(personalForm())).toBe(copy.CHOICE_EXPLICIT);
    expect(
      within(personalForm()).getByRole("radiogroup", {
        name: `Home: ${copy.READ} or ${copy.EDIT}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(copy.RESTORED_UNSAVED)).toHaveLength(2);
    expect(again.api.sent).toEqual([]);
    expect(t.api.sent).toEqual([]);
    fireEvent.click(save("personal"));
    await waitFor(() => expect(again.api.sent).toHaveLength(1));
    expect(again.api.sent[0]?.commands[0]).toMatchObject({
      household_id: null,
      expected_version: 0,
      template: {
        kind: "explicit",
        policy: {
          grants: [{ kind: "household", id: HOME, edit: false }],
          exclude_accounts: [],
        },
      },
    });
  });

  test("MU-S39: Done discards KEPT choices: reopening shows the stored templates", async () => {
    const first = setup({ personal: { template: null, version: 0 } });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    choose(personalForm(), copy.CHOICE_PRIVATE);
    fireEvent.click(
      screen.getByRole("dialog").querySelector("[data-sync-tone]") as Element,
    );
    expect(first.onClose).toHaveBeenCalled();
    cleanup();
    const t = setup({ personal: { template: null, version: 0 } });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    expect(chosen(personalForm())).toBe(copy.CHOICE_PRIVATE);
    fireEvent.click(screen.getByRole("button", { name: copy.CLOSE }));
    expect(t.onClose).toHaveBeenCalled();
    cleanup();
    setup({ personal: { template: null, version: 0 } });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    expect(chosen(personalForm())).not.toBe(copy.CHOICE_PRIVATE);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
  });

  test("control: kept choices are only for their own target: another household's layer never shows them", async () => {
    const t = setup({
      household: { template: { kind: "private" }, version: 3 },
    });
    await waitFor(() => expect(householdForm()).toBeTruthy());
    choose(householdForm() as HTMLElement, copy.CHOICE_HOUSEHOLD_EDIT);
    fireEvent.click(
      screen.getByRole("dialog").querySelector("[data-sync-tone]") as Element,
    );
    expect(t.onClose).toHaveBeenCalled();
    cleanup();
    const other = householdSetup([
      ok(scopeWith({ template: { kind: "private" }, version: 3 })),
    ]);
    // Positive control: the same identity and household get their kept choice back.
    await waitFor(() => expect(householdForm()).toBeTruthy());
    expect(chosen(householdForm() as HTMLElement)).toBe(
      copy.CHOICE_HOUSEHOLD_EDIT,
    );
    act(() => other.env.setDefaults(snapWith(FLAT, "Flat")));
    await waitFor(() => expect(householdReads(other.api)).toContain(FLAT));
    await waitFor(() =>
      expect(
        householdForm()?.closest("[data-layer]")?.textContent ?? "",
      ).toContain("Flat"),
    );
    expect(chosen(householdForm() as HTMLElement)).not.toBe(
      copy.CHOICE_HOUSEHOLD_EDIT,
    );
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
  });
});
