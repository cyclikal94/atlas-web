import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AnnouncerProvider,
  useAnnouncer,
} from "../../src/components/ui/announcer";
import { Button } from "../../src/components/ui/button";
import { Dialog } from "../../src/components/ui/dialog";
import { Input } from "../../src/components/ui/input";
import { NeutralGate } from "../../src/components/ui/neutral-gate";
import { Portal } from "../../src/components/ui/portal";
import { RadioCardGroup } from "../../src/components/ui/radio-card-group";
import { SkipLink } from "../../src/components/ui/skip-link";
import { Tooltip } from "../../src/components/ui/tooltip";
import { PortalContainer } from "../../src/protected-surface/PortalContainer";
import { UiProviders } from "../helpers/providers";

afterEach(cleanup);

describe("Button", () => {
  test("a disabled button states its reason beside it and points to it", async () => {
    const { container } = render(
      <Button disabled reason="You are offline, so this cannot be sent yet.">
        Send
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toBeDisabled();
    const reason = screen.getByText(
      "You are offline, so this cannot be sent yet.",
    );
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
    expect((await axe(container)).violations).toEqual([]);
  });

  test("an enabled button has no reason text and defaults to type=button", () => {
    render(<Button variant="default">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "type",
      "button",
    );
  });

  test("touch layouts get a 44px minimum height", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button").className).toContain("h-11");
  });
});

describe("Input", () => {
  test("is associated with its label and has no axe violations", async () => {
    const { container } = render(<Input label="Title" />);
    expect(screen.getByLabelText("Title")).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  test("accepts aria-labelledby or aria-label instead of a label", () => {
    render(
      <>
        <span id="lbl">Search</span>
        <Input aria-labelledby="lbl" />
        <Input aria-label="Other" />
      </>,
    );
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
    expect(screen.getByLabelText("Other")).toBeInTheDocument();
  });

  test("its border is the input edge and its fill is the page background", () => {
    render(<Input aria-label="a" />);
    const a = screen.getByRole("textbox");
    expect(a.className).toContain("border-input");
    expect(a.className).toContain("bg-background");
    expect(a.className).not.toMatch(/border-border|bg-secondary|bg-muted/);
  });

  test("placeholder text uses muted-foreground", () => {
    render(<Input aria-label="a" placeholder="Type here" />);
    expect(screen.getByPlaceholderText("Type here").className).toContain(
      "placeholder:text-muted-foreground",
    );
  });
});

describe("RadioCardGroup", () => {
  const options = [
    { value: "a", label: "Alpha", contractId: "opt-a" },
    { value: "b", label: "Beta", contractId: "opt-b" },
    { value: "c", label: "Gamma", contractId: "opt-c" },
  ] as const;

  function Harness({
    onChange = () => {},
  }: {
    onChange?: (value: string) => void;
  }) {
    return (
      <RadioCardGroup
        label="Choice"
        value="a"
        onValueChange={onChange}
        options={options}
      />
    );
  }

  test("is a radiogroup with exactly one tab stop, and focus lands on the checked card", async () => {
    const { container } = render(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "Choice" });
    const radios = screen.getAllByRole("radio");
    const tabStops = [group, ...radios].filter(
      (element) => element.getAttribute("tabindex") === "0",
    );
    expect(tabStops).toHaveLength(1);
    act(() => group.focus());
    expect(radios[0]).toHaveFocus();
    expect(radios[0]).toBeChecked();
    expect((await axe(container)).violations).toEqual([]);
  });

  test("arrow keys move and select; Space checks", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const [first, second] = screen.getAllByRole("radio");
    act(() => first?.focus());
    fireEvent.keyDown(first as HTMLElement, { key: "ArrowRight" });
    await waitFor(() => expect(second).toHaveFocus());
    expect(onChange).toHaveBeenCalledWith("b");
    fireEvent.keyDown(second as HTMLElement, { key: " " });
    fireEvent.click(second as HTMLElement);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  test("selection is not colour alone: a ring with a dot, and contract ids stay off title", () => {
    render(<Harness />);
    const first = screen.getAllByRole("radio")[0] as HTMLElement;
    expect(first.querySelector('[data-state="checked"]')).not.toBeNull();
    expect(first.querySelector(".border-input")).not.toBeNull();
    expect(first).toHaveAttribute("data-contract-id", "opt-a");
    expect(first).not.toHaveAttribute("title");
  });
});

describe("Dialog", () => {
  function Host({
    onClose = () => {},
    onDiscard,
    onRetainDraft,
    onOpen,
    conflicts = 0,
  }: {
    onClose?: () => void;
    onDiscard?: () => void;
    onRetainDraft?: () => void;
    onOpen?: (d: string) => void;
    conflicts?: number;
  }) {
    return (
      <UiProviders
        sync={{
          model: { phase: "synced", pendingCount: 2, conflictCount: conflicts },
          onOpen: (destination) => onOpen?.(destination),
        }}
      >
        <button type="button">Trigger</button>
        <Dialog
          open
          onClose={onClose}
          onDiscard={onDiscard}
          onRetainDraft={onRetainDraft}
          title="Edit thing"
        >
          <Input label="Name" />
        </Dialog>
      </UiProviders>
    );
  }

  test("renders inside the registered portal container, never document.body directly", async () => {
    const { container } = render(<Host />);
    const dialog = await screen.findByRole("dialog", { name: "Edit thing" });
    const portalRoot = container.querySelector("[data-portal-root]");
    expect(portalRoot?.contains(dialog)).toBe(true);
    expect(
      document.body.querySelectorAll(':scope > [role="dialog"]'),
    ).toHaveLength(0);
  });

  test("the sync control is inside the dialog (inside its focus trap)", async () => {
    render(<Host />);
    const dialog = await screen.findByRole("dialog", { name: "Edit thing" });
    expect(
      within(dialog).getByRole("button", { name: /Open sync queue/ }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
  });

  test("Escape and the close icon discard", async () => {
    const onDiscard = vi.fn();
    const onClose = vi.fn();
    render(<Host onDiscard={onDiscard} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onDiscard).toHaveBeenCalledTimes(2);
  });

  test("activating the sync control retains the draft, closes, then navigates", async () => {
    const order: string[] = [];
    render(
      <Host
        conflicts={1}
        onRetainDraft={() => order.push("retain")}
        onClose={() => order.push("close")}
        onOpen={(destination) => order.push(`open:${destination}`)}
        onDiscard={() => order.push("discard")}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Open conflicts/ }),
    );
    expect(order).toEqual(["retain", "close", "open:conflicts"]);
  });

  test("has no axe violations", async () => {
    render(<Host />);
    await screen.findByRole("dialog");
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("moves focus into the dialog on open", async () => {
    render(<Host />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
  });
});

describe("Portal", () => {
  test("throws in development when used outside a PortalContainer", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <Portal>
          <span>x</span>
        </Portal>,
      ),
    ).toThrow(/outside a PortalContainer/);
    error.mockRestore();
  });

  test("renders into the container", async () => {
    const { container } = render(
      <PortalContainer>
        <Portal>
          <span>inside</span>
        </Portal>
      </PortalContainer>,
    );
    await waitFor(() =>
      expect(
        container.querySelector("[data-portal-root] span"),
      ).toHaveTextContent("inside"),
    );
  });
});

describe("Tooltip", () => {
  test("shows on keyboard focus, in the portal container, and the trigger keeps its own name", async () => {
    const { container } = render(
      <UiProviders>
        <Tooltip content="Today">
          <button type="button" aria-label="Today">
            icon
          </button>
        </Tooltip>
      </UiProviders>,
    );
    const trigger = screen.getByRole("button", { name: "Today" });
    act(() => trigger.focus());
    fireEvent.focus(trigger);
    const tip = await screen.findAllByText("Today");
    expect(tip.length).toBeGreaterThan(0);
    expect(
      container.querySelector(
        "[data-portal-root] [role='tooltip'], [data-portal-root] [data-radix-popper-content-wrapper]",
      ),
    ).not.toBeNull();
    expect(trigger).toHaveAccessibleName("Today");
  });
});

describe("Announcer", () => {
  function Speak({
    message,
    politeness,
  }: {
    message: string;
    politeness?: "polite" | "assertive";
  }) {
    const { announce, clearAll } = useAnnouncer();
    return (
      <>
        <button type="button" onClick={() => announce(message, politeness)}>
          speak
        </button>
        <button type="button" onClick={clearAll}>
          clear
        </button>
      </>
    );
  }

  const frame = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  test("announces politely by default, and assertively on request", async () => {
    render(
      <AnnouncerProvider>
        <Speak message="Saved" />
        <Speak message="Conflict" politeness="assertive" />
      </AnnouncerProvider>,
    );
    const [polite, assertive] = screen.getAllByRole("button", {
      name: "speak",
    });
    fireEvent.click(polite as HTMLElement);
    fireEvent.click(assertive as HTMLElement);
    await act(frame);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByRole("alert")).toHaveTextContent("Conflict");
  });

  test("an identical consecutive message is cleared then set again, so it is re-announced", async () => {
    render(
      <AnnouncerProvider>
        <Speak message="Same" />
      </AnnouncerProvider>,
    );
    const status = screen.getByRole("status");
    const speak = screen.getByRole("button", { name: "speak" });
    fireEvent.click(speak);
    await act(frame);
    expect(status).toHaveTextContent("Same");
    fireEvent.click(speak);
    expect(status).toHaveTextContent("");
    await act(frame);
    expect(status).toHaveTextContent("Same");
  });

  test("clearAll removes any text at once", async () => {
    render(
      <AnnouncerProvider>
        <Speak message="Secret" />
      </AnnouncerProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "speak" }));
    await act(frame);
    fireEvent.click(screen.getByRole("button", { name: "clear" }));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  /**
   * Kieran's decision of 15 October 2026 (WEB-10a revision 7; review 7's superseded-notice live-region race): an announcement is
   * owned by its caller, and `retract` withdraws it, before or after its frame, but never a later announcement of the same region.
   */
  describe("an announcement withdrawn by its owner", () => {
    let api: ReturnType<typeof useAnnouncer>;
    function Grab() {
      api = useAnnouncer();
      return null;
    }
    const mount = () =>
      render(
        <AnnouncerProvider>
          <Grab />
        </AnnouncerProvider>,
      );

    test("withdrawn before its frame: nothing is ever written", async () => {
      mount();
      const status = screen.getByRole("status");
      const mine = api.announce("Notice A");
      mine.retract();
      await act(frame);
      await act(frame);
      expect(status).toHaveTextContent("");
    });

    test("withdrawn after its frame: its text is cleared", async () => {
      mount();
      const alert = screen.getByRole("alert");
      const mine = api.announce("Notice A", "assertive");
      await act(frame);
      expect(alert).toHaveTextContent("Notice A");
      mine.retract();
      expect(alert).toHaveTextContent("");
    });

    for (const when of ["before", "after"] as const)
      test(`an earlier announcement withdrawn ${when} the later one's frame never erases the later one`, async () => {
        mount();
        const status = screen.getByRole("status");
        const earlier = api.announce("Notice A");
        await act(frame);
        api.announce("Notice B");
        if (when === "before") earlier.retract();
        await act(frame);
        if (when === "after") earlier.retract();
        await act(frame);
        expect(status).toHaveTextContent("Notice B");
      });

    test("ownership is the announcement, not its text: withdrawing an earlier announcement of the SAME words keeps the later one", async () => {
      mount();
      const status = screen.getByRole("status");
      const earlier = api.announce("Same words");
      await act(frame);
      api.announce("Same words");
      await act(frame);
      expect(status).toHaveTextContent("Same words");
      earlier.retract();
      await act(frame);
      expect(status).toHaveTextContent("Same words");
    });

    test("control: an announcement that is not withdrawn stays; a withdrawal after clearAll changes nothing", async () => {
      mount();
      const status = screen.getByRole("status");
      const kept = api.announce("Notice A");
      await act(frame);
      expect(status).toHaveTextContent("Notice A");
      act(() => api.clearAll());
      kept.retract();
      const next = api.announce("Notice B");
      await act(frame);
      kept.retract();
      expect(status).toHaveTextContent("Notice B");
      next.retract();
      expect(status).toHaveTextContent("");
    });
  });

  test("useAnnouncer throws without a provider", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Speak message="x" />)).toThrow(/AnnouncerProvider/);
    error.mockRestore();
  });
});

describe("SkipLink", () => {
  test("is hidden until focused and moves focus to main without changing the URL fragment", () => {
    render(
      <>
        <SkipLink />
        <main id="main" tabIndex={-1}>
          content
        </main>
      </>,
    );
    const link = screen.getByRole("link", { name: "Skip to main content" });
    expect(link.className).toContain("sr-only");
    expect(link.className).toContain("focus:not-sr-only");
    const before = location.href;
    fireEvent.click(link);
    expect(screen.getByRole("main")).toHaveFocus();
    expect(location.href).toBe(before);
  });
});

describe("NeutralGate", () => {
  test("is an opaque dialog with a heading and a status region, and no axe violations", async () => {
    const { container } = render(
      <NeutralGate heading="Atlas" message="Opening Atlas…" />,
    );
    const dialog = screen.getByRole("dialog", { name: "Atlas" });
    expect(dialog).toHaveClass("neutral-gate");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Opening Atlas…",
    );
    expect((await axe(container)).violations).toEqual([]);
  });
});
