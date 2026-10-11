import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SnapshotHousehold, TemplateKind } from "../../../src/data";
import type { SharingResult } from "../../../src/features/sharing/api";
import * as copy from "../../../src/features/sharing/copy";
import { DefaultsEditor } from "../../../src/features/sharing/DefaultsEditor";
import { forgetAllRetained } from "../../../src/features/sharing/retained";
import {
  ELSEWHERE,
  FLAT,
  HOME,
  household,
  ME,
  PRIYA,
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
  sharingEnv,
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
    /** `GET /households` (R11): the complete membership list; by default exactly the households the snapshot names. */
    memberships?: SnapshotHousehold[];
    /** Answers to the membership reads in turn (then `memberships`). */
    membershipReads?: Answer<SnapshotHousehold[]>[];
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
  api.defaults.households = ok(over.memberships ?? snap.households);
  api.next.households.push(...(over.membershipReads ?? []));
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

// ---- WEB-12a review 2 ------------------------------------------------------------------------------------------------------------
describe("R5 (review 2): what the session kept is discarded by a dismissal, whichever forms are on screen", () => {
  /** The route's host: the editor open on a kind, closed by its own onClose, reopened in page memory (no reload). */
  function defaultsHost(primary: string | null = HOME) {
    const env = stubEnv();
    env.setDefaults(
      primary === null
        ? record(snapshot({ primary: null }), {
            fetched_at: Date.now(),
            issued_at: Date.now(),
          })
        : snapWith(primary, "Home"),
    );
    const api = fakeSharingApi();
    let setOpen: (open: boolean) => void = () => undefined;
    function Host() {
      const [open, set] = useState(true);
      const [kind, setKind] = useState<TemplateKind>("field");
      setOpen = set;
      return open ? (
        <DefaultsEditor
          kind={kind}
          onKindChange={setKind}
          onClose={() => set(false)}
        />
      ) : null;
    }
    const view = mountSharing(<Host />, { env, api });
    return { ...view, env, api, reopen: () => act(() => setOpen(true)) };
  }
  const dialogOpen = () => screen.queryByRole("dialog") !== null;
  const syncControl = () =>
    screen.getByRole("dialog").querySelector("[data-sync-tone]") as Element;
  const done = () =>
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: copy.CLOSE,
      }),
    );
  const tab = (name: string) =>
    fireEvent.click(screen.getByRole("tab", { name }));
  /** Inherit → Private on the personal Fields layer, then the sync control: kept, the dialog closed, nothing sent. */
  async function keepPrivate(t: ReturnType<typeof defaultsHost>) {
    await waitFor(() => expect(personalForm()).toBeTruthy());
    choose(personalForm(), copy.CHOICE_PRIVATE);
    fireEvent.click(syncControl());
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(t.api.sent).toEqual([]);
  }
  /** Reopens and waits until the personal Fields form is on screen. */
  async function reopenForms(t: ReturnType<typeof defaultsHost>) {
    t.reopen();
    await waitFor(() => expect(personalForm()).toBeTruthy());
  }

  test("control: reopened offline (no forms), then back online WITHOUT a dismissal, the kept choice is restored", async () => {
    const t = defaultsHost();
    await keepPrivate(t);
    t.setSharing({ online: false });
    t.reopen();
    expect(document.querySelector("[data-defaults-offline]")).not.toBeNull();
    expect(personalForm()).toBeNull();
    t.setSharing({ online: true });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    expect(chosen(personalForm())).toBe(copy.CHOICE_PRIVATE);
    expect(screen.getByText(copy.RESTORED_UNSAVED)).toBeInTheDocument();
  });

  test("MU-S45: Done while reopened offline (no form on screen) discards the kept choice: back online, reopening shows the stored template", async () => {
    const t = defaultsHost();
    await keepPrivate(t);
    t.setSharing({ online: false });
    t.reopen();
    expect(personalForm()).toBeNull();
    done();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    t.setSharing({ online: true });
    await reopenForms(t);
    expect(chosen(personalForm())).not.toBe(copy.CHOICE_PRIVATE);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
    expect(t.api.sent).toEqual([]);
  });

  test("MU-S45: Escape while the reopened editor is still reading its templates discards the kept choice; the late read restores nothing", async () => {
    const t = defaultsHost(null);
    await keepPrivate(t);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.api.next.templates.push(async () => {
      await gate;
      return ok(emptyScope());
    });
    t.reopen();
    expect(personalForm()).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(dialogOpen()).toBe(false));
    release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await reopenForms(t);
    expect(chosen(personalForm())).not.toBe(copy.CHOICE_PRIVATE);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
  });

  test("control: switching Fields → Tasks → Fields WITHOUT a dismissal gives the kept Fields choice back", async () => {
    const t = defaultsHost();
    await keepPrivate(t);
    await reopenForms(t);
    expect(chosen(personalForm())).toBe(copy.CHOICE_PRIVATE);
    tab("Tasks");
    await waitFor(() =>
      expect(chosen(personalForm())).not.toBe(copy.CHOICE_PRIVATE),
    );
    tab("Fields");
    await waitFor(() =>
      expect(chosen(personalForm())).toBe(copy.CHOICE_PRIVATE),
    );
  });

  test("MU-S46: Done on another kind discards the kept Fields choice too (it is the session's, not the form on screen's)", async () => {
    const t = defaultsHost();
    await keepPrivate(t);
    await reopenForms(t);
    expect(chosen(personalForm())).toBe(copy.CHOICE_PRIVATE);
    tab("Tasks");
    await waitFor(() =>
      expect(chosen(personalForm())).not.toBe(copy.CHOICE_PRIVATE),
    );
    done();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    await reopenForms(t);
    tab("Tasks");
    tab("Fields");
    await waitFor(() => expect(personalForm()).toBeTruthy());
    expect(chosen(personalForm())).not.toBe(copy.CHOICE_PRIVATE);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
    expect(t.api.sent).toEqual([]);
  });

  test("MU-S46: Done after the primary household changed discards the earlier household's kept choice too", async () => {
    const t = defaultsHost();
    await waitFor(() => expect(householdForm()).toBeTruthy());
    choose(householdForm() as HTMLElement, copy.CHOICE_HOUSEHOLD_EDIT);
    fireEvent.click(syncControl());
    await waitFor(() => expect(dialogOpen()).toBe(false));
    await reopenForms(t);
    await waitFor(() =>
      expect(chosen(householdForm() as HTMLElement)).toBe(
        copy.CHOICE_HOUSEHOLD_EDIT,
      ),
    );
    // The snapshot now names another primary household: Home's form is gone, Flat's is shown.
    act(() => t.env.setDefaults(snapWith(FLAT, "Flat")));
    await waitFor(() =>
      expect(
        householdForm()?.closest("[data-layer]")?.textContent ?? "",
      ).toContain("Flat"),
    );
    done();
    await waitFor(() => expect(dialogOpen()).toBe(false));
    act(() => t.env.setDefaults(snapWith(HOME, "Home")));
    await reopenForms(t);
    await waitFor(() => expect(householdForm()).toBeTruthy());
    expect(chosen(householdForm() as HTMLElement)).not.toBe(
      copy.CHOICE_HOUSEHOLD_EDIT,
    );
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
  });

  test("MU-S47: saving one layer forgets only that layer: the other layer's kept choice is still restored (an unmount is not a dismissal)", async () => {
    const t = defaultsHost();
    await waitFor(() => expect(householdForm()).toBeTruthy());
    choose(householdForm() as HTMLElement, copy.CHOICE_HOUSEHOLD_EDIT);
    choose(personalForm(), copy.CHOICE_PRIVATE);
    fireEvent.click(syncControl());
    await waitFor(() => expect(dialogOpen()).toBe(false));
    await reopenForms(t);
    expect(screen.getAllByText(copy.RESTORED_UNSAVED)).toHaveLength(2);
    fireEvent.click(save("personal"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands[0]).toMatchObject({
      household_id: null,
      template: { kind: "private" },
    });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    // The page leaves the editor without a dismissal (its tree unmounts), then the editor is opened again.
    cleanup();
    const again = defaultsHost();
    await waitFor(() => expect(householdForm()).toBeTruthy());
    expect(chosen(householdForm() as HTMLElement)).toBe(
      copy.CHOICE_HOUSEHOLD_EDIT,
    );
    expect(chosen(personalForm())).not.toBe(copy.CHOICE_PRIVATE);
    expect(screen.getAllByText(copy.RESTORED_UNSAVED)).toHaveLength(1);
    expect(again.api.sent).toEqual([]);
  });

  test("MU-S48: a template conflict's Reload abandons the kept choice even when the new read fails", async () => {
    const t = defaultsHost(null);
    await keepPrivate(t);
    await reopenForms(t);
    expect(chosen(personalForm())).toBe(copy.CHOICE_PRIVATE);
    t.api.next.management.push({
      ok: false,
      kind: "conflict",
      requestId: "rq",
    });
    fireEvent.click(save("personal"));
    await screen.findByText(copy.TEMPLATE_CONFLICT, {
      selector: "[data-sharing-banner] p",
    });
    t.api.next.templates.push({ ok: false, kind: "invalid" });
    fireEvent.click(screen.getByRole("button", { name: copy.RELOAD }));
    await screen.findByText(copy.TEMPLATES_LOAD_FAILED, {
      selector: "[data-sharing-banner] p",
    });
    // The sync control has no form to keep; reopening shows the stored template, never the abandoned choice.
    fireEvent.click(syncControl());
    await waitFor(() => expect(dialogOpen()).toBe(false));
    await reopenForms(t);
    expect(chosen(personalForm())).not.toBe(copy.CHOICE_PRIVATE);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
    expect(t.api.sent).toHaveLength(1);
  });
});

describe("R7: after a save the snapshot is asked for AFTER it", () => {
  test("MU-S52: a successful save asks for a snapshot read issued after the success (an acquisition with a boundary), never a refresh that could share an older read", async () => {
    const t = setup({ personal: { template: null, version: 0 } });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    const before = t.env.calls.length;
    choose(personalForm(), copy.CHOICE_PRIVATE);
    fireEvent.click(save("personal"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    await waitFor(() =>
      expect(
        t.env.calls
          .slice(before)
          .filter((c) => c.action === "refreshDefaults" && c.args.length === 1),
      ).toHaveLength(1),
    );
    expect(
      t.env.calls
        .slice(before)
        .filter((c) => c.action === "refreshDefaults" && c.args.length === 0),
    ).toHaveLength(0);
  });
});

// ---- WEB-12a review 3 ------------------------------------------------------------------------------------------------------------
describe("R8 (review 3): a defaults Try again is admitted like Save, and one not sent keeps the uncertain attempt", () => {
  const reasonOf = (button: HTMLElement) =>
    document.getElementById(button.getAttribute("aria-describedby") ?? "")
      ?.textContent;
  async function uncertainSave() {
    const t = setup({ personal: { template: null, version: 2 } });
    t.api.next.management.push({ ok: false, kind: "uncertain" });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    choose(personalForm(), copy.CHOICE_PRIVATE);
    fireEvent.click(save("personal"));
    expect(await screen.findByText(copy.UNCERTAIN)).toBeInTheDocument();
    return { t, first: structuredClone(t.api.sent[0]) };
  }

  test("MU-S62: offline with an uncertain save, Try again is disabled with the connection reason and sends nothing; back online it resends the same key and body", async () => {
    const { t, first } = await uncertainSave();
    t.setSharing({ online: false });
    const offlineRetry = screen.getByRole("button", { name: copy.TRY_AGAIN });
    expect(offlineRetry).toBeDisabled();
    expect(reasonOf(offlineRetry)).toBe(copy.SAVE_OFFLINE_REASON);
    fireEvent.click(offlineRetry);
    await act(async () => {});
    expect(t.api.calls.filter((c) => c.op === "management")).toHaveLength(1);
    t.setSharing({ online: true });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(t.api.sent).toHaveLength(2));
    expect(t.api.sent[1]).toEqual(first);
  });

  test("MU-S63: a Try again the adapter answers offline still says the change is unconfirmed, and the next one resends it", async () => {
    const { t, first } = await uncertainSave();
    t.api.next.management.push({ ok: false, kind: "offline" });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() =>
      expect(t.api.calls.filter((c) => c.op === "management")).toHaveLength(2),
    );
    await act(async () => {});
    expect(screen.queryByText(copy.UNCERTAIN)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(t.api.sent).toHaveLength(3));
    expect(t.api.sent[2]).toEqual(first);
  });
});

describe("DA-P1 (Q15) comparison: the defaults editor keeps an uncertain attempt through a closed Try again", () => {
  test("answered closed, the change is still said to be unconfirmed and the next Try again resends the same key and body", async () => {
    const t = setup({ personal: { template: null, version: 2 } });
    t.api.next.management.push({ ok: false, kind: "uncertain" });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    choose(personalForm(), copy.CHOICE_PRIVATE);
    fireEvent.click(save("personal"));
    expect(await screen.findByText(copy.UNCERTAIN)).toBeInTheDocument();
    const first = structuredClone(t.api.sent[0]);
    t.api.next.management.push({ ok: false, kind: "closed" });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() =>
      expect(t.api.calls.filter((c) => c.op === "management")).toHaveLength(2),
    );
    await act(async () => {});
    // The banner's own Try again (the announcer's live region also repeats the message, so the text alone proves nothing).
    expect(
      screen.queryByRole("button", { name: copy.TRY_AGAIN }),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(t.api.sent).toHaveLength(3));
    expect(t.api.sent[2]).toEqual(first);
  });
});

// ---- WEB-12a review 5, R11 (and design assessment Q1-Q7) ----------------------------------------------------------------------------
describe("R11: an explicit default can grant any household you are in (the complete membership list, never B5's subset)", () => {
  const homeOf = (name = "Home") =>
    household({
      id: HOME,
      name,
      role: "manager",
      members: [
        { account_id: ME, username: "me", role: "manager" },
        { account_id: SAM, username: "sam", role: "member" },
      ],
    });
  /** A household you are in that no resolved default names, so B5 does not list it. */
  const second = household({
    id: FLAT,
    name: "Second household",
    role: "member",
    members: [
      { account_id: ME, username: "me", role: "member" },
      { account_id: PRIYA, username: "priya", role: "manager" },
    ],
  });
  const grantingSecond = (edit = false) => ({
    kind: "explicit",
    policy: {
      grants: [{ kind: "household", id: FLAT, edit }],
      exclude_accounts: [],
    },
  });
  /** A membership answer held until it is settled with a result. */
  const gated = () => {
    let settle!: (result: SharingResult<SnapshotHousehold[]>) => void;
    const gate = new Promise<SharingResult<SnapshotHousehold[]>>((resolve) => {
      settle = resolve;
    });
    const answer: Answer<SnapshotHousehold[]> = () => gate;
    return { answer, settle };
  };
  const reasonOf = (button: HTMLElement) =>
    document.getElementById(button.getAttribute("aria-describedby") ?? "")
      ?.textContent;
  const membershipReads = (api: { calls: Array<{ op: string }> }) =>
    api.calls.filter((call) => call.op === "readHouseholds").length;
  const templateReads = (api: { calls: Array<{ op: string }> }) =>
    api.calls.filter((call) => call.op === "readTemplates").length;
  const flush = () => act(async () => {});
  const picker = (form: HTMLElement) =>
    form.querySelector<HTMLElement>("[data-household-picker]");
  /** The households the open picker offers, by name. */
  const offered = (form: HTMLElement) =>
    within(picker(form) as HTMLElement)
      .queryAllByRole("button")
      .map((button) => button.textContent)
      .filter((name) => name !== copy.CANCEL);
  const addButton = (form: HTMLElement) =>
    within(form).getByRole("button", {
      name: copy.ADD_HOUSEHOLD,
    }) as HTMLButtonElement;
  const grantName = (form: HTMLElement, id: string) =>
    form.querySelector(`[data-grant="household"][data-principal="${id}"] span`)
      ?.textContent;

  for (const layer of ["personal", "household"] as const)
    test(`MU-S68 (Q1, ${layer} layer): a membership B5 does not name is offered, and saving sends it at THIS layer's version`, async () => {
      const t = setup({
        personal: { template: null, version: 4 },
        household: { template: { kind: "private" }, version: 7 },
        memberships: [homeOf(), second],
      });
      await waitFor(() => expect(householdForm()).toBeTruthy());
      await flush();
      // Precondition: the B5 record names only Home (the primary household); Second household is a membership it need not list.
      expect(
        t.env.defaults.record.get()?.snapshot.households.map((h) => h.id),
      ).toEqual([HOME]);
      const form = (
        layer === "personal" ? personalForm() : householdForm()
      ) as HTMLElement;
      choose(form, copy.CHOICE_EXPLICIT);
      fireEvent.click(addButton(form));
      expect(offered(form)).toEqual(["Home", "Second household"]);
      fireEvent.click(
        within(picker(form) as HTMLElement).getByRole("button", {
          name: "Second household",
        }),
      );
      expect(grantName(form, FLAT)).toBe("Second household");
      fireEvent.click(save(layer));
      await waitFor(() => expect(t.api.sent).toHaveLength(1));
      expect(t.api.sent[0]?.commands).toEqual([
        {
          kind: "set_defaults",
          household_id: layer === "personal" ? null : HOME,
          resource_kind: "field",
          expected_version: layer === "personal" ? 4 : 7,
          template: grantingSecond(),
        },
      ]);
    });

  test("MU-S68 control: the primary household (which B5 names) is offered and saved as before", async () => {
    const t = setup({
      personal: { template: null, version: 4 },
      memberships: [homeOf(), second],
    });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    await flush();
    choose(personalForm(), copy.CHOICE_EXPLICIT);
    fireEvent.click(addButton(personalForm()));
    fireEvent.click(
      within(picker(personalForm()) as HTMLElement).getByRole("button", {
        name: "Home",
      }),
    );
    fireEvent.click(save("personal"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands[0]).toMatchObject({
      household_id: null,
      expected_version: 4,
      template: {
        policy: { grants: [{ kind: "household", id: HOME, edit: false }] },
      },
    });
  });

  test("MU-S69 (Q1): with no primary household and private defaults (B5 names no household), your memberships are still offered", async () => {
    const t = setup({
      primary: null,
      personal: { template: null, version: 1 },
      memberships: [second],
    });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    await flush();
    expect(t.env.defaults.record.get()?.snapshot.households).toEqual([]);
    // The household layer stays unavailable: there is no primary household to edit.
    expect(
      document.querySelector('[data-layer="household"]')?.textContent,
    ).toBe(copy.NO_PRIMARY);
    choose(personalForm(), copy.CHOICE_EXPLICIT);
    fireEvent.click(addButton(personalForm()));
    expect(offered(personalForm())).toEqual(["Second household"]);
    fireEvent.click(
      within(picker(personalForm()) as HTMLElement).getByRole("button", {
        name: "Second household",
      }),
    );
    fireEvent.click(save("personal"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands[0]).toMatchObject({
      household_id: null,
      expected_version: 1,
      template: grantingSecond(),
    });
  });

  test("MU-S69 control: a COMPLETE empty list is the real empty state, and a granted household is one you are not in", async () => {
    setup({
      primary: null,
      personal: { template: grantingSecond(), version: 2 },
      memberships: [],
    });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    await flush();
    expect(grantName(personalForm(), FLAT)).toBe(copy.HOUSEHOLD_UNKNOWN);
    fireEvent.click(addButton(personalForm()));
    expect(picker(personalForm())?.textContent).toContain(
      copy.NO_HOUSEHOLDS_TO_ADD,
    );
  });

  test("MU-S70 (Q2): an overridden household template's grant of a household you are in is named, though B5 omits it", async () => {
    const t = setup({
      personal: { template: { kind: "private" }, version: 2 },
      household: { template: grantingSecond(), version: 5 },
      memberships: [homeOf(), second],
    });
    await waitFor(() => expect(householdForm()).toBeTruthy());
    await flush();
    // The personal layer overrides it, so the resolved field default is Private and B5 names only Home.
    expect(
      t.env.defaults.record.get()?.snapshot.households.map((h) => h.id),
    ).toEqual([HOME]);
    const form = householdForm() as HTMLElement;
    expect(grantName(form, FLAT)).toBe("Second household");
    expect(form.textContent).not.toContain(copy.HOUSEHOLD_UNKNOWN);
  });

  test("MU-S70 control: when the complete list does not name a granted household, it IS one you are not in", async () => {
    setup({
      personal: { template: { kind: "private" }, version: 2 },
      household: { template: grantingSecond(), version: 5 },
      memberships: [homeOf()],
    });
    await waitFor(() => expect(householdForm()).toBeTruthy());
    await flush();
    expect(grantName(householdForm() as HTMLElement, FLAT)).toBe(
      copy.HOUSEHOLD_UNKNOWN,
    );
  });

  test("MU-S71 (Q3): loading and failed lists prove nothing: a granted household is unchecked, nothing can be added, Try again recovers without resetting the form", async () => {
    const first = gated();
    const t = setup({
      personal: { template: grantingSecond(), version: 3 },
      membershipReads: [first.answer],
    });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    await flush();
    const form = personalForm();
    // Loading: neither "not in" nor a picker; adding waits and says why.
    expect(form.querySelector('[data-membership="loading"]')).not.toBeNull();
    expect(grantName(form, FLAT)).toBe(copy.HOUSEHOLD_UNCHECKED);
    expect(addButton(form)).toBeDisabled();
    expect(reasonOf(addButton(form))).toBe(copy.ADD_HOUSEHOLD_LOADING_REASON);
    // An unsaved change made meanwhile: Second household gets Edit.
    fireEvent.click(
      within(
        within(form).getByRole("radiogroup", {
          name: `${copy.HOUSEHOLD_UNCHECKED}: ${copy.READ} or ${copy.EDIT}`,
        }),
      ).getByRole("radio", { name: copy.EDIT }),
    );
    // A malformed answer (the reader's `uncertain`, no request id).
    first.settle({ ok: false, kind: "uncertain" });
    await flush();
    const failed = () =>
      form.querySelector<HTMLElement>('[data-membership="failed"]');
    expect(failed()?.textContent).toContain(copy.HOUSEHOLDS_FAILED);
    expect(grantName(form, FLAT)).toBe(copy.HOUSEHOLD_UNCHECKED);
    expect(form.textContent).not.toContain(copy.HOUSEHOLD_UNKNOWN);
    expect(addButton(form)).toBeDisabled();
    expect(reasonOf(addButton(form))).toBe(copy.ADD_HOUSEHOLD_FAILED_REASON);
    // A classified refusal, then success: each Try again is the membership banner's own and reads only the list.
    t.api.next.households.push(
      { ok: false, kind: "invalid", requestId: "req-memberships" },
      ok([homeOf(), second]),
    );
    fireEvent.click(
      within(failed() as HTMLElement).getByRole("button", {
        name: copy.TRY_AGAIN,
      }),
    );
    await flush();
    expect(failed()?.textContent).toContain("req-memberships");
    fireEvent.click(
      within(failed() as HTMLElement).getByRole("button", {
        name: copy.TRY_AGAIN,
      }),
    );
    await flush();
    expect(membershipReads(t.api)).toBe(3);
    expect(templateReads(t.api)).toBe(2);
    expect(failed()).toBeNull();
    expect(grantName(form, FLAT)).toBe("Second household");
    // The form was not remounted or reset: the unsaved Edit is still chosen and still unsaved.
    expect(personalForm()).toBe(form);
    expect(
      within(
        within(form).getByRole("radiogroup", {
          name: `Second household: ${copy.READ} or ${copy.EDIT}`,
        }),
      )
        .getByRole("radio", { name: copy.EDIT })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(addButton(form));
    expect(offered(form)).toEqual(["Home"]);
    fireEvent.click(save("personal"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands[0]).toMatchObject({
      expected_version: 3,
      template: grantingSecond(true),
    });
  });

  test("MU-S72 (Q4): reconnects supersede earlier membership reads; answers arriving backwards never replace the latest", async () => {
    const reads = [gated(), gated(), gated()];
    const t = setup({
      personal: { template: null, version: 1 },
      membershipReads: reads.map((read) => read.answer),
    });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    t.setSharing({ online: false });
    t.setSharing({ online: true });
    t.setSharing({ online: false });
    t.setSharing({ online: true });
    await flush();
    expect(membershipReads(t.api)).toBe(3);
    reads[2]?.settle(ok([homeOf(), second]));
    await flush();
    reads[1]?.settle(ok([homeOf()]));
    reads[0]?.settle(ok([]));
    await flush();
    choose(personalForm(), copy.CHOICE_EXPLICIT);
    fireEvent.click(addButton(personalForm()));
    expect(offered(personalForm())).toEqual(["Home", "Second household"]);
  });

  test("Q4: another identity's membership answer, held across the switch, never reaches the new identity's editor", async () => {
    const elsewhere = household({
      id: ELSEWHERE,
      name: "Only account A's",
      role: "member",
    });
    const heldA = gated();
    const t = setup({
      personal: { template: null, version: 1 },
      membershipReads: [heldA.answer],
    });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    const apiB = fakeSharingApi();
    apiB.defaults.households = ok([homeOf()]);
    t.setSharing({
      ...sharingEnv(apiB),
      identity: "99999999-9999-4999-8999-999999999999:1",
    });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    await flush();
    heldA.settle(ok([homeOf(), elsewhere]));
    await flush();
    choose(personalForm(), copy.CHOICE_EXPLICIT);
    fireEvent.click(addButton(personalForm()));
    expect(offered(personalForm())).toEqual(["Home"]);
  });

  test("MU-S73 (Q5): coming back online reads the list again (the last one names grants meanwhile); the draft, its version and the templates stay", async () => {
    const again = gated();
    const t = setup({
      personal: { template: null, version: 6 },
      membershipReads: [ok([homeOf()]), again.answer],
    });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    await flush();
    const form = personalForm();
    choose(form, copy.CHOICE_EXPLICIT);
    fireEvent.click(addButton(form));
    fireEvent.click(
      within(picker(form) as HTMLElement).getByRole("button", { name: "Home" }),
    );
    t.setSharing({ online: false });
    expect(reasonOf(save("personal"))).toBe(copy.SAVE_OFFLINE_REASON);
    t.setSharing({ online: true });
    await flush();
    expect(membershipReads(t.api)).toBe(2);
    // While the new read is under way: the last list still names Home; nothing can be added; nothing was re-read but the list.
    expect(grantName(form, HOME)).toBe("Home");
    expect(addButton(form)).toBeDisabled();
    expect(templateReads(t.api)).toBe(2);
    again.settle(ok([homeOf(), second]));
    await flush();
    expect(personalForm()).toBe(form);
    expect(chosen(form)).toBe(copy.CHOICE_EXPLICIT);
    fireEvent.click(addButton(form));
    fireEvent.click(
      within(picker(form) as HTMLElement).getByRole("button", {
        name: "Second household",
      }),
    );
    fireEvent.click(save("personal"));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands[0]).toMatchObject({
      expected_version: 6,
      template: {
        kind: "explicit",
        policy: {
          grants: [
            { kind: "household", id: HOME, edit: false },
            { kind: "household", id: FLAT, edit: false },
          ],
        },
      },
    });
  });

  test("Q5: opened offline, nothing is read; back online the list is read for the first time", async () => {
    const t = setup({ online: false, memberships: [homeOf(), second] });
    await flush();
    expect(membershipReads(t.api)).toBe(0);
    t.setSharing({ online: true });
    await waitFor(() => expect(personalForm()).toBeTruthy());
    await flush();
    expect(membershipReads(t.api)).toBe(1);
    choose(personalForm(), copy.CHOICE_EXPLICIT);
    fireEvent.click(addButton(personalForm()));
    expect(offered(personalForm())).toEqual(["Home", "Second household"]);
  });

  test("Q7: the list is editing metadata only: the B5 record (its revision evidence) is never changed by it, and B5's names stay on what B5 describes", async () => {
    const t = setup({
      personal: { template: null, version: 1 },
      household: { template: { kind: "private" }, version: 2 },
      memberships: [homeOf("Home, renamed since"), second],
    });
    const before = structuredClone(t.env.defaults.record.get());
    await waitFor(() => expect(householdForm()).toBeTruthy());
    await flush();
    choose(personalForm(), copy.CHOICE_EXPLICIT);
    fireEvent.click(addButton(personalForm()));
    expect(offered(personalForm())).toEqual([
      "Home, renamed since",
      "Second household",
    ]);
    expect(t.env.defaults.record.get()).toEqual(before);
    expect(
      document.querySelector('[data-layer="household"] h3')?.textContent,
    ).toBe(copy.HOUSEHOLD_LAYER("Home"));
  });
});
