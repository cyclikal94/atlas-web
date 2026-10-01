import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createGateDialog } from "../../src/components/ui/gate-dialog";
import {
  CONSENT_DELETE,
  CONSENT_HEADING,
  CONSENT_KEEP,
  consentMessage,
  NEUTRAL_COPY,
  NeutralState,
} from "../../src/components/ui/neutral-state";
import type {
  ConsentTicket,
  NeutralActions,
  NeutralStateId,
} from "../../src/session";
import { NEUTRAL_POLITENESS } from "../../src/session/model/neutral-state";
import { COPY_DECK } from "./neutral-copy-deck";

afterEach(() => {
  cleanup();
  // A test that opened the resume gate must not leave it in the document for the next one.
  document.getElementById("resume-gate")?.remove();
});

const TICKET = "prompt-ticket" as ConsentTicket;

const IDS = Object.keys(COPY_DECK) as Exclude<NeutralStateId, "wipe.consent">[];
const actions = (): NeutralActions => ({
  signIn: vi.fn(),
  retry: vi.fn(),
  reload: vi.fn(),
  reviewDevice: vi.fn(),
  consent: vi.fn(),
});

/** F-NS / F-UI: every neutral state, its copy, live region, focus target and accessibility. */
describe("neutral states (F-NS, F-UI)", () => {
  test("the deck covers every state the session can name, except the consent prompt", () => {
    expect(new Set(IDS)).toEqual(new Set(Object.keys(NEUTRAL_COPY)));
    expect(IDS).toHaveLength(21);
  });

  for (const id of IDS) {
    const deck = COPY_DECK[id];
    if (!deck) throw new Error(`no deck entry for ${id}`);
    describe(`state ${id}`, () => {
      test("its text is the wireframe's, word for word", () => {
        render(<NeutralState state={id} actions={actions()} />);
        const page = screen.getByRole("main");
        expect(page).toHaveAttribute("data-neutral-state", id);
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
          deck.heading,
        );
        const paragraphs = Array.from(page.querySelectorAll("p")).map(
          (p) => p.textContent,
        );
        expect(paragraphs[0]).toBe(deck.message);
        expect(paragraphs).toContain(deck.more ?? deck.message);
        if (deck.note) expect(paragraphs).toContain(deck.note);
        const buttons = screen.queryAllByRole("button");
        expect(buttons.map((b) => b.textContent)).toEqual(
          deck.button ? [deck.button] : [],
        );
        // No engineering note ever ships.
        expect(page.textContent).not.toMatch(
          /engineering note|not product copy/i,
        );
      });

      test("the heading is the programmatic focus target and is focused on render", () => {
        render(<NeutralState state={id} actions={actions()} />);
        const heading = screen.getByRole("heading", { level: 1 });
        expect(heading).toHaveAttribute("tabindex", "-1");
        expect(heading).toHaveFocus();
      });

      test("the message is a status or an alert, as the politeness table says", () => {
        render(<NeutralState state={id} actions={actions()} />);
        const role = NEUTRAL_POLITENESS[id] === "alert" ? "alert" : "status";
        const message = screen.getByRole(role);
        expect(message).toHaveTextContent(deck.message);
        expect(
          screen.queryByRole(role === "alert" ? "status" : "alert"),
        ).toBeNull();
      });

      test("axe finds nothing", async () => {
        const { container } = render(
          <NeutralState state={id} actions={actions()} />,
        );
        expect((await axe(container)).violations).toEqual([]);
      });
    });
  }

  test("state 1a never promises that unsent changes will send (row 3 may end in a wipe)", () => {
    for (const id of IDS.filter((state) => state.startsWith("1a"))) {
      cleanup();
      render(<NeutralState state={id} actions={actions()} />);
      expect(screen.getByRole("main").textContent).not.toMatch(
        /will send|will be sent|sent once|send once/i,
      );
    }
  });

  test("each control calls the action the wireframe names", () => {
    const table: Array<[(typeof IDS)[number], keyof NeutralActions]> = [
      ["1a.confirming", "signIn"],
      ["1a.device_changed", "reviewDevice"],
      ["1a.ended_elsewhere", "signIn"],
      ["1b", "signIn"],
      ["1c.lock_wait", "retry"],
      ["1c.ended", "signIn"],
      ["1d", "signIn"],
      ["1e.session_offline", "retry"],
      ["1e.read_failure", "reload"],
      ["1e.interrupted_offline", "retry"],
      ["3", "retry"],
    ];
    for (const [id, action] of table) {
      cleanup();
      const fns = actions();
      render(<NeutralState state={id} actions={fns} />);
      fireEvent.click(screen.getByRole("button"));
      expect(fns[action], id).toHaveBeenCalledTimes(1);
      for (const other of [
        "signIn",
        "retry",
        "reload",
        "reviewDevice",
      ] as const)
        if (other !== action)
          expect(fns[other], `${id}/${other}`).not.toHaveBeenCalled();
    }
  });

  test("a control is at least 44 px tall (the button's own class)", () => {
    render(<NeutralState state="1b" actions={actions()} />);
    expect(screen.getByRole("button").className).toMatch(/min-h-11/);
  });

  test("focus follows a change of state", () => {
    const { rerender } = render(
      <NeutralState state="1e.checking" actions={actions()} />,
    );
    rerender(<NeutralState state="1b" actions={actions()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Reconnect to keep going",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  test("the provisional 'sign-in isn't available' line is a status after the control", () => {
    render(
      <NeutralState
        state="1b"
        actions={actions()}
        unavailable="Sign-in isn't available in this build yet."
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sign-in isn't available in this build yet.",
    );
  });
});

describe("focus and the resume gate", () => {
  test("a state that renders while the gate is open does not take focus from the gate's heading; once the gate is closed, a new state does", () => {
    const gate = createGateDialog(document);
    gate.open();
    gate.focusHeading();
    expect(document.activeElement?.id).toBe("resume-gate-heading");
    const { rerender } = render(
      <NeutralState state="1e.checking" actions={actions()} />,
    );
    // The gate owns focus (matrix 3.7.2 step 3, "Read pending"): the provisional state beneath it must not move it.
    expect(document.activeElement?.id).toBe("resume-gate-heading");
    gate.close();
    rerender(<NeutralState state="1b" actions={actions()} />);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1 }),
    );
  });

  test("with no gate in the document the heading is focused when the state renders (the ordinary case)", () => {
    render(<NeutralState state="1b" actions={actions()} />);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1 }),
    );
  });
});

describe("the post-success consent prompt (WEB-04 wireframe 4)", () => {
  test("says how many changes were saved, and offers exactly two choices, never 'Stay logged in'", () => {
    const fns = actions();
    render(
      <NeutralState
        state="wipe.consent"
        consent={{ count: 4, ticket: TICKET }}
        actions={fns}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      CONSENT_HEADING,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "4 changes were saved on this device after you confirmed. Delete them now, or keep them here until you decide?",
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      CONSENT_KEEP,
      CONSENT_DELETE,
    ]);
    expect(screen.queryByText(/stay logged in/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: CONSENT_KEEP }));
    // The choice names the prompt it was made on: the ticket the view carried with that prompt.
    expect(fns.consent).toHaveBeenLastCalledWith("keep", TICKET);
    fireEvent.click(screen.getByRole("button", { name: CONSENT_DELETE }));
    expect(fns.consent).toHaveBeenLastCalledWith("delete", TICKET);
  });

  test("the wording is singular for one change and carries a count only, never content", () => {
    expect(consentMessage(1)).toMatch(/^1 change was saved on this device/);
    expect(consentMessage(2)).toMatch(/^2 changes were saved on this device/);
  });

  test("axe finds nothing", async () => {
    const { container } = render(
      <NeutralState
        state="wipe.consent"
        consent={{ count: 2, ticket: TICKET }}
        actions={actions()}
      />,
    );
    expect((await axe(container)).violations).toEqual([]);
  });
});
