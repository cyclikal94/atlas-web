// @vitest-environment node
import { describe, expect, test } from "vitest";
import { canonicalJson } from "../../src/data/model/canonical";
import type { DraftRow } from "../../src/data/model/types";
import {
  configureSourceRequest,
  createSourceRequest,
  importRequest,
} from "../../src/features/calendars/model/commands";
import { outboxWorld } from "../support/data/outbox-world";

/**
 * The calendar schema extension's acceptance (WEB-13a; delivery-slices "Acceptance cases for calendar command queuing" 1 and 2) through
 * the PRODUCTION facade, plans and dispatcher over the double of IndexedDB, with a scripted server and fake time:
 *
 *  - the static `/calendar-commands` endpoint: a credential-free create and a settings change, ordered (the change waits for the
 *    create's receipt), each resent after a lost response with the SAME key and the byte-identical body (case 1);
 *  - the dynamic-routing extension that WEB-13b's import will use: an import draft built at once against a still-pending source is
 *    held behind it, addressed to `/calendar-sources/{id}/import` from its `target_id`, and resent byte-identically under the same
 *    key (case 2).
 *
 * FIXTURE evidence: no backend (the I-CAL specs run the same journeys against the released one).
 */
const SOURCE = "00000000-0000-4000-8000-0000000000c5";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

async function world() {
  const w = await outboxWorld();
  // Queued before any leader runs (offline, or production before WEB-09b): nothing is sent until the dispatcher starts.
  const create = await w.outbox.enqueue(
    createSourceRequest({ id: SOURCE, label: "Chores", timezone: "UTC" }),
  );
  const configure = await w.outbox.enqueue(
    configureSourceRequest(
      { id: SOURCE, value: { timezone: "UTC" } },
      { timezone: "Europe/London", enabled: true },
    ),
  );
  const imported = await w.outbox.enqueue(
    importRequest({
      sourceId: SOURCE,
      ics: ICS,
      from: "2026-01-01",
      through: "2026-12-31",
    }),
  );
  if (
    create.kind !== "queued" ||
    configure.kind !== "queued" ||
    imported.kind !== "queued"
  )
    throw new Error("setup");
  await w.settle();
  return {
    w,
    ids: {
      create: create.localId,
      configure: configure.localId,
      imported: imported.localId,
    },
  };
}

const byId = (drafts: DraftRow[], id: string) =>
  drafts.find((d) => d.local_id === id) as DraftRow;

describe("ordering: the source before what depends on it", () => {
  test("the settings change and the import wait on the create; the import also waits on the change before it", async () => {
    const { w, ids } = await world();
    const drafts = w.drafts();
    expect(byId(drafts, ids.configure).depends_on).toEqual([ids.create]);
    expect(byId(drafts, ids.imported).depends_on).toEqual([ids.configure]);
    // The settings change is built on version 1: the version of the source the create introduces.
    expect(byId(drafts, ids.configure).expected_version).toBe(1);
    expect(byId(drafts, ids.imported)).toMatchObject({
      endpoint: "/calendar-sources/{id}/import",
      target_id: SOURCE,
      kind: "/calendar-sources/{id}/import",
    });
    expect(w.sent).toEqual([]);
  });

  test("while the create is unanswered NOTHING else is sent; then the change, then the import at its resolved address", async () => {
    const { w, ids } = await world();
    let release: (r: Response) => void = () => undefined;
    w.script.push(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    w.start();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual([ids.create]);
    release(w.receipt());
    await w.settle();
    expect(w.sent.map((s) => [s.path, s.key])).toEqual([
      ["/calendar-commands", ids.create],
      ["/calendar-commands", ids.configure],
      [`/calendar-sources/${SOURCE}/import`, ids.imported],
    ]);
    expect(JSON.parse(w.sent[1]?.body ?? "")).toEqual({
      command: {
        kind: "configure_source",
        id: SOURCE,
        expected_version: 1,
        timezone: "Europe/London",
        enabled: true,
      },
    });
    expect(w.sent[2]?.body).toBe(
      canonicalJson({ ics: ICS, from: "2026-01-01", through: "2026-12-31" }),
    );
  });

  test("a create that is refused takes its dependants with it (retained for the person, never sent)", async () => {
    const { w, ids } = await world();
    w.script.push(w.error(422, "invalid_value"));
    w.start();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual([ids.create]);
    const drafts = w.drafts();
    expect(byId(drafts, ids.create).status).toBe("rejected");
    expect(byId(drafts, ids.configure).status).toBe("rejected");
    expect(byId(drafts, ids.imported).status).toBe("rejected");
  });
});

describe("case 1 and case 2: a lost response is resent with the same key and the byte-identical body", () => {
  test("the create, the change and the import each lose their first answer; each resend is identical, and nothing is made twice", async () => {
    const { w, ids } = await world();
    const lost = () => new TypeError("Failed to fetch");
    w.script.push(lost, w.receipt(), lost, w.receipt(), lost, w.receipt(0));
    w.start();
    for (let turn = 0; turn < 40 && w.sent.length < 6; turn += 1) {
      await w.settle();
      await w.advance(60_000);
    }
    await w.settle();
    const keys = w.sent.map((s) => s.key);
    expect(keys).toEqual([
      ids.create,
      ids.create,
      ids.configure,
      ids.configure,
      ids.imported,
      ids.imported,
    ]);
    for (const pair of [0, 2, 4]) {
      expect(w.sent[pair + 1]?.body).toBe(w.sent[pair]?.body);
      expect(w.sent[pair + 1]?.path).toBe(w.sent[pair]?.path);
    }
    // A receipt of revision 0 is a receipt (case 4).
    expect(w.drafts().map((d) => d.status)).toEqual([
      "acknowledged",
      "acknowledged",
      "acknowledged",
    ]);
  });
});
