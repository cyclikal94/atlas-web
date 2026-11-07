// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  parsePersonDetail,
  parseProjectionPage,
} from "../../src/features/people/api";
import { parsePersonActivityPage } from "../../src/features/people/model/activity";
import { parseIncomingRequests } from "../../src/features/people/model/requests";
import {
  parsePersonSummary,
  parsePersonSummaryDetail,
  parseSummaryPage,
} from "../../src/features/people/model/summary";
import {
  parseHouseholds,
  parseInvitations,
  parseTemplateScope,
} from "../../src/features/sharing/api";
import { parseDependencyGraph } from "../../src/features/tasks/model/contract";
import {
  API,
  managedHousehold,
  seededPerson,
  seededTaskDay,
  sharingReads,
  taskDayReads,
} from "../e2e/pwa-reads";

/**
 * WEB-14a revision 57 (Review 57, F-R57-2; design assessment of 6 November 2026, C-H4, I-R2, Q-H3): every canned body the PWA generation
 * world serves for a seeded entity (`tests/e2e/pwa-reads.ts`) is accepted by the PRODUCT's own strict parser for that read, with the
 * page's own query, so a drifting shape fails here, not as a silent "uncertain" screen in a browser (which no 404 oracle or console guard
 * sees). Each read the builder answers is listed: a read added without a parser check fails the inventory below.
 */
const PERSON = "71717171-7171-4171-8171-717171717171";
const OWNER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

describe("revision 57 (C-H4, Q-H3): the seeded worlds' canned reads are what the product parses", () => {
  const person = seededPerson({
    id: PERSON,
    label: "Ada Lovelace",
    owner: { account_id: OWNER, username: "alice" },
  });
  const read = (path: string) => person.reads[`${API}${path}`];

  test("a seeded person: each People read of the list and the person's page parses, about that person", () => {
    const page = parseSummaryPage(
      read("/people/summaries"),
      { after: null, limit: 50, archived: false },
      parsePersonSummary,
    );
    expect(page?.items.map((item) => item.id)).toEqual([PERSON]);
    expect(parsePersonDetail(read(`/people/${PERSON}`))?.person.id).toBe(
      PERSON,
    );
    expect(
      parsePersonSummaryDetail(read(`/people/${PERSON}/summary`))?.summary.id,
    ).toBe(PERSON);
    expect(
      parseProjectionPage(read(`/people/${PERSON}/duplicates`), 50),
    ).not.toBeNull();
    expect(parseIncomingRequests(read("/people/requests"))).toEqual([]);
    // Accepted WEB-19's timeline asks for 5 (`limit=5`); the answer must be about the seeded person (another id shows the merged view).
    const activity = parsePersonActivityPage(
      read(`/people/${PERSON}/activity`),
      5,
    );
    expect(activity?.person_id).toBe(PERSON);
    expect(activity?.items).toEqual([]);
  });

  test("a seeded person: the builder answers exactly the six reads checked above", () => {
    expect(Object.keys(person.reads).sort()).toEqual(
      [
        "/people/requests",
        "/people/summaries",
        `/people/${PERSON}`,
        `/people/${PERSON}/activity`,
        `/people/${PERSON}/duplicates`,
        `/people/${PERSON}/summary`,
      ]
        .map((path) => `${API}${path}`)
        .sort(),
    );
  });

  test("the sharing screens, with and without a managed household: templates, memberships and invitations parse", () => {
    for (const households of [
      [],
      [managedHousehold("66666666-6666-4666-8666-666666666660", "R52 House")],
    ]) {
      const reads = sharingReads(households);
      expect(Object.keys(reads).sort()).toEqual(
        ["/defaults/templates", "/households", "/invitations"]
          .map((path) => `${API}${path}`)
          .sort(),
      );
      expect(
        parseTemplateScope(reads[`${API}/defaults/templates`]),
      ).not.toBeNull();
      expect(parseHouseholds(reads[`${API}/households`])).toHaveLength(
        households.length,
      );
      expect(parseInvitations(reads[`${API}/invitations`])).toEqual([]);
    }
  });

  test("WEB-18 merge (7 November 2026): a seeded task day's editing graph read parses as the editor reads it (depth one), the day alone at its cached version, editable", async () => {
    const day = await seededTaskDay({
      taskId: "aaaaaaaa-0000-4000-8000-0000000000a1",
      executionId: "aaaaaaaa-0000-4000-8000-0000000000a2",
      title: "Hang the washing",
    });
    const graph = parseDependencyGraph(
      taskDayReads(day)[
        `${API}/occurrences/${day.occurrenceId}/dependency-graph`
      ],
      { rootId: day.occurrenceId, maxDepth: 1 },
    );
    expect(graph, "the product's own parser accepts it").not.toBeNull();
    expect(graph?.nodes[0]?.occurrence_id).toBe(day.occurrenceId);
    expect(graph?.nodes[0]?.version).toBe(1);
    expect(graph?.nodes[0]?.can_edit).toBe(true);
    expect(graph?.direct_prerequisites).toEqual([]);
  });
});
