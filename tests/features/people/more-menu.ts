import { fireEvent, waitFor, within } from "@testing-library/react";
import { MENU_COPY } from "../../../src/components/ui/action-menu";

/**
 * The person's other acts fold behind "More" in the identity header (the Final design, 8 November 2026): a disclosure whose panel holds
 * the same buttons as before, in place. A test reaches them by opening it first; `actions(root)` opens it (once) and returns the queries
 * bound to the root, so `actions(header()).getByRole("button", { name: "Rename" })` reads as the old `within(header())`.
 */
export function openMore(root: HTMLElement): void {
  const button = within(root).queryByRole("button", { name: MENU_COPY.more });
  if (button !== null && button.getAttribute("aria-expanded") !== "true")
    fireEvent.click(button);
}

export function actions(root: HTMLElement): ReturnType<typeof within> {
  openMore(root);
  return within(root);
}

/** The identity header of the person shown, or null before it is. */
export const identityHeader = (): HTMLElement | null =>
  document.querySelector("[data-identity-header]");

/** Waits for the header (the given one, or the identity header), opens "More", and finds the act by name (a button, or a link). */
export async function findAction(
  name: string | RegExp,
  root: () => HTMLElement | null = identityHeader,
  role: "button" | "link" = "button",
): Promise<HTMLElement> {
  return waitFor(() => {
    const header = root();
    if (header === null)
      throw new Error("the identity header is not shown yet");
    openMore(header);
    return within(header).getByRole(role, { name });
  });
}
