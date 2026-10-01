import { cleanup, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import pin from "../../contract-pin.json";
import {
  API_EXPLANATION,
  API_HEADING,
} from "../../src/app/CompatibilityScreen";
import { SessionRoot } from "../../src/app/SessionRoot";
import type { ApiCompatibility, SessionView } from "../../src/session";
import { formatRange, rangeFromPin, SessionProvider } from "../../src/session";
import { sessionDouble, store } from "../helpers/session-double";
import { Fixture } from "../support/session/harness";
import { bootstrapSettled } from "../support/session/matrix-exposure";

afterEach(cleanup);

/**
 * F-API: the API-version compatibility check (D-08, EC-45) and what it gates. The table of versions is in
 * `model/api-version.test.ts`; here is the end-to-end check through the stub server's `/health`, and the screen.
 */
describe("the check against the stub server's /health (F-API)", () => {
  const boot = async (apiVersion: string | undefined) => {
    const f = new Fixture();
    f.server.apiVersion = apiVersion;
    const page = f.addPage();
    await f.boot(page);
    await f.settle();
    return { f, page };
  };

  test.each([
    ["0.27.0", "supported"],
    ["0.27.10", "supported"],
    ["0.28.0", "unsupported"],
    ["0.26.9", "unsupported"],
    ["0.27.0-rc.1", "missing"],
    [undefined, "missing"],
  ] as const)("api_version %j is %s", async (version, status) => {
    const { page } = await boot(version);
    expect(page.session.compat.get().status).toBe(status);
  });

  test("an unsupported answer names the supported range, derived from the contract pin", async () => {
    const { page } = await boot("0.28.0");
    expect(page.session.compat.get()).toEqual({
      status: "unsupported",
      version: "0.28.0",
      supported: formatRange(rangeFromPin(pin.version)),
    });
    expect(formatRange(rangeFromPin(pin.version))).toBe(">=0.27.0 <0.28.0");
  });

  test("a server that cannot be reached is 'unreachable', never a refusal", async () => {
    const f = new Fixture();
    const page = f.addPage();
    page.env.online = false;
    await f.boot(page);
    await f.settle();
    expect(page.session.compat.get()).toEqual({ status: "unreachable" });
  });

  test("the check never hides an eligible account that is already settled (offline continuation, row 6)", async () => {
    const f = new Fixture();
    f.server.apiVersion = "0.99.0";
    await bootstrapSettled(f, { epoch: 1, fences: "none" });
    const page = f.addPage();
    page.env.online = false;
    await f.boot(page);
    await f.settle();
    expect(page.session.view.get().kind).toBe("displaying");
    expect(page.session.compat.get().status).toBe("unreachable");
  });

  test("an unsupported server does not hide a settled account when online either; only sign-in is gated", async () => {
    const f = new Fixture();
    f.server.apiVersion = "0.28.0";
    await bootstrapSettled(f, { epoch: 1, fences: "none" });
    const page = f.addPage();
    await f.boot(page);
    await f.settle();
    expect(page.session.compat.get().status).toBe("unsupported");
    expect(page.session.view.get().kind).toBe("displaying");
  });
});

describe("the screen and the sign-in gate (F-API)", () => {
  const mount = (view: SessionView, compat: ApiCompatibility) =>
    render(
      <SessionProvider
        session={sessionDouble(
          {},
          { view: store(view), compat: store(compat) },
        )}
      >
        <SessionRoot />
      </SessionProvider>,
    );

  test("signed out and unsupported: the compatibility screen replaces the sign-in entry", async () => {
    const { container } = mount(
      { kind: "signed_out", state: null },
      {
        status: "unsupported",
        version: "0.28.0",
        supported: ">=0.27.0 <0.28.0",
      },
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      API_HEADING,
    );
    expect(screen.getByText(API_EXPLANATION.unsupported)).toBeInTheDocument();
    expect(screen.queryByText(/Sign-in isn't available/)).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  test("signed out and missing: the other wording", () => {
    mount({ kind: "signed_out", state: null }, { status: "missing" });
    expect(screen.getByText(API_EXPLANATION.missing)).toBeInTheDocument();
  });

  test.each([
    [{ status: "supported", version: "0.27.0" }],
    [{ status: "unknown" }],
    [{ status: "unreachable" }],
  ] as const)("signed out and %j: the entry is offered as usual", (compat) => {
    mount({ kind: "signed_out", state: null }, compat);
    expect(
      screen.getByText("Sign-in isn't available in this build yet."),
    ).toBeInTheDocument();
    expect(screen.queryByText(API_HEADING)).toBeNull();
  });

  test("the proposed wording is disclosed as unaccepted (design gap G-6) and names no server details", () => {
    expect(API_HEADING).toBe("Atlas can't work with this server yet");
    for (const text of Object.values(API_EXPLANATION))
      expect(text).not.toMatch(/0\.\d+\.\d+|localhost|http/);
  });
});

describe("a page that knows it is offline (row 6: no network call)", () => {
  test("the check sends NO request, reports unreachable, and asks again when connectivity returns", async () => {
    const f = new Fixture();
    const page = f.addPage();
    page.env.online = false;
    await f.boot(page);
    await f.settle();
    expect(page.session.compat.get()).toEqual({ status: "unreachable" });
    expect(f.server.requests.filter((r) => r.path === "/health")).toEqual([]);
    page.goOnline();
    await f.settle();
    expect(page.session.compat.get()).toMatchObject({ status: "supported" });
    expect(f.server.requests.filter((r) => r.path === "/health")).toHaveLength(
      1,
    );
  });

  test("a check that finds the server supported is not repeated by later online events", async () => {
    const f = new Fixture();
    const page = f.addPage();
    await f.boot(page);
    await f.settle();
    page.goOffline();
    page.goOnline();
    await f.settle();
    expect(f.server.requests.filter((r) => r.path === "/health")).toHaveLength(
      1,
    );
  });
});
