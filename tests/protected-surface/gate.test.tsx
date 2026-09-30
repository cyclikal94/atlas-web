import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  applyGate,
  getProtectedRoot,
  isGated,
  liftGate,
  mountProtectedTree,
} from "../../src/protected-surface/gate";
import {
  setNeutralTitle,
  setProtectedTitle,
} from "../../src/protected-surface/title";

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML =
    '<div id="protected-root" inert aria-hidden="true"></div>';
  root = getProtectedRoot();
  document.title = "Atlas";
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("gate primitives", () => {
  test("a root that ships inert and aria-hidden is gated", () => {
    expect(isGated(root)).toBe(true);
  });

  test("inert alone, or aria-hidden alone, is not gated", () => {
    root.removeAttribute("aria-hidden");
    expect(isGated(root)).toBe(false);
    root.setAttribute("aria-hidden", "true");
    root.removeAttribute("inert");
    expect(isGated(root)).toBe(false);
  });

  test("lift removes both; apply restores both and is idempotent", () => {
    liftGate(root);
    expect(root.hasAttribute("inert")).toBe(false);
    expect(root.hasAttribute("aria-hidden")).toBe(false);
    applyGate(root);
    applyGate(root);
    expect(isGated(root)).toBe(true);
  });

  test("getProtectedRoot throws when the root is missing", () => {
    document.body.innerHTML = "";
    expect(() => getProtectedRoot()).toThrow("Missing #protected-root");
  });

  test("mountProtectedTree renders into the root and returns an unmount function", async () => {
    let unmount = () => {};
    await act(async () => {
      unmount = mountProtectedTree(root, <p>inside</p>);
    });
    expect(root.textContent).toBe("inside");
    await act(async () => unmount());
    expect(root.textContent).toBe("");
  });
});

describe("title", () => {
  test("the neutral title is Atlas", () => {
    document.title = "Something";
    setNeutralTitle();
    expect(document.title).toBe("Atlas");
  });

  test("a protected title is a no-op while the root is gated", () => {
    setProtectedTitle(["Today"]);
    expect(document.title).toBe("Atlas");
  });

  test("a protected title is written once the gate is lifted", () => {
    liftGate(root);
    setProtectedTitle(["Today"]);
    expect(document.title).toBe("Today · Atlas");
  });

  test("with no protected root, nothing is written (fail closed)", () => {
    document.body.innerHTML = "";
    setProtectedTitle(["Today"]);
    expect(document.title).toBe("Atlas");
  });
});
