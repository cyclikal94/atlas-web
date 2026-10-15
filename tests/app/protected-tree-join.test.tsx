import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createProtectedTree } from "../../src/app/protected-tree";
import { NEUTRAL_COPY } from "../../src/components/ui/neutral-state";
import { authFeedback } from "../../src/features/authentication/feedback";
import { invitationMemory } from "../../src/features/authentication/handoff";
import { MESSAGE_TEXT } from "../../src/features/authentication/outcome-copy";
import {
  JOIN_WHILE_SIGNED_IN_BODY,
  JOIN_WHILE_SIGNED_IN_HEADING,
} from "../../src/features/authentication/route";
import { installMatchMedia } from "../helpers/match-media";
import { sessionDouble } from "../helpers/session-double";

installMatchMedia({ width: 1440 });

beforeEach(() => {
  invitationMemory.clear();
  authFeedback.clearOnBegin();
});
afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  invitationMemory.clear();
  authFeedback.clearOnBegin();
});

const mount = () => render(createProtectedTree(sessionDouble())());

describe("the protected tree and /join", () => {
  test("a person who has just registered never lands on /join: it becomes / (query kept) synchronously, before the router exists", async () => {
    history.replaceState(null, "", "/join?x=1");
    // Building the tree is the factory's synchronous step: the path is already `/` when it returns.
    const tree = createProtectedTree(sessionDouble())();
    expect(location.pathname).toBe("/");
    expect(location.search).toBe("?x=1");
    render(tree);
    await waitFor(() => expect(location.pathname).toBe("/today"));
    expect(screen.queryByText(JOIN_WHILE_SIGNED_IN_HEADING)).toBeNull();
  });

  test("E-15: a person who is signed in and holds an unused invitation is told why the link registers nobody", async () => {
    invitationMemory.set("c".repeat(64));
    history.replaceState(null, "", "/join");
    mount();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: JOIN_WHILE_SIGNED_IN_HEADING,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(JOIN_WHILE_SIGNED_IN_BODY)).toBeInTheDocument();
    expect(location.pathname).toBe("/join");
    // The invitation stays in page memory for after the sign-out; nothing about it is drawn.
    expect(invitationMemory.peek()).toBe("c".repeat(64));
    expect(document.body.innerHTML).not.toContain("c".repeat(64));
  });

  test("any other path is left exactly as it is", async () => {
    history.replaceState(null, "", "/settings");
    mount();
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    expect(location.pathname).toBe("/settings");
  });
});

describe("notices about a sign-in that finished while an account displays", () => {
  test("T1/T2: the superseded notice, with the accepted wording, dismissible", async () => {
    history.replaceState(null, "", "/today");
    mount();
    await screen.findByRole("main", { hidden: true });
    act(() => authFeedback.add({ kind: "superseded" }));
    const notice = await screen.findByText(
      NEUTRAL_COPY["1c.superseded"].message,
    );
    expect(notice.closest("[data-notice]")).toHaveAttribute(
      "data-notice",
      "feedback-superseded",
    );
    const notices = screen.getByRole("region", { name: "Notices" });
    fireEvent.click(notices.querySelector("button") as HTMLElement);
    expect(
      screen.queryByText(NEUTRAL_COPY["1c.superseded"].message),
    ).toBeNull();
  });

  /**
   * Kieran's decision of 15 October 2026 (WEB-10a revision 7; review 7's retained superseded-notice live-region race): dismissing a
   * notice also withdraws its announcement. The announcer writes on the NEXT animation frame; here that frame is held and released at
   * chosen points (no elapsed-time dependence: the race was a frame that came due during Testing Library's drain), and the banner and the
   * polite live region are observed separately. The original test above is unchanged.
   */
  describe("T1/T2 (revision 7): the announcement belongs to its notice", () => {
    let frames: Array<FrameRequestCallback | null> = [];
    beforeEach(() => {
      frames = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
        frames[id - 1] = null;
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    const runFrames = () =>
      act(() => {
        for (const cb of frames.splice(0)) cb?.(performance.now());
      });
    const MESSAGE = NEUTRAL_COPY["1c.superseded"].message;
    const polite = () =>
      document.querySelector('[aria-live="polite"]') as HTMLElement;
    const banner = (kind: string) =>
      document.querySelector(`[data-notice="feedback-${kind}"]`);
    const dismiss = (kind: string) =>
      fireEvent.click(
        (banner(kind) as HTMLElement).querySelector("button") as HTMLElement,
      );
    async function shown() {
      history.replaceState(null, "", "/today");
      mount();
      await screen.findByRole("main", { hidden: true });
      runFrames();
      act(() => authFeedback.add({ kind: "superseded" }));
      expect(banner("superseded")).not.toBeNull();
    }

    test("the frame wrote the announcement BEFORE Dismiss (the failed order): Dismiss removes the banner and withdraws the announcement", async () => {
      await shown();
      runFrames();
      expect(polite().textContent).toBe(MESSAGE);
      dismiss("superseded");
      expect(banner("superseded")).toBeNull();
      expect(polite().textContent).toBe("");
      expect(screen.queryByText(MESSAGE)).toBeNull();
    });

    test("Dismiss BEFORE the frame: the dismissed notice is never announced", async () => {
      await shown();
      dismiss("superseded");
      expect(banner("superseded")).toBeNull();
      runFrames();
      expect(polite().textContent).toBe("");
    });

    test("a later notice's announcement survives dismissing the earlier notice", async () => {
      await shown();
      runFrames();
      act(() =>
        authFeedback.add({
          kind: "message",
          tone: "info",
          message: { id: "sso_linked" },
        }),
      );
      runFrames();
      expect(polite().textContent).toBe(MESSAGE_TEXT.sso_linked);
      dismiss("superseded");
      runFrames();
      expect(banner("superseded")).toBeNull();
      expect(banner("message")).not.toBeNull();
      expect(polite().textContent).toBe(MESSAGE_TEXT.sso_linked);
    });

    test("control: a notice that is not dismissed keeps its announcement", async () => {
      await shown();
      runFrames();
      expect(polite().textContent).toBe(MESSAGE);
      expect(banner("superseded")).not.toBeNull();
    });
  });

  test("linking single sign-on says so", async () => {
    history.replaceState(null, "", "/today");
    mount();
    await screen.findByRole("main", { hidden: true });
    act(() =>
      authFeedback.add({
        kind: "message",
        tone: "info",
        message: { id: "sso_linked" },
      }),
    );
    expect(
      await screen.findByText(MESSAGE_TEXT.sso_linked),
    ).toBeInTheDocument();
  });
});
