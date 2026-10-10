import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AnnouncerProvider } from "../../src/components/ui/announcer";
import {
  buildSnapshot,
  isSensitiveField,
  restoreSnapshot,
  SensitiveFieldError,
} from "../../src/lib/form-recovery/guard";
import { MemoryRecoveryAdapter } from "../../src/lib/form-recovery/memory-adapter";
import {
  RESTORED_TEXT,
  RecoveryBanner,
  SAVE_FAILED_TEXT,
  SAVE_REFUSED_TEXT,
} from "../../src/lib/form-recovery/RecoveryBanner";
import {
  UPDATE_TEXT,
  UpdatePrompt,
} from "../../src/lib/form-recovery/UpdatePrompt";

afterEach(cleanup);

function makeForm(html: string): HTMLFormElement {
  const form = document.createElement("form");
  form.innerHTML = html;
  document.body.append(form);
  return form;
}
afterEach(() => {
  document.body.innerHTML = "";
});

const allow = [{ name: "title" }, { name: "note" }];
const base = { formContext: "task-edit:42", tabInstanceId: "tab-a", allow };

describe("guard", () => {
  test("captures only allow-listed fields", () => {
    const form = makeForm(
      '<input name="title" value="Water plants"><textarea name="note">3 L</textarea><input name="extra" value="never">',
    );
    const snapshot = buildSnapshot({ ...base, form, strict: true });
    expect(snapshot.values).toEqual({ title: "Water plants", note: "3 L" });
    expect(snapshot.values).not.toHaveProperty("extra");
  });

  test("a field added later without updating the allow-list is not captured", () => {
    const form = makeForm(
      '<input name="title" value="a"><input name="added-later" value="b">',
    );
    expect(buildSnapshot({ ...base, form, strict: true }).values).toEqual({
      title: "a",
    });
  });

  test.each([
    ["type=password", '<input name="title" type="password" value="x">'],
    [
      "autocomplete=current-password",
      '<input name="title" autocomplete="current-password" value="x">',
    ],
    [
      "autocomplete=new-password",
      '<input name="title" autocomplete="new-password" value="x">',
    ],
    [
      "autocomplete=one-time-code",
      '<input name="title" autocomplete="one-time-code" value="x">',
    ],
    [
      "a token among others",
      '<input name="title" autocomplete="section-a one-time-code" value="x">',
    ],
    [
      "data-atlas-sensitive",
      '<input name="title" data-atlas-sensitive value="x">',
    ],
  ])("refuses %s: throws in development", (_name, html) => {
    const form = makeForm(html);
    expect(() => buildSnapshot({ ...base, form, strict: true })).toThrow(
      SensitiveFieldError,
    );
  });

  test("in production the sensitive field is dropped instead of throwing", () => {
    const form = makeForm(
      '<input name="title" type="password" value="hunter2"><textarea name="note">ok</textarea>',
    );
    const snapshot = buildSnapshot({ ...base, form, strict: false });
    expect(snapshot.values).toEqual({ note: "ok" });
    expect(JSON.stringify(snapshot)).not.toContain("hunter2");
  });

  test("a connection secret marked data-atlas-sensitive is never saved", () => {
    const form = makeForm(
      '<input name="title" data-atlas-sensitive value="https://calendar/secret-token"><textarea name="note">n</textarea>',
    );
    expect(
      JSON.stringify(buildSnapshot({ ...base, form, strict: false })),
    ).not.toContain("secret-token");
  });

  test("isSensitiveField recognises the same set", () => {
    const input = document.createElement("input");
    expect(isSensitiveField(input)).toBe(false);
    input.type = "password";
    expect(isSensitiveField(input)).toBe(true);
  });

  test("restore fills the allow-listed fields, skips sensitive ones and never submits", () => {
    const form = makeForm(
      '<input name="title"><input name="note" type="password"><button type="submit">Go</button>',
    );
    const submit = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener("submit", submit);
    restoreSnapshot(
      form,
      {
        formContext: "c",
        tabInstanceId: "t",
        savedAt: "x",
        values: { title: "Restored", note: "secret" },
      },
      allow,
    );
    expect((form.elements.namedItem("title") as HTMLInputElement).value).toBe(
      "Restored",
    );
    expect((form.elements.namedItem("note") as HTMLInputElement).value).toBe(
      "",
    );
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("MemoryRecoveryAdapter (a fixture, not the real store)", () => {
  const snapshot = (tab: string, title: string) => ({
    formContext: "task-edit:42",
    tabInstanceId: tab,
    values: { title },
    savedAt: "2026-09-28T12:00:00Z",
  });

  test("two tabs on one form stay separate (compound key)", async () => {
    const adapter = new MemoryRecoveryAdapter();
    await adapter.save(snapshot("tab-a", "from A"));
    await adapter.save(snapshot("tab-b", "from B"));
    expect((await adapter.load("task-edit:42", "tab-a"))?.values.title).toBe(
      "from A",
    );
    expect((await adapter.load("task-edit:42", "tab-b"))?.values.title).toBe(
      "from B",
    );
  });

  test("a save refused while the account is signing out reports refused and writes nothing (D-16)", async () => {
    const adapter = new MemoryRecoveryAdapter();
    adapter.refuseSaves = true;
    expect(await adapter.save(snapshot("tab-a", "x"))).toBe("refused");
    expect(await adapter.load("task-edit:42", "tab-a")).toBeNull();
  });

  test("a save that fails reports failed, then succeeds on retry", async () => {
    const adapter = new MemoryRecoveryAdapter();
    adapter.failSaves = true;
    expect(await adapter.save(snapshot("tab-a", "x"))).toBe("failed");
    expect(await adapter.load("task-edit:42", "tab-a")).toBeNull();
    adapter.failSaves = false;
    expect(await adapter.save(snapshot("tab-a", "x"))).toBe("saved");
    expect((await adapter.load("task-edit:42", "tab-a"))?.values.title).toBe(
      "x",
    );
  });

  test("discard clears", async () => {
    const adapter = new MemoryRecoveryAdapter();
    await adapter.save(snapshot("tab-a", "x"));
    await adapter.discard("task-edit:42", "tab-a");
    expect(await adapter.load("task-edit:42", "tab-a")).toBeNull();
  });

  test("stored snapshots are copies", async () => {
    const adapter = new MemoryRecoveryAdapter();
    const s = snapshot("tab-a", "x");
    await adapter.save(s);
    s.values.title = "mutated";
    expect((await adapter.load("task-edit:42", "tab-a"))?.values.title).toBe(
      "x",
    );
  });
});

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const withAnnouncer = (node: React.ReactNode) => (
  <AnnouncerProvider>{node}</AnnouncerProvider>
);

describe("UpdatePrompt (state 1)", () => {
  test("offers Save and reload and Not now, announces itself politely, and does nothing by itself", async () => {
    const onSaveAndReload = vi.fn();
    const onNotNow = vi.fn();
    const { container } = render(
      withAnnouncer(
        <UpdatePrompt onSaveAndReload={onSaveAndReload} onNotNow={onNotNow} />,
      ),
    );
    expect(screen.getAllByText(UPDATE_TEXT)).toHaveLength(1);
    await act(frame);
    expect(screen.getByRole("status")).toHaveTextContent(UPDATE_TEXT);
    expect(onSaveAndReload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onNotNow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save and reload" }));
    expect(onSaveAndReload).toHaveBeenCalledTimes(1);
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe("RecoveryBanner", () => {
  test("state 2, save failed: keeps the form open, announces assertively, and offers Retry save and Discard and reload anyway", async () => {
    const onRetry = vi.fn();
    const onDiscardAndReload = vi.fn();
    const { container } = render(
      withAnnouncer(
        <RecoveryBanner
          state={{ kind: "save-failed", onRetry, onDiscardAndReload }}
        />,
      ),
    );
    expect(screen.getAllByText(SAVE_FAILED_TEXT)).toHaveLength(1);
    await act(frame);
    expect(screen.getByRole("alert")).toHaveTextContent(SAVE_FAILED_TEXT);
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDiscardAndReload).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Discard and reload anyway" }),
    );
    expect(onDiscardAndReload).toHaveBeenCalledTimes(1);
    expect((await axe(container)).violations).toEqual([]);
  });

  test("state 2b, save refused while signing out (D-16): keeps the form open, announces assertively, and offers only Discard and reload anyway (there is nothing to retry)", async () => {
    const onDiscardAndReload = vi.fn();
    const { container } = render(
      withAnnouncer(
        <RecoveryBanner state={{ kind: "save-refused", onDiscardAndReload }} />,
      ),
    );
    expect(screen.getAllByText(SAVE_REFUSED_TEXT)).toHaveLength(1);
    await act(frame);
    expect(screen.getByRole("alert")).toHaveTextContent(SAVE_REFUSED_TEXT);
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Discard and reload anyway" }),
    );
    expect(onDiscardAndReload).toHaveBeenCalledTimes(1);
    expect((await axe(container)).violations).toEqual([]);
  });

  test("state 3, restored: says nothing was submitted, offers Discard instead, and focus goes to the first field, not the banner", async () => {
    const firstFieldRef = createRef<HTMLInputElement>();
    const onDiscard = vi.fn();
    const { container } = render(
      withAnnouncer(
        <>
          <RecoveryBanner
            state={{ kind: "restored", onDiscard }}
            firstFieldRef={firstFieldRef}
          />
          <input ref={firstFieldRef} aria-label="Title" />
        </>,
      ),
    );
    expect(
      screen.getAllByText(/Nothing was submitted automatically/),
    ).toHaveLength(1);
    expect(screen.getByLabelText("Title")).toHaveFocus();
    await act(frame);
    expect(screen.getByRole("status")).toHaveTextContent(RESTORED_TEXT);
    fireEvent.click(screen.getByRole("button", { name: "Discard instead" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect((await axe(container)).violations).toEqual([]);
  });

  test("both banners can be on screen without a duplicate-landmark problem", async () => {
    const { container } = render(
      withAnnouncer(
        <>
          <RecoveryBanner
            state={{
              kind: "save-failed",
              onRetry: () => {},
              onDiscardAndReload: () => {},
            }}
          />
          <RecoveryBanner state={{ kind: "restored", onDiscard: () => {} }} />
        </>,
      ),
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  test("the banners never submit or reload by themselves", () => {
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      value: { ...originalLocation, reload },
      configurable: true,
    });
    render(
      withAnnouncer(
        <RecoveryBanner
          state={{
            kind: "save-failed",
            onRetry: () => {},
            onDiscardAndReload: () => {},
          }}
        />,
      ),
    );
    expect(reload).not.toHaveBeenCalled();
    Object.defineProperty(window, "location", {
      value: originalLocation,
      configurable: true,
    });
  });
});
