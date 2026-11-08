import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { ME, MO } from "../../support/people/records";
import { peopleWorld, person } from "../../support/people/world";

/**
 * WF-PEOPLE-01 (A1): rows from the cache with this device's outstanding saves folded in, sort, search, the Archived filter, the states
 * (Loading, Empty, Offline-first-visit, Error), and the account line from the viewer-safe summaries, never a per-person read (D-11a-20).
 * jsdom with axe; fixture evidence.
 */
const media = installMatchMedia({ width: 1440 });
beforeEach(() => {
  forgetAllPeopleMemory();
  forgetRefusedPolicies();
});
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const ids = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
  );

const rowNames = () =>
  [...document.querySelectorAll("[data-person-row]")].map(
    (row) => row.querySelector("span span")?.textContent,
  );

describe("the people list", () => {
  test("sorted by name, searchable over names, archived people only under 'Archived'; axe clean", async () => {
    const w = peopleWorld();
    const [a, b, c, d] = ids(4);
    w.setCache([
      person({ id: a, label: "mo" }),
      person({ id: b, label: "Ada" }),
      person({ id: c, label: "Bo Archived", archived: true }),
      person({ id: d, label: "  Zed  Smith " }),
    ]);
    await w.mount("/people");
    await waitFor(() =>
      expect(rowNames()).toEqual(["Ada", "mo", "  Zed  Smith "]),
    );
    const main = screen.getByRole("main");
    expect(
      within(main).getByRole("heading", { level: 1, name: "People" }),
    ).toBeInTheDocument();
    expect((await axe(main)).violations).toEqual([]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search people" }), {
      target: { value: "zed smith" },
    });
    expect(rowNames()).toEqual(["  Zed  Smith "]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search people" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(rowNames()).toEqual(["Bo Archived"]);
    expect(screen.getByRole("button", { name: "Archived" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("a new person saved on this device (queued) is listed, marked 'Not sent yet'", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.setDrafts([
      draftRow({
        local_id: "c1",
        created_seq: 1,
        command: {
          commands: [
            { kind: "create_person", id: ids(1)[0] as string, name: "Ada" },
          ],
        },
      }),
    ]);
    await w.mount("/people");
    await waitFor(() => expect(rowNames()).toEqual(["Ada"]));
    expect(document.querySelector("[data-pending]")).toHaveTextContent(
      "Not sent yet",
    );
  });

  test("Empty needs a completed sync; before the first sync it is the offline-first-visit state, never 'No one here yet'", async () => {
    const w = peopleWorld({ online: false });
    w.env.set({ cache: "empty", online: false });
    w.setCache([]);
    await w.mount("/people");
    expect(
      await screen.findByText(
        /You're offline and this device hasn't synced yet/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No one here yet/)).toBeNull();
    // New person is still offered.
    expect(
      within(
        document.querySelector("[data-people-state]") as HTMLElement,
      ).getByRole("button", { name: "New person" }),
    ).toBeEnabled();
    cleanup();
    const synced = peopleWorld();
    synced.setCache([]);
    await synced.mount("/people");
    expect(await screen.findByText(/No one here yet/)).toBeInTheDocument();
  });

  test("a store that fails shows the Er banner with Try again, never an empty list", async () => {
    const w = peopleWorld();
    w.failReads();
    await w.mount("/people");
    // The banner's own text: the announcer's assertive region repeats it a frame later.
    expect(
      await screen.findByText("Couldn't load people on this device.", {
        selector: "[data-people-banner] p",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(w.env.calls.map((c) => c.action)).toContain("retryLoad");
  });

  test("the account line comes from the summaries, one bounded read per step; the list makes no person read (finding 8)", async () => {
    const w = peopleWorld();
    const people = ids(30).map((id, i) =>
      person({ id, label: `P${String(i).padStart(2, "0")}` }),
    );
    w.setCache(people);
    w.api.linked.set(people[0]?.id as string, ME);
    w.api.linked.set(people[1]?.id as string, MO);
    await w.mount("/people");
    await waitFor(() =>
      expect(document.querySelectorAll("[data-person-linkage]").length).toBe(
        30,
      ),
    );
    expect(w.api.calls.filter((c) => c.op === "readPerson")).toEqual([]);
    expect(w.api.calls.filter((c) => c.op === "readSummaries")).toEqual([
      {
        op: "readSummaries",
        args: ["all", { after: null, limit: 100, archived: false }],
      },
    ]);
    expect(
      document.querySelector(`[data-person-row="${people[0]?.id}"]`),
    ).toHaveTextContent("Linked to your account");
    expect(
      document.querySelector(`[data-person-row="${people[1]?.id}"]`),
    ).toHaveTextContent("Linked · they control their name");
    expect(
      document.querySelector(`[data-person-row="${people[29]?.id}"]`),
    ).toHaveTextContent("Not linked to an account");
    // Leaving and coming back within the same invalidation generation does not ask again (page memory for this identity).
    cleanup();
    await w.mount("/people");
    await waitFor(() => expect(rowNames()).toHaveLength(30));
    expect(document.querySelectorAll("[data-person-linkage]").length).toBe(30);
    expect(w.api.calls.filter((c) => c.op === "readSummaries")).toHaveLength(1);
  });

  test("offline, nothing is read and no linkage is claimed", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([person({ id: ids(1)[0], label: "Ada" })]);
    await w.mount("/people");
    await waitFor(() => expect(rowNames()).toEqual(["Ada"]));
    expect(w.api.calls).toEqual([]);
    expect(document.querySelector("[data-person-linkage]")).toBeNull();
  });

  test("a person is a page of their own at every width: no list beside it, the name as the heading, the breadcrumb back", async () => {
    const w = peopleWorld();
    const [a] = ids(1);
    w.setCache([person({ id: a, label: "Ada" })]);
    for (const width of [1440, 834]) {
      cleanup();
      media.set({ width });
      await w.mount(`/people/${a}`);
      // The detail is its own lazy route component.
      await waitFor(() =>
        expect(
          document.querySelector(`[data-person-detail="${a}"]`),
        ).not.toBeNull(),
      );
      expect(document.querySelector("[data-people-list]")).toBeNull();
      expect(
        screen.getByRole("heading", { level: 1, name: "Ada" }),
      ).toBeInTheDocument();
      // The way back (the Final design): the breadcrumb to the people, hidden on the phone where the shell's header carries it.
      const crumbs = document.querySelector("[data-breadcrumb]") as HTMLElement;
      expect(crumbs).not.toBeNull();
      expect(within(crumbs).getByRole("link")).toHaveAttribute(
        "href",
        "/people",
      );
    }
  });
});

describe("how things open: a person in the chosen container", () => {
  test("with the split pane chosen, a row opens the person beside the people at /people?person=; the people keep their heading", async () => {
    const w = peopleWorld();
    const [a] = ids(1);
    w.setCache([person({ id: a, label: "Ada" })]);
    await w.mount("/people", { wrapper: "split" });
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-person-row="${a}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row.getAttribute("href")).toBe(`/people?person=${a}`);
    fireEvent.click(row);
    await waitFor(() =>
      expect(document.querySelector("[data-task-pane=split]")).not.toBeNull(),
    );
    await waitFor(() =>
      expect(
        document.querySelector(`[data-person-detail="${a}"]`),
      ).not.toBeNull(),
    );
    expect(document.querySelector("[data-people-list]")).not.toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "People" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Ada" }),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-breadcrumb]")).toBeNull();
  });
});
