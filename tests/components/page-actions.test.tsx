import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { PageActions } from "../../src/components/ui/page-actions";
import { installMatchMedia } from "../helpers/match-media";

/** The Final design (8 November 2026): a page header's actions fold behind one disclosure on the phone, and sit in a row from the tablet up. */
const media = installMatchMedia({ width: 1440 });
afterEach(cleanup);

describe("PageActions", () => {
  test("from the tablet up the controls are in a row, with no disclosure", () => {
    media.set({ width: 1024 });
    render(
      <PageActions>
        <button type="button">Rename</button>
        <button type="button">Archive</button>
      </PageActions>,
    );
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  test("on the phone the controls are folded behind Actions, and shown in place when opened", () => {
    media.set({ width: 390 });
    render(
      <PageActions>
        <button type="button">Rename</button>
        <button type="button">Archive</button>
      </PageActions>,
    );
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Actions" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const row = document.getElementById(
      toggle.getAttribute("aria-controls") as string,
    );
    expect(row).not.toBeNull();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });
});
