import type { ReactNode } from "react";
import { calendarDataLine } from "../../calendars/your-data-line";

/**
 * Named slots of the "Your data" screen. `calendarLine` is owned by WEB-13 (WF-SETTINGS-06 tags it "owner: WEB-13"): it
 * renders where the wireframe places "If you connect a calendar, its address and password stay with you...". Since WEB-13a
 * the calendar slice supplies it (`features/calendars/your-data-line.ts`); nothing else on the screen is its to edit.
 */
export const yourDataSlots: { calendarLine: ReactNode } = {
  calendarLine: calendarDataLine,
};
