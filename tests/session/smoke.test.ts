// @vitest-environment node
import { describe, expect, test } from "vitest";
import { Fixture } from "../support/session/harness";

describe("smoke", () => {
  test("a password sign-in settles and the page displays", async () => {
    const f = new Fixture();
    f.server.addAccount("kieran", "pw");
    const page = f.addPage();
    await f.boot(page);
    expect(page.session.view.get()).toMatchObject({ kind: "signed_out" });
    const outcome = await f.signIn(page, "kieran", "pw");
    expect(outcome).toMatchObject({ kind: "settled" });
    await f.settle();
    expect(page.session.view.get()).toMatchObject({ kind: "displaying" });
    expect(page.surface.mounted).not.toBeNull();
    expect(f.store.violations).toEqual([]);
    const record = f.store.records.auth_state;
    expect(record.settled?.epoch).toBe(1);
    expect(record.attempt).toBeNull();
    expect(Object.keys(record.leases)).toEqual([]);
  });
});
