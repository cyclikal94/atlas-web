import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  SyncAnnouncements,
  SyncStatusChip,
} from "../../src/components/ui/sync-status";
import type { SyncStatusModel } from "../../src/lib/sync-chip";
import { UiProviders } from "../helpers/providers";

afterEach(cleanup);
const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("SyncStatusChip", () => {
  const model: SyncStatusModel = {
    phase: "synced",
    pendingCount: 2,
    conflictCount: 0,
  };

  test("is a real button whose accessible name states status and action, and it visibly contains the label", async () => {
    const { container } = render(
      <UiProviders sync={{ model }}>
        <SyncStatusChip variant="rail" />
      </UiProviders>,
    );
    const button = screen.getByRole("button", {
      name: "2 waiting to send, Receiving updates: up to date. Open sync queue.",
    });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveTextContent("2 waiting to send");
    expect((await axe(container)).violations).toEqual([]);
  });

  test("activating it opens the destination the model selects", () => {
    const onOpen = vi.fn();
    render(
      <UiProviders sync={{ model: { ...model, conflictCount: 1 }, onOpen }}>
        <SyncStatusChip variant="topbar" />
      </UiProviders>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith("conflicts");
  });

  test.each(["rail", "rail-collapsed", "topbar", "dialog"] as const)(
    "%s variant has an accessible name and a tone",
    (variant) => {
      render(
        <UiProviders
          sync={{
            model: { phase: "interrupted", pendingCount: 0, conflictCount: 0 },
          }}
        >
          <SyncStatusChip variant={variant} />
        </UiProviders>,
      );
      const button = screen.getByRole("button");
      expect(button).toHaveAttribute("data-sync-tone", "warn");
      expect(button.getAttribute("aria-label")).toMatch(/stopped/i);
    },
  );

  test("tone is carried by text and a dot, never colour alone", () => {
    render(
      <UiProviders
        sync={{
          model: { phase: "offline", pendingCount: 0, conflictCount: 0 },
        }}
      >
        <SyncStatusChip variant="rail" />
      </UiProviders>,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Offline");
    expect(button.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  test("the chip itself never announces", () => {
    render(
      <UiProviders sync={{ model }}>
        <SyncStatusChip variant="rail" />
      </UiProviders>,
    );
    expect(screen.getByRole("button").closest("[aria-live]")).toBeNull();
  });
});

describe("SyncAnnouncements", () => {
  function Harness({ model }: { model: SyncStatusModel }) {
    return (
      <UiProviders>
        <SyncAnnouncements model={model} />
      </UiProviders>
    );
  }
  const base: SyncStatusModel = {
    phase: "synced",
    pendingCount: 0,
    conflictCount: 0,
  };

  test("says nothing on first render", async () => {
    render(<Harness model={{ ...base, pendingCount: 3, conflictCount: 1 }} />);
    await act(frame);
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.getByRole("alert")).toHaveTextContent("");
  });

  test("announces a phase change politely", async () => {
    const { rerender } = render(<Harness model={base} />);
    rerender(<Harness model={{ ...base, phase: "offline" }} />);
    await act(frame);
    await act(frame);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Receiving updates: offline.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("");
  });

  test("announces a change in the pending count politely", async () => {
    const { rerender } = render(<Harness model={base} />);
    rerender(<Harness model={{ ...base, pendingCount: 2 }} />);
    await act(frame);
    await act(frame);
    expect(screen.getByRole("status")).toHaveTextContent("2 waiting to send.");
  });

  test("announces assertively only when the conflict count increases", async () => {
    const { rerender } = render(<Harness model={base} />);
    rerender(<Harness model={{ ...base, conflictCount: 1 }} />);
    await act(frame);
    await act(frame);
    expect(screen.getByRole("alert")).toHaveTextContent("1 needs a decision.");
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  test("a conflict resolving is polite, not assertive", async () => {
    const { rerender } = render(
      <Harness model={{ ...base, conflictCount: 2 }} />,
    );
    rerender(<Harness model={{ ...base, conflictCount: 1 }} />);
    await act(frame);
    await act(frame);
    expect(screen.getByRole("alert")).toHaveTextContent("");
    expect(screen.getByRole("status")).toHaveTextContent("1 needs a decision.");
  });

  test("rapid changes are coalesced into one announcement carrying the latest state", async () => {
    const { rerender } = render(<Harness model={base} />);
    rerender(<Harness model={{ ...base, pendingCount: 1 }} />);
    rerender(<Harness model={{ ...base, pendingCount: 2 }} />);
    rerender(<Harness model={{ ...base, pendingCount: 3 }} />);
    await act(frame);
    await act(frame);
    expect(screen.getByRole("status")).toHaveTextContent("3 waiting to send.");
  });

  test("a change that reverts before the frame is not announced", async () => {
    const { rerender } = render(<Harness model={base} />);
    rerender(<Harness model={{ ...base, pendingCount: 1 }} />);
    rerender(<Harness model={base} />);
    await act(frame);
    await act(frame);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});
