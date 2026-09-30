import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { Dialog } from "../../src/components/ui/dialog";
import {
  enterFocusLoop,
  tabbableWithin,
} from "../../src/components/ui/focus-loop";
import { UiProviders } from "../helpers/providers";

afterEach(async () => {
  cleanup();
  document.body.innerHTML = "";
  await new Promise((resolve) => setTimeout(resolve, 0));
});

interface Modifiers {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/** Dispatches a Tab keydown from whatever holds focus (the body when nothing does) and returns whether it was cancelled. */
function pressTab({ shift, alt, ctrl, meta }: Modifiers = {}): boolean {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey: shift ?? false,
    altKey: alt ?? false,
    ctrlKey: ctrl ?? false,
    metaKey: meta ?? false,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function scene(markup: string) {
  document.body.innerHTML = `<button id="behind" type="button">Behind</button><div id="box" role="dialog" tabindex="-1">${markup}</div>`;
  const box = document.getElementById("box") as HTMLElement;
  return { box, stop: enterFocusLoop(box) };
}

describe("tabbableWithin", () => {
  test("lists what Tab visits, in DOM order, and skips what it does not", () => {
    const { box, stop } = scene(`
      <a href="#x" id="link">link</a>
      <button id="on" type="button">on</button>
      <button id="off" type="button" disabled>off</button>
      <button id="skipped" type="button" tabindex="-1">skipped</button>
      <input id="hidden" type="hidden" />
      <input id="text" type="text" />
      <div id="custom" tabindex="0">custom</div>
      <button id="none" type="button" style="display:none">none</button>
      <div style="visibility:hidden"><button id="invisible" type="button">invisible</button></div>
      <div inert><button id="inert" type="button">inert</button></div>
    `);
    expect(tabbableWithin(box).map((element) => element.id)).toEqual([
      "link",
      "on",
      "text",
      "custom",
    ]);
    stop();
  });

  test("a native radio group is a single tab stop: the checked button, else the first", () => {
    const { box, stop } = scene(`
      <input id="a1" type="radio" name="a" />
      <input id="a2" type="radio" name="a" checked />
      <input id="b1" type="radio" name="b" />
      <input id="b2" type="radio" name="b" />
    `);
    expect(tabbableWithin(box).map((element) => element.id)).toEqual([
      "a2",
      "b1",
    ]);
    stop();
  });
});

describe("focus loop", () => {
  const controls = `
    <button id="one" type="button">one</button>
    <button id="two" type="button">two</button>
    <button id="three" type="button">three</button>`;

  for (const [name, modifiers] of [
    ["Tab", {}],
    ["Option+Tab (macOS Safari)", { alt: true }],
  ] as const) {
    test(`${name} from the last control wraps to the first`, () => {
      const { stop } = scene(controls);
      document.getElementById("three")?.focus();
      expect(pressTab(modifiers)).toBe(true);
      expect(document.activeElement?.id).toBe("one");
      stop();
    });

    test(`Shift+${name} from the first control wraps to the last`, () => {
      const { stop } = scene(controls);
      document.getElementById("one")?.focus();
      expect(pressTab({ ...modifiers, shift: true })).toBe(true);
      expect(document.activeElement?.id).toBe("three");
      stop();
    });

    test(`${name} in the middle is left to the browser`, () => {
      const { stop } = scene(controls);
      document.getElementById("two")?.focus();
      expect(pressTab(modifiers)).toBe(false);
      expect(pressTab({ ...modifiers, shift: true })).toBe(false);
      expect(document.activeElement?.id).toBe("two");
      stop();
    });
  }

  test("Shift+Tab from the dialog container itself goes to the last control", () => {
    const { box, stop } = scene(controls);
    box.focus();
    expect(pressTab({ shift: true, alt: true })).toBe(true);
    expect(document.activeElement?.id).toBe("three");
    stop();
  });

  test("Tab pressed while focus is outside the dialog (the body, a focus guard) comes back in", () => {
    const { stop } = scene(controls);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(pressTab({ alt: true })).toBe(true);
    expect(document.activeElement?.id).toBe("one");
    (document.getElementById("behind") as HTMLElement).focus();
    expect(pressTab({ alt: true, shift: true })).toBe(true);
    expect(document.activeElement?.id).toBe("three");
    stop();
  });

  test("with one control, Tab stays on it; with none, focus goes to the dialog and Tab is cancelled", () => {
    const single = scene(`<button id="only" type="button">only</button>`);
    document.getElementById("only")?.focus();
    expect(pressTab({ alt: true })).toBe(true);
    expect(document.activeElement?.id).toBe("only");
    single.stop();

    const empty = scene("<p>nothing to press</p>");
    expect(pressTab({ alt: true })).toBe(true);
    expect(document.activeElement).toBe(empty.box);
    empty.stop();
  });

  test("Ctrl and Cmd combinations belong to the browser", () => {
    const { stop } = scene(controls);
    document.getElementById("three")?.focus();
    expect(pressTab({ ctrl: true })).toBe(false);
    expect(pressTab({ meta: true })).toBe(false);
    expect(document.activeElement?.id).toBe("three");
    stop();
  });

  test("stopping removes the listener", () => {
    const { stop } = scene(controls);
    stop();
    document.getElementById("three")?.focus();
    expect(pressTab({ alt: true })).toBe(false);
    expect(document.activeElement?.id).toBe("three");
  });

  test("a dialog stacked on top owns the keyboard", () => {
    document.body.innerHTML = `
      <div id="lower" role="dialog" tabindex="-1"><button id="l1" type="button">l1</button></div>
      <div id="upper" role="dialog" tabindex="-1"><button id="u1" type="button">u1</button><button id="u2" type="button">u2</button></div>`;
    const lower = enterFocusLoop(
      document.getElementById("lower") as HTMLElement,
    );
    document.getElementById("u2")?.focus();
    // The lower dialog's loop must not pull focus out of the upper one.
    expect(pressTab({ alt: true })).toBe(false);
    expect(document.activeElement?.id).toBe("u2");
    lower();
  });
});

describe("Dialog wires the loop in", () => {
  test("Option+Tab from the last control of a real Dialog wraps, and the loop stops on close", async () => {
    function Page({ open }: { open: boolean }) {
      return (
        <UiProviders>
          <Dialog
            open={open}
            onClose={() => {}}
            title="Loop"
            footer={<button type="button">Last</button>}
          >
            <button type="button">First</button>
          </Dialog>
        </UiProviders>
      );
    }
    const { rerender } = render(<Page open />);
    const dialog = await screen.findByRole("dialog");
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    expect(pressTab({ alt: true })).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);

    rerender(<Page open={false} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.body.focus();
    expect(pressTab({ alt: true })).toBe(false);
  });
});
