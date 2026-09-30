import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { Dialog } from "../../src/components/ui/dialog";
import { enterModal } from "../../src/components/ui/modal-background";
import { UiProviders } from "../helpers/providers";

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function Page({ open }: { open: boolean }) {
  return (
    <UiProviders>
      <div data-testid="page">
        <button type="button">Behind</button>
      </div>
      <Dialog open={open} onClose={() => {}} title="Modal">
        <p>content</p>
      </Dialog>
    </UiProviders>
  );
}

describe("modal background (CSP-safe: no style element)", () => {
  test("opening makes the page behind inert and hidden, closing restores exactly", async () => {
    const { rerender } = render(<Page open={false} />);
    const page = screen.getByTestId("page");
    expect(page).not.toHaveAttribute("inert");
    rerender(<Page open />);
    await screen.findByRole("dialog");
    expect(page).toHaveAttribute("inert");
    expect(page).toHaveAttribute("aria-hidden", "true");
    rerender(<Page open={false} />);
    await waitFor(() => expect(page).not.toHaveAttribute("inert"));
    expect(page).not.toHaveAttribute("aria-hidden");
  });

  test("live regions stay available to assistive technology while a dialog is open", async () => {
    render(<Page open />);
    await screen.findByRole("dialog");
    const polite = document.querySelector(
      '[role="status"][aria-live="polite"]',
    );
    expect(polite).not.toHaveAttribute("inert");
    expect(polite).not.toHaveAttribute("aria-hidden");
    expect(document.querySelector('[role="alert"]')).not.toHaveAttribute(
      "inert",
    );
  });

  test("the dialog itself is never made inert", async () => {
    render(<Page open />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.closest("[inert]")).toBeNull();
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  test("opening adds no style element, so the strict content security policy is satisfied", async () => {
    const before = document.querySelectorAll("style").length;
    render(<Page open />);
    await screen.findByRole("dialog");
    expect(document.querySelectorAll("style").length).toBe(before);
  });

  test("scrolling is locked by a CSSOM write and restored on close", async () => {
    document.body.style.overflow = "auto";
    const { rerender } = render(<Page open />);
    await screen.findByRole("dialog");
    expect(document.body.style.overflow).toBe("hidden");
    rerender(<Page open={false} />);
    await waitFor(() => expect(document.body.style.overflow).toBe("auto"));
    document.body.style.overflow = "";
  });

  test("pre-existing aria-hidden and inert are preserved on restore", () => {
    const host = document.createElement("div");
    const kept = document.createElement("div");
    kept.setAttribute("aria-hidden", "true");
    const portal = document.createElement("div");
    host.append(kept, portal);
    document.body.append(host);
    const leave = enterModal(portal);
    expect(kept).toHaveAttribute("inert");
    leave();
    expect(kept).not.toHaveAttribute("inert");
    expect(kept).toHaveAttribute("aria-hidden", "true");
    host.remove();
  });

  test("two modals stack and restore only when the last one closes", () => {
    const host = document.createElement("div");
    const other = document.createElement("div");
    const portal = document.createElement("div");
    host.append(other, portal);
    document.body.append(host);
    const first = enterModal(portal);
    const second = enterModal(portal);
    first();
    expect(other).toHaveAttribute("inert");
    second();
    expect(other).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("");
    host.remove();
  });

  test("clicking Close still discards", async () => {
    let closed = 0;
    render(
      <UiProviders>
        <Dialog open onClose={() => (closed += 1)} title="Modal">
          x
        </Dialog>
      </UiProviders>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(closed).toBe(1);
  });
});
