import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { FOCUS_COPY } from "../../../src/features/tasks/focus/FocusPage";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import { mountTasks, seededTask } from "../../support/tasks/world";

/**
 * Focus's acts on the Final design (FD_Focus): Later puts the current thing at the end of this session's order (L), Timer leads a
 * timed task to its timer section (T), and the keys are shown on the acts.
 */
const media = installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  media.set({ width: 1440 });
});

const title = () =>
  document.querySelector("[data-focus-title]")?.textContent?.trim() ?? null;
const order = () =>
  Array.from(document.querySelectorAll("[data-focus-order] li")).map((li) =>
    li.textContent?.trim(),
  );

async function openFocus() {
  const piano = await seededTask({
    title: "Practise piano",
    definition: {
      goal: {
        kind: "numeric",
        minimum: "1200",
        maximum: null,
        unit: "seconds",
      },
    },
  });
  const teeth = await seededTask({ title: "Brush your teeth" });
  const t = await mountTasks({
    path: "/focus",
    rows: [...piano.rows, ...teeth.rows],
    env: { online: false },
  });
  await t.until(() => title() !== null);
  return { t, piano, teeth };
}

describe("Later and Timer", () => {
  test("Later moves the current thing to the end of the order, marked, and the next comes up; L does the same", async () => {
    const { t } = await openFocus();
    const first = title() as string;
    const later = screen.getByRole("button", { name: /Later/ });
    expect(later.textContent).toContain("L");
    fireEvent.click(later);
    await t.until(() => title() !== first);
    expect(title()).not.toBe(first);
    expect(order().at(-1)).toContain(first);
    expect(order().at(-1)).toContain(FOCUS_COPY.deferred);
    const second = title() as string;
    fireEvent.keyDown(window, { key: "l" });
    await t.until(() => title() !== second);
    expect(order().at(-1)).toContain(second);
  });

  test("Timer is offered for a timed task only and leads to its timer section", async () => {
    const { t, piano } = await openFocus();
    const pick = (name: string) =>
      fireEvent.click(
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            "[data-focus-order] button",
          ),
        ).find((b) => b.textContent?.includes(name)) as HTMLButtonElement,
      );
    pick("Brush your teeth");
    await t.until(() => title() === "Brush your teeth");
    expect(document.querySelector("[data-focus-timer]")).toBeNull();
    pick("Practise piano");
    await t.until(() => title() === "Practise piano");
    const timer = document.querySelector("[data-focus-timer]") as HTMLElement;
    expect(timer).not.toBeNull();
    expect(timer.textContent).toContain("T");
    fireEvent.click(timer);
    await t.until(
      () => t.router.state.location.pathname === `/tasks/${piano.taskId}`,
    );
    expect(t.router.state.location.hash).toBe("timer");
  });

  test("the phone shows a timed task's ring and the four acts without key caps", async () => {
    media.set({ width: 390 });
    const { t } = await openFocus();
    const pick = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-focus-order] button"),
    );
    // On the phone the order is bars, not buttons: step with the arrow keys instead.
    expect(pick).toHaveLength(0);
    for (let i = 0; i < 3 && title() !== "Practise piano"; i += 1) {
      fireEvent.keyDown(window, { key: "ArrowRight" });
      await t.settle();
    }
    if (title() !== "Practise piano") {
      fireEvent.keyDown(window, { key: "ArrowLeft" });
      await t.settle();
    }
    await t.until(() => document.querySelector("[data-focus-ring]") !== null);
    expect(
      document
        .querySelector("[data-focus-ring]")
        ?.getAttribute("data-focus-ring"),
    ).toBe("0");
    expect(
      screen.getByRole("button", { name: FOCUS_COPY.later }).textContent,
    ).toBe(FOCUS_COPY.later);
  });
});
