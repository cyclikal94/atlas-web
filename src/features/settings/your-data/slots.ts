import type { ReactNode } from "react";

/**
 * Named slots of the "Your data" screen. `calendarLine` is owned by WEB-13 (WF-SETTINGS-06 tags it "owner: WEB-13"): it
 * renders where the wireframe places "If you connect a calendar, its address and password stay with you...". WEB-13a
 * replaces this constant when it adds its section; nothing else on the screen is its to edit.
 */
export const yourDataSlots: { calendarLine: ReactNode } = {
  calendarLine:
    "If you connect a calendar, its address and password stay with you — they're never shared or synced to other devices.",
};
