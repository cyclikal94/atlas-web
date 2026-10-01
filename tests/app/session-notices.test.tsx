import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  REMAINED_SIGNED_IN,
  SessionNotices,
} from "../../src/app/SessionNotices";
import { AnnouncerProvider } from "../../src/components/ui/announcer";
import { SessionProvider } from "../../src/session";
import { sessionDouble, store } from "../helpers/session-double";

afterEach(cleanup);

describe("session notices", () => {
  test("nothing is drawn without a notice", () => {
    const { container } = render(
      <SessionProvider session={sessionDouble()}>
        <AnnouncerProvider>
          <SessionNotices />
        </AnnouncerProvider>
      </SessionProvider>,
    );
    expect(container.querySelector("[data-notice]")).toBeNull();
  });

  test("'still signed in' is said once, carries no account data, and is dismissed by the person", () => {
    const dismissNotice = vi.fn();
    const session = sessionDouble(
      {},
      {
        notices: store([{ id: "n1", kind: "remained_signed_in" as const }]),
        dismissNotice,
      },
    );
    render(
      <SessionProvider session={session}>
        <AnnouncerProvider>
          <SessionNotices />
        </AnnouncerProvider>
      </SessionProvider>,
    );
    expect(screen.getByText(REMAINED_SIGNED_IN)).toBeInTheDocument();
    expect(REMAINED_SIGNED_IN).not.toMatch(/acct|@|kieran/i);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissNotice).toHaveBeenCalledWith("n1");
  });
});
