import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { EnqueueRequest } from "../../../src/data";
import {
  archiveRequestFor,
  archiveSaved,
} from "../../../src/features/people/archive";
import { REFUSED, SAVED_NOT_SENT } from "../../../src/features/people/copy";
import {
  forgetAllPeopleMemory,
  PeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import {
  fieldRow,
  type PeopleWorld,
  peopleWorld,
  person,
} from "../../support/people/world";

/**
 * Review 8, finding 2 (`people-retained-form-pending-admission`, the ledger's caller): archive and restore have ONE owner per target, the
 * identity's page memory (`features/people/archive.ts`), whichever view asks. A restore pressed in Settings → "Archived items" still runs
 * when its row is mounted again (the protected tree remounted, the page left and reopened, a field row's parent read hidden and shown):
 * the new row shows it saving and admits nothing more, and so do the detail's buttons of the same target (both ways). What it says is
 * told to the view showing the target now; a retry of the same action is the same request; after it settles the next deliberate action is
 * admitted; nothing is said under another identity. Each schedule holds the first enqueue after it was observed to start, and has its
 * control (the same row pressed again). Fixture evidence (jsdom).
 */
installMatchMedia({ width: 1440 });
beforeEach(() => {
  forgetAllPeopleMemory();
  forgetRefusedPolicies();
});
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const P = "55555555-5555-4555-8555-555555555555";
const Q = "77777777-7777-4777-8777-777777777777";
const F = "66666666-6666-4666-8666-666666666666";

/** Holds the outbox's `enqueue` until released (every call once released), recording every request it was asked to write. */
function holdEnqueue(w: PeopleWorld, options: { throws?: boolean } = {}) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const state = { entered: 0 };
  const asked: EnqueueRequest[] = [];
  const outbox = w.env.outbox();
  if (outbox === null) throw new Error("no outbox");
  const original = outbox.enqueue.bind(outbox);
  let throwing = options.throws ?? false;
  outbox.enqueue = async (...args: Parameters<typeof original>) => {
    asked.push(args[0]);
    state.entered += 1;
    await opened;
    if (throwing) {
      throwing = false;
      throw new Error("the write's answer was lost");
    }
    return original(...args);
  };
  return {
    state,
    asked,
    release: async () => {
      await act(async () => {
        open();
        await opened;
      });
    },
  };
}

const ledgerRow = (id: string) =>
  document.querySelector(`[data-archived-row="${id}"]`) as HTMLElement | null;
const ledgerRestore = async (id: string) =>
  within(
    (await waitFor(() => {
      const row = ledgerRow(id);
      expect(row).not.toBeNull();
      return row;
    })) as HTMLElement,
  ).getByRole("button", { name: "Restore" });
const header = () =>
  document.querySelector("[data-identity-header]") as HTMLElement;
const archiveCommands = (w: PeopleWorld) =>
  w.built.filter(
    (b) =>
      (b.command as { command?: { kind?: string } }).command?.kind ===
      "archive",
  );
const politeText = () =>
  [...document.querySelectorAll("[aria-live]")]
    .map((node) => node.textContent ?? "")
    .join("|");

function archivedWorld(kind: "person" | "field") {
  const w = peopleWorld();
  w.setCache(
    kind === "person"
      ? [person({ id: P, label: "Archived Ada", archived: true })]
      : [
          person({ id: P, label: "Ada" }),
          fieldRow({ id: F, parent_id: P, label: "Old note", archived: true }),
        ],
  );
  return w;
}

describe("review 8, finding 2: a pending ledger Restore keeps its claim across every remount of its row", () => {
  const causes = [
    "control: the same row pressed again",
    "the protected tree remounted",
    "the page left and opened again",
    "its parent read hidden and shown again (a field row)",
  ] as const;
  for (const kind of ["person", "field"] as const)
    for (const cause of causes) {
      if (cause.includes("parent") && kind === "person") continue;
      const id = kind === "person" ? P : F;
      test(`${kind}: ${cause} while the first restore is unsaved: Restore shows saving and one archive(false) is written`, async () => {
        const w = archivedWorld(kind);
        const g = holdEnqueue(w);
        const { router } = await w.mount("/settings/archived");
        fireEvent.click(await ledgerRestore(id));
        await waitFor(() => expect(g.state.entered).toBe(1));
        if (cause === "the protected tree remounted") {
          cleanup();
          await w.mount("/settings/archived");
        } else if (cause === "the page left and opened again") {
          await act(async () => {
            await router.navigate({ to: "/people" });
          });
          await waitFor(() => expect(ledgerRow(id)).toBeNull());
          await act(async () => {
            await router.navigate({ to: "/settings/archived" as never });
          });
        } else if (cause.includes("parent")) {
          w.setCache([
            fieldRow({
              id: F,
              parent_id: P,
              label: "Old note",
              archived: true,
            }),
          ]);
          await waitFor(() => expect(ledgerRow(id)).toBeNull());
          w.setCache([
            person({ id: P, label: "Ada" }),
            fieldRow({
              id: F,
              parent_id: P,
              label: "Old note",
              archived: true,
            }),
          ]);
        }
        const button = await ledgerRestore(id);
        expect(
          button,
          "the remounted row shows the restore saving",
        ).toBeDisabled();
        fireEvent.click(button);
        await g.release();
        await waitFor(() => expect(archiveCommands(w)).toHaveLength(1));
        expect(g.asked, "no second restore was admitted").toHaveLength(1);
      });
    }

  test("another target's Restore is not held back by one that runs", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Archived Ada", archived: true }),
      person({ id: Q, label: "Archived Bo", archived: true }),
    ]);
    const g = holdEnqueue(w);
    await w.mount("/settings/archived");
    fireEvent.click(await ledgerRestore(P));
    await waitFor(() => expect(g.state.entered).toBe(1));
    const other = await ledgerRestore(Q);
    expect(other).toBeEnabled();
    fireEvent.click(other);
    await waitFor(() => expect(g.state.entered).toBe(2));
    await g.release();
    await waitFor(() => expect(archiveCommands(w)).toHaveLength(2));
  });
});

describe("review 8, finding 2: the ledger and the detail share the target's claim", () => {
  test("restored from the ledger, then the person's detail opened: its Restore shows saving and admits nothing", async () => {
    const w = archivedWorld("person");
    const g = holdEnqueue(w);
    const { router } = await w.mount("/settings/archived");
    fireEvent.click(await ledgerRestore(P));
    await waitFor(() => expect(g.state.entered).toBe(1));
    await act(async () => {
      await router.navigate({
        to: "/people/$personId",
        params: { personId: P },
      });
    });
    const restore = await waitFor(() => {
      const button = within(header()).getByRole("button", { name: "Restore" });
      expect(button).toBeDisabled();
      return button;
    });
    fireEvent.click(restore);
    await g.release();
    await waitFor(() => expect(archiveCommands(w)).toHaveLength(1));
    expect(g.asked).toHaveLength(1);
  });

  test("restored from the detail, then the ledger opened: its Restore shows saving and admits nothing", async () => {
    const w = archivedWorld("person");
    const g = holdEnqueue(w);
    const { router } = await w.mount(`/people/${P}`);
    fireEvent.click(
      await within(header()).findByRole("button", { name: "Restore" }),
    );
    await waitFor(() => expect(g.state.entered).toBe(1));
    await act(async () => {
      await router.navigate({ to: "/settings/archived" as never });
    });
    const button = await ledgerRestore(P);
    expect(button).toBeDisabled();
    expect(button.getAttribute("aria-describedby") ?? "").not.toBe("");
    fireEvent.click(button);
    await g.release();
    await waitFor(() => expect(archiveCommands(w)).toHaveLength(1));
    expect(g.asked).toHaveLength(1);
  });

  test("the field's editor Archive and the ledger's Restore of it never run beside each other", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: F, parent_id: P, label: "Note" }),
    ]);
    const g = holdEnqueue(w);
    const { router } = await w.mount(`/people/${P}/fields/${F}`);
    const d = await screen.findByRole("dialog", { name: "Edit Note" });
    fireEvent.click(within(d).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(g.state.entered).toBe(1));
    await act(async () => {
      await router.navigate({
        to: "/people/$personId",
        params: { personId: P },
      });
    });
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-field-row="${F}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(row).getByRole("button", { name: "Archive" })).toBeDisabled();
    await g.release();
    await waitFor(() => expect(archiveCommands(w)).toHaveLength(1));
    expect(g.asked).toHaveLength(1);
  });
});

describe("review 8, finding 2: what a restore says, and to whom", () => {
  for (const answer of ["refused", "threw"] as const)
    test(`${answer === "refused" ? "refused (quota)" : "threw before writing"} after the tree remounted: told to the remounted row, which admits the retry as the SAME request`, async () => {
      const w = archivedWorld("person");
      if (answer === "refused")
        w.outcomes.push({ kind: "refused", reason: "quota" });
      const g = holdEnqueue(w, { throws: answer === "threw" });
      await w.mount("/settings/archived");
      fireEvent.click(await ledgerRestore(P));
      await waitFor(() => expect(g.state.entered).toBe(1));
      cleanup();
      await w.mount("/settings/archived");
      await g.release();
      await waitFor(() =>
        expect(
          within(ledgerRow(P) as HTMLElement).queryByText(
            answer === "refused" ? REFUSED.quota : REFUSED.storage,
          ),
          "the refusal is told to the row showing the target now",
        ).not.toBeNull(),
      );
      expect(archiveCommands(w)).toHaveLength(0);
      const retry = await ledgerRestore(P);
      expect(retry).toBeEnabled();
      fireEvent.click(retry);
      await waitFor(() => expect(archiveCommands(w)).toHaveLength(1));
      expect(g.asked).toHaveLength(2);
      expect(g.asked[1]?.localId).toBeDefined();
      expect(g.asked[1]?.localId, "a retry is the same request").toBe(
        g.asked[0]?.localId,
      );
    });

  test("saved while the tree was remounted: said once it is saved, and no earlier refusal stays", async () => {
    const w = archivedWorld("person");
    const g = holdEnqueue(w);
    await w.mount("/settings/archived");
    fireEvent.click(await ledgerRestore(P));
    await waitFor(() => expect(g.state.entered).toBe(1));
    cleanup();
    await w.mount("/settings/archived");
    await g.release();
    await waitFor(() => expect(politeText()).toContain(SAVED_NOT_SENT));
    expect(archiveCommands(w)).toHaveLength(1);
  });

  test("another identity is shown before the restore answers: nothing is said, and the new identity holds no claim", async () => {
    const w = archivedWorld("person");
    const g = holdEnqueue(w);
    await w.mount("/settings/archived");
    fireEvent.click(await ledgerRestore(P));
    await waitFor(() => expect(g.state.entered).toBe(1));
    const old = peopleMemory(w.people.identity);
    const next = peopleMemory("someone-else:1");
    expect(next).not.toBe(old);
    await g.release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(politeText()).not.toContain(SAVED_NOT_SENT);
    expect(next.pending.size).toBe(0);
    expect(next.actionReports.size).toBe(0);
    expect(old.actionReports.size).toBe(0);
  });
});

describe("review 8, finding 2: the request an archive or restore is made as", () => {
  test("the same action on the same version is the same request until it is saved; another action, version or a later one is new", () => {
    const memory = new PeopleMemory("me:1");
    let n = 0;
    const newId = () => `id-${++n}`;
    const restore = archiveRequestFor(memory, P, false, 3, newId);
    expect(restore.localId).toBe("id-1");
    expect(archiveRequestFor(memory, P, false, 3, newId).localId).toBe("id-1");
    // The opposite action, or the same one on another version, is a new request.
    expect(archiveRequestFor(memory, P, true, 3, newId).localId).toBe("id-2");
    expect(archiveRequestFor(memory, P, true, 4, newId).localId).toBe("id-3");
    // Saved: spent; the next deliberate action is new even on the same version.
    archiveSaved(memory, P);
    expect(archiveRequestFor(memory, P, true, 4, newId).localId).toBe("id-4");
    // Another target has its own.
    expect(archiveRequestFor(memory, Q, true, 4, newId).localId).toBe("id-5");
  });
});
