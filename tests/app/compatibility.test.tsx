import { cleanup, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import { CompatibilityScreen } from "../../src/app/CompatibilityScreen";
import { NeutralEntry } from "../../src/app/NeutralEntry";

afterEach(cleanup);

describe("CompatibilityScreen", () => {
  test("names every failing requirement and states the supported browsers", async () => {
    const { container } = render(
      <CompatibilityScreen
        issues={[
          { id: "web-locks", reason: "absent" },
          { id: "secure-context", reason: "absent" },
        ]}
      />,
    );
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Atlas can't open in this browser",
      }),
    ).toHaveFocus();
    expect(screen.getByText(/does not provide Web Locks/)).toBeInTheDocument();
    expect(screen.getByText(/secure connection \(HTTPS\)/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /current or previous version of Chrome, Edge, Firefox or Safari/,
      ),
    ).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  test.each([
    ["indexeddb", /IndexedDB/],
    ["inert", /too old/],
  ] as const)("%s has its own explanation", (id, pattern) => {
    render(<CompatibilityScreen issues={[{ id, reason: "failed" }]} />);
    expect(screen.getByText(pattern)).toBeInTheDocument();
  });

  test("offers no way past it: no button, no link", () => {
    render(
      <CompatibilityScreen issues={[{ id: "web-locks", reason: "absent" }]} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("NeutralEntry", () => {
  test("shows only the neutral heading and the provisional line, with no account data", async () => {
    const { container } = render(<NeutralEntry />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Atlas" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Sign-in isn't available in this build yet."),
    ).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
});
