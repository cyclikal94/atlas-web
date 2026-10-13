import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as copy from "../../../src/features/calendars/copy";
import {
  OBSERVE_LIMIT_MS,
  OBSERVE_POLL_MS,
} from "../../../src/features/calendars/model/observation";
import { StampedRequestError } from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import {
  atlasBody,
  calendarWorld,
  sourceRow,
  type WireReply,
} from "../../support/calendars";

/**
 * Revision 5 (R11; design assessment C1-C4, Q1-Q3, Q6, Q7): what the Calendars screen reads by itself (the live list and the
 * capability) is read once per VISIT. An Atlas `403` makes the session unmount the protected tree and mount it again at the same address
 * under the same identity; `remount()` does exactly that to the PRODUCTION screen (a new router and a new screen; the document and the
 * per-identity memory stay). The session double does not remount by itself: the real composition is qualified natively (E-CAL14).
 *
 * The 5 s pace and the 75 s limit are the production ones, on fake timers (`setTimeout` only; the database double's `setImmediate`
 * stays real).
 */
installMatchMedia({ width: 1440 });
// Production-paced polls and remounts settle through the database double in real time: each case may take tens of seconds.
vi.setConfig({ testTimeout: 60_000 });
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

type World = Awaited<ReturnType<typeof calendarWorld>>;
const SOURCE = "00000000-0000-4000-8000-0000000000a1";
const live = (flag: boolean): WireReply => ({
  status: 200,
  json: {
    items: [
      {
        id: SOURCE,
        kind: "calendar_source",
        value: {
          health: "healthy",
          last_success: 1_790_000_000,
          refresh_in_progress: flag,
        },
      },
    ],
    next_after: null,
  },
});
const forbidden: WireReply = { status: 403, json: atlasBody("forbidden") };
const reads = (w: World) =>
  w.calls.filter((c) => c.method === "GET" && c.path === "/calendar-sources");
const capabilityReads = (w: World) =>
  w.calls.filter((c) => c.path === "/notification-capabilities");
const sends = (w: World) => w.calls.filter((c) => c.method === "POST");
const row = () =>
  document.querySelector(`[data-source-row="${SOURCE}"]`) as HTMLElement;
/** The screen's heading (hidden from the accessibility tree while a modal dialog is open). */
const heading = () =>
  screen.getByRole("heading", {
    level: 1,
    name: "Calendar sources",
    hidden: true,
  });
const fake = () =>
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setTimeout", "clearTimeout"],
  });
const elapse = async (w: World, ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await w.settle();
};
/** The session's re-check: the tree is unmounted and mounted again; asserts it really was (a new heading element). */
const remount = async (w: World) => {
  const before = heading();
  await w.remount();
  expect(heading()).not.toBe(before);
  expect(w.path()).toBe("/settings/calendars");
};
function held() {
  let release: (reply: WireReply) => void = () => undefined;
  const wait = new Promise<WireReply>((resolve) => {
    release = resolve;
  });
  return { reply: { wait } as WireReply, release };
}

describe("a refused automatic read is not made again by the remount it causes (R11, Q1, Q2)", () => {
  test("Q1: the first read refused 403, then six remounts: ONE list read and ONE capability read in all; nothing sent", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [
        ["/calendar-sources", Array.from({ length: 7 }, () => forbidden)],
      ],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("unknown"));
    for (let i = 0; i < 6; i += 1) {
      await remount(w);
      expect(row().dataset.observation).toBe("unknown");
      await elapse(w, OBSERVE_POLL_MS);
    }
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(1);
    expect(capabilityReads(w)).toHaveLength(1);
    expect(sends(w)).toEqual([]);
    // Nothing is said for a read that never saw it running, and Refresh is available.
    expect(row().querySelector("[data-observed]")).toBeNull();
    expect(
      within(row()).getByRole("button", { name: "Refresh Family calendar" }),
    ).toBeEnabled();
  });

  test("Q1, the answer arriving after the remount: the remounted screen shows it; one read, then the 5 s pace", async () => {
    fake();
    const hold = held();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [hold.reply, live(false)]]],
    });
    expect(row().dataset.observation).toBe("checking");
    await remount(w);
    expect(reads(w)).toHaveLength(1);
    hold.release(live(true) as never);
    await w.settle();
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    expect(row().querySelector("[data-observed]")).toHaveTextContent(
      copy.REFRESHING,
    );
    expect(reads(w)).toHaveLength(1);
    await elapse(w, OBSERVE_POLL_MS);
    expect(reads(w)).toHaveLength(2);
    await waitFor(() => expect(row().dataset.observation).toBe("idle"));
  });

  test("Q2: busy, then the poll refused 403 with Manage open and edited: the remount closes Manage (the required protective closure); it says it could not check; no further read", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [live(true), forbidden, live(true)]]],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    fireEvent.click(
      within(row()).getByRole("button", { name: "Manage Family calendar" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(copy.TIMEZONE), {
      target: { value: "Asia/Tokyo" },
    });
    await elapse(w, OBSERVE_POLL_MS);
    expect(reads(w)).toHaveLength(2);
    await remount(w);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain("Asia/Tokyo");
    await waitFor(() => expect(row().dataset.observation).toBe("unconfirmed"));
    expect(row().querySelector("[data-observed]")).toHaveTextContent(
      copy.OBSERVED_UNCONFIRMED,
    );
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(2);
    expect(sends(w)).toEqual([]);
    expect(w.rows("drafts")).toEqual([]);
  });

  test("Q2 control: the poll refused 503 (no remount): Manage stays open with the edit; it says it could not check; no further read", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [
        [
          "/calendar-sources",
          [live(true), { status: 503, json: atlasBody("unavailable") }],
        ],
      ],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    fireEvent.click(
      within(row()).getByRole("button", { name: "Manage Family calendar" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(copy.TIMEZONE), {
      target: { value: "Asia/Tokyo" },
    });
    await elapse(w, OBSERVE_POLL_MS);
    await waitFor(() => expect(row().dataset.observation).toBe("unconfirmed"));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByLabelText(copy.TIMEZONE)).toHaveValue(
      "Asia/Tokyo",
    );
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(2);
  });

  test("Q2 control: idle, then a remount: nothing is read again (the visit goes on), the row stays idle", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [live(false), live(true)]]],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("idle"));
    await remount(w);
    expect(row().dataset.observation).toBe("idle");
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(1);
    expect(capabilityReads(w)).toHaveLength(1);
  });

  test("Q7: busy, then remounts while it polls: the time limit is still the first walk's (it ends by 75 s), and nothing is read after it", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [
        ["/calendar-sources", Array.from({ length: 30 }, () => live(true))],
      ],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    for (let t = 0; t < OBSERVE_LIMIT_MS; t += 3 * OBSERVE_POLL_MS) {
      await elapse(w, 2 * OBSERVE_POLL_MS + 1);
      await remount(w);
      await elapse(w, OBSERVE_POLL_MS - 1);
    }
    await waitFor(() => expect(row().dataset.observation).toBe("unconfirmed"));
    const count = reads(w).length;
    expect(count).toBeGreaterThan(1);
    expect(count).toBeLessThanOrEqual(16);
    await elapse(w, 2 * OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(count);
    expect(sends(w)).toEqual([]);
  });
});

describe("a read the session never sent is not consumed (revision 5; native E-CAL4 two-tab failure, campaign 3)", () => {
  test("the first read refused at the session's cover (closed before its send boundary): nothing more on this screen; the screen mounted next reads it once and shows Refreshing…", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [
        [
          "/calendar-sources",
          [{ throws: new StampedRequestError("closed") }, live(true)],
        ],
      ],
    });
    await elapse(w, OBSERVE_POLL_MS);
    expect(reads(w)).toHaveLength(1);
    expect(row().dataset.observation).toBe("checking");
    await remount(w);
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    expect(row().querySelector("[data-observed]")).toHaveTextContent(
      copy.REFRESHING,
    );
    expect(reads(w)).toHaveLength(2);
    expect(sends(w)).toEqual([]);
  });

  test("control: the first read refused 403 (sent and answered): the next screen reads nothing", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [forbidden, live(true)]]],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("unknown"));
    await remount(w);
    await elapse(w, OBSERVE_POLL_MS);
    expect(reads(w)).toHaveLength(1);
  });
});

describe("a press refused 403 across the remount it causes (Q4)", () => {
  test("the screen's read held, the press's 403 answered only after the remount: the remounted screen shows the press's outcome, the late read changes nothing, nothing is read or sent again", async () => {
    fake();
    const read = held();
    const press = held();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [
        ["/calendar-sources", [read.reply]],
        ["/calendar-sources/{id}/refresh", [press.reply]],
      ],
    });
    fireEvent.click(
      within(row()).getByRole("button", { name: "Refresh Family calendar" }),
    );
    await w.settle();
    expect(row().dataset.observation).toBe("none");
    // The session's re-check: the tree is remounted before the refusal reaches the press's (now disposed) controller.
    await remount(w);
    expect(row()).not.toHaveTextContent(copy.SOURCE_GONE);
    press.release(forbidden as never);
    await w.settle();
    await waitFor(() => expect(row()).toHaveTextContent(copy.SOURCE_GONE));
    read.release(live(true) as never);
    await w.settle();
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(row().dataset.observation).toBe("none");
    expect(row()).not.toHaveTextContent(copy.REFRESHING);
    expect(reads(w)).toHaveLength(1);
    expect(
      w.calls.filter((c) => c.path === "/calendar-sources/{id}/refresh"),
    ).toHaveLength(1);
  });
});

describe("the capability read (DA-1, Q3)", () => {
  test("refused 403: read once in the visit, however often the screen is remounted; unknown pre-disables nothing", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [
        [
          "/notification-capabilities",
          Array.from({ length: 7 }, () => forbidden),
        ],
        ["/calendar-sources", [live(false)]],
      ],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("idle"));
    for (let i = 0; i < 6; i += 1) await remount(w);
    expect(capabilityReads(w)).toHaveLength(1);
    expect(reads(w)).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: copy.LINK_CALENDAR }),
    ).toBeEnabled();
  });

  test("answered false: the remounted screen still disables Link for it, without reading again", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      calendarLinks: false,
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: copy.LINK_CALENDAR }),
      ).toBeDisabled(),
    );
    await remount(w);
    expect(
      screen.getByRole("button", { name: copy.LINK_CALENDAR }),
    ).toBeDisabled();
    expect(capabilityReads(w)).toHaveLength(1);
  });

  test("offline when the screen opens: nothing is read; online, it is read once, and a remount does not read it again", async () => {
    fake();
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    expect(capabilityReads(w)).toEqual([]);
    act(() => w.online.set(true));
    await w.settle();
    expect(capabilityReads(w)).toHaveLength(1);
    await remount(w);
    act(() => w.online.set(false));
    await w.settle();
    act(() => w.online.set(true));
    await w.settle();
    expect(capabilityReads(w)).toHaveLength(1);
  });
});

describe("leaving the screen ends the visit (C2, Q6)", () => {
  test("after a refused read, the person leaves and opens the screen again: ONE new list read and ONE new capability read", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [forbidden, live(true)]]],
    });
    await waitFor(() => expect(row().dataset.observation).toBe("unknown"));
    await w.navigate("/settings");
    expect(row()).toBeNull();
    await elapse(w, OBSERVE_POLL_MS);
    expect(reads(w)).toHaveLength(1);
    await w.navigate("/settings/calendars");
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    expect(reads(w)).toHaveLength(2);
    expect(capabilityReads(w)).toHaveLength(2);
    // The new visit is bounded as the first: a remount now reads nothing again.
    await remount(w);
    expect(reads(w)).toHaveLength(2);
    expect(capabilityReads(w)).toHaveLength(2);
  });

  test("leaving while a read is out: its answer changes nothing, and nothing more is read until the screen is opened again", async () => {
    fake();
    const hold = held();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [hold.reply, live(false)]]],
    });
    await w.navigate("/settings");
    hold.release(live(true) as never);
    await w.settle();
    await elapse(w, OBSERVE_LIMIT_MS);
    expect(reads(w)).toHaveLength(1);
    await w.navigate("/settings/calendars");
    await waitFor(() => expect(row().dataset.observation).toBe("idle"));
    expect(reads(w)).toHaveLength(2);
  });
});

/**
 * Revision 6 (R13; design assessment C2, Q8-Q11): the visit ends when the DOCUMENT leaves the screen, whether or not the tree is mounted.
 * The session's protective closure (an Atlas `403`) unmounts the tree at the same address; the person can press Back while nothing is
 * mounted. Here the closure is `detach()` (the session double does not close the tree by itself; the real composition is E-CAL15), the
 * address moves through the document's REAL history (`history.go`, raw `pushState`/`replaceState`), and `attach()` mounts a new tree with
 * a new router wherever the document is then. Each schedule has its control: the same steps without a departure read nothing again.
 */
describe("revision 6 (R13): leaving while the tree is unmounted ends the visit", () => {
  const refreshPath = "/calendar-sources/{id}/refresh";
  /** Settings → Calendars in the document's history (a new visit, read once), so that Back has somewhere to go. */
  const throughSettings = async (w: World) => {
    await w.navigate("/settings");
    await w.navigate("/settings/calendars");
    await waitFor(() => expect(row().dataset.observation).toBe("idle"));
  };

  for (const departs of [true, false])
    test(`${departs ? "Q8, R13's witness" : "Q8 control"}: a press refused 403, the tree closed, ${departs ? "Back to Settings while closed, then Calendars opened" : "and opened again at the same address"}: ${departs ? "ONE fresh list read (the source seen busy) and ONE capability read" : "nothing read again"}; no automatic POST`, async () => {
      fake();
      const w = await calendarWorld({
        cache: [sourceRow()],
        replies: [["/calendar-sources", [live(false), live(false)]]],
      });
      await throughSettings(w);
      expect(reads(w)).toHaveLength(2);
      expect(capabilityReads(w)).toHaveLength(2);
      w.replies.set(refreshPath, [forbidden]);
      fireEvent.click(
        within(row()).getByRole("button", { name: "Refresh Family calendar" }),
      );
      await w.settle();
      expect(sends(w)).toHaveLength(1);
      await w.detach();
      expect(row()).toBeNull();
      w.replies.set("/calendar-sources", [live(true), live(true)]);
      if (departs) {
        await w.traverse(-1);
        expect(w.path()).toBe("/settings");
        await w.attach();
        expect(row()).toBeNull();
        await w.navigate("/settings/calendars");
        await waitFor(() => expect(row().dataset.observation).toBe("busy"));
        expect(reads(w)).toHaveLength(3);
        expect(capabilityReads(w)).toHaveLength(3);
      } else {
        await w.attach();
        expect(w.path()).toBe("/settings/calendars");
        await elapse(w, OBSERVE_POLL_MS);
        expect(reads(w)).toHaveLength(2);
        expect(capabilityReads(w)).toHaveLength(2);
        expect(row().dataset.observation).not.toBe("busy");
      }
      expect(sends(w)).toHaveLength(1);
    });

  for (const [label, move, departs] of [
    [
      "Back, then Forward",
      async (w: World) => {
        await w.traverse(-1);
        await w.traverse(1);
      },
      true,
    ],
    [
      "raw pushState away, then replaceState back",
      async (w: World) => {
        await w.write("push", "/settings");
        await w.write("replace", "/settings/calendars");
      },
      true,
    ],
    [
      "control: pushState of the same path with a query",
      async (w: World) => {
        await w.write("push", "/settings/calendars?view=all");
      },
      false,
    ],
    [
      "control: nothing (the protective remount alone)",
      async () => undefined,
      false,
    ],
  ] as const)
    test(`Q9: leaving and coming back entirely while unmounted (${label}): ${departs ? "the next mount is a new visit and reads once" : "the visit goes on and reads nothing"}`, async () => {
      fake();
      const w = await calendarWorld({
        cache: [sourceRow()],
        replies: [["/calendar-sources", [live(false), live(false)]]],
      });
      // Seen idle: a terminal visit (nothing more is read within it).
      await throughSettings(w);
      w.replies.set("/calendar-sources", [live(true)]);
      await w.detach();
      await move(w);
      expect(w.path()).toBe("/settings/calendars");
      await w.attach();
      if (departs) {
        await waitFor(() => expect(row().dataset.observation).toBe("busy"));
        expect(reads(w)).toHaveLength(3);
        expect(capabilityReads(w)).toHaveLength(3);
      } else {
        await elapse(w, OBSERVE_POLL_MS);
        expect(reads(w)).toHaveLength(2);
        expect(capabilityReads(w)).toHaveLength(2);
        expect(row().dataset.observation).toBe("idle");
      }
      expect(sends(w)).toEqual([]);
    });

  test("Q9 control: Back pressed on the MOUNTED screen ends the visit too; the reopened screen reads once", async () => {
    fake();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [live(false), live(false), live(true)]]],
    });
    await throughSettings(w);
    await w.traverse(-1);
    expect(w.path()).toBe("/settings");
    expect(row()).toBeNull();
    await w.navigate("/settings/calendars");
    await waitFor(() => expect(row().dataset.observation).toBe("busy"));
    expect(reads(w)).toHaveLength(3);
    expect(capabilityReads(w)).toHaveLength(3);
  });

  test("Q9/Q13: leaving while unmounted with a read out: its answer reaches nothing, and the reopened screen reads afresh", async () => {
    fake();
    const hold = held();
    const w = await calendarWorld({
      cache: [sourceRow()],
      replies: [["/calendar-sources", [live(false), hold.reply, live(false)]]],
    });
    await w.navigate("/settings");
    await w.navigate("/settings/calendars");
    expect(reads(w)).toHaveLength(2);
    await w.detach();
    await w.traverse(-1);
    hold.release(live(true) as never);
    await w.settle();
    await w.attach();
    await w.navigate("/settings/calendars");
    await waitFor(() => expect(row().dataset.observation).toBe("idle"));
    expect(reads(w)).toHaveLength(3);
  });
});

/**
 * Revision 6 (R12; design assessment C1, Q1-Q3): the production screen composes each mount's refresh controller with the identity's
 * refresh ownership (`memory.ts`), so a press's answer that arrives after the person left and came back is shown by the screen mounted
 * then only if no newer press of that source was admitted since. The review's witness, at component level: A held; Settings and back;
 * B pressed (a NEW key) and refused `422 invalid_ics`; then A's success arrives. The real composition is E-CAL15.
 */
describe("revision 6 (R12): an older press's late answer never replaces a newer press's", () => {
  const refreshPath = "/calendar-sources/{id}/refresh";
  const state = () =>
    row().querySelector<HTMLElement>("[data-refresh]")?.dataset.refresh ?? null;
  for (const schedule of [
    "no newer press",
    "newer press running",
    "newer press finished",
  ] as const)
    test(`${schedule}: ${schedule === "no newer press" ? "A's late success is shown (the legitimate late outcome)" : "the row keeps B's state, and then B's failure"}`, async () => {
      fake();
      const a = held();
      const b = held();
      const w = await calendarWorld({
        cache: [sourceRow()],
        replies: [
          ["/calendar-sources", [live(false), live(false)]],
          [refreshPath, [a.reply, b.reply]],
        ],
      });
      await waitFor(() => expect(row().dataset.observation).toBe("idle"));
      fireEvent.click(
        within(row()).getByRole("button", { name: "Refresh Family calendar" }),
      );
      await w.settle();
      expect(state()).toBe("refreshing");
      await w.navigate("/settings");
      await w.navigate("/settings/calendars");
      await waitFor(() =>
        expect(row().dataset.observation).not.toBe("checking"),
      );
      if (schedule !== "no newer press") {
        fireEvent.click(
          within(row()).getByRole("button", {
            name: "Refresh Family calendar",
          }),
        );
        await w.settle();
        expect(sends(w)).toHaveLength(2);
        expect(sends(w)[1]?.key).not.toBe(sends(w)[0]?.key);
        if (schedule === "newer press finished") {
          b.release({ status: 422, json: atlasBody("invalid_ics") } as never);
          await w.settle();
          expect(state()).toBe("failed");
        }
      }
      a.release({ status: 200, json: { revision: 9 } } as never);
      await w.settle();
      expect(state()).toBe(
        schedule === "no newer press"
          ? "succeeded"
          : schedule === "newer press running"
            ? "refreshing"
            : "failed",
      );
      if (schedule === "newer press running") {
        b.release({ status: 422, json: atlasBody("invalid_ics") } as never);
        await w.settle();
        expect(state()).toBe("failed");
      }
      // A screen mounted later (the session's re-check) shows the same outcome.
      await remount(w);
      expect(state()).toBe(
        schedule === "no newer press" ? "succeeded" : "failed",
      );
      expect(sends(w)).toHaveLength(schedule === "no newer press" ? 1 : 2);
    });
});
