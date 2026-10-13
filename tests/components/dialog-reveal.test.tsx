import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Dialog } from "../../src/components/ui/dialog";
import { UiProviders } from "../helpers/providers";

/**
 * WEB-10a revision 2 (R7 keyboard evidence, WCAG 2.4.11): a control that takes focus in the dialog's scrolling body is revealed WHOLE.
 * WebKit reveals a text field's caret rather than the field, which left the correction dialog's lower fields half under the footer in a
 * real keyboard traversal (measured: 9 of 10 runs before, 10 of 10 clear after, E-T8d). jsdom has no layout, so the geometry is supplied.
 */
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const rect = (top: number, bottom: number): DOMRect =>
  ({
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 400,
    width: 400,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

async function focusFieldAt(field: { top: number; bottom: number }) {
  render(
    <UiProviders>
      <Dialog
        open
        onClose={() => undefined}
        title="Correct"
        footer={<button type="button">Save</button>}
      >
        <input aria-label="Lower field" />
      </Dialog>
    </UiProviders>,
  );
  const input = await screen.findByLabelText("Lower field");
  const body = input.parentElement as HTMLElement;
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue(rect(100, 500));
  vi.spyOn(input, "getBoundingClientRect").mockReturnValue(
    rect(field.top, field.bottom),
  );
  const scroll = vi.fn();
  input.scrollIntoView = scroll;
  await act(async () => {
    input.focus();
  });
  return scroll;
}

describe("the dialog reveals a focused control whole", () => {
  test("a field partly below the body's visible area is scrolled into view (block 'nearest')", async () => {
    const scroll = await focusFieldAt({ top: 470, bottom: 514 });
    expect(scroll).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
  });

  test("a field partly above it is revealed too", async () => {
    const scroll = await focusFieldAt({ top: 80, bottom: 124 });
    expect(scroll).toHaveBeenCalledOnce();
  });

  test("control: a field already wholly in view is left where it is", async () => {
    const scroll = await focusFieldAt({ top: 200, bottom: 244 });
    expect(scroll).not.toHaveBeenCalled();
  });
});
