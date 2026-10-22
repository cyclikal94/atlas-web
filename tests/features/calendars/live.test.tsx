import { renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { CalendarApi } from "../../../src/features/calendars/api";
import { useLive } from "../../../src/features/calendars/live";

/**
 * A form's lifetime (`useLive`, WEB-13a revisions 1 and 2): the admission check of its direct requests is read when asked, and is true
 * only while the form is mounted, under the client it was opened with, online, AND allowed by the form's own current rule. Each
 * condition is checked on its own here, because a form's own rule (Link's or Manage's availability) also says "offline" and would hide
 * a missing connectivity check behind it.
 */
const api = (name: string) => ({ name }) as unknown as CalendarApi;

describe("useLive", () => {
  test("control: mounted, same client, online and admitted: live", () => {
    const { result } = renderHook(() => useLive(api("a"), true, () => true));
    expect(result.current.live()).toBe(true);
    expect(result.current.mounted()).toBe(true);
    expect(result.current.online()).toBe(true);
  });

  test("each condition alone ends admission, and is read when asked (the CURRENT answer)", () => {
    const first = api("a");
    let admitted = true;
    const { result, rerender, unmount } = renderHook(
      ({ client, online }: { client: CalendarApi; online: boolean }) =>
        useLive(client, online, () => admitted),
      { initialProps: { client: first, online: true } },
    );
    const lifetime = result.current;
    expect(lifetime.live()).toBe(true);
    admitted = false;
    expect(lifetime.live()).toBe(false);
    admitted = true;
    rerender({ client: first, online: false });
    expect(lifetime.live()).toBe(false);
    expect(lifetime.online()).toBe(false);
    rerender({ client: first, online: true });
    expect(lifetime.live()).toBe(true);
    rerender({ client: api("b"), online: true });
    expect(lifetime.live()).toBe(false);
    rerender({ client: first, online: true });
    expect(lifetime.live()).toBe(true);
    unmount();
    expect(lifetime.live()).toBe(false);
    expect(lifetime.mounted()).toBe(false);
  });

  test("without a rule of its own the form is admitted by the other three", () => {
    const { result, rerender } = renderHook(
      ({ online }: { online: boolean }) => useLive(api("a"), online),
      { initialProps: { online: true } },
    );
    expect(result.current.live()).toBe(true);
    rerender({ online: false });
    expect(result.current.live()).toBe(false);
  });
});
