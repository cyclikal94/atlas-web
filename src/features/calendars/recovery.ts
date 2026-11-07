import { createContext, useContext } from "react";

/**
 * WEB-14a revision 37 (R40): the calendar forms' recovery around an app-update reload (Q4). The displayed identity the screen's forms'
 * recoverable models belong to (`lib/form-recovery/editor.ts`), null while the screen has no client; and the Manage form's codec: only
 * the settings the person edited (a field not edited follows the source), never a connection secret.
 */
export const CalendarRecoveryIdentity = createContext<string | null>(null);
export const useCalendarRecoveryIdentity = () =>
  useContext(CalendarRecoveryIdentity);

export const manageContext = (sourceId: string) =>
  `calendar-source:${sourceId}`;

export type ManageInput = { timezone: string | null; enabled: boolean | null };

export const encodeManage = (input: ManageInput): string =>
  JSON.stringify({ v: 1, timezone: input.timezone, enabled: input.enabled });

export function decodeManage(text: string): ManageInput | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object" || raw.v !== 1) return null;
    const { timezone, enabled } = raw;
    if (timezone !== null && typeof timezone !== "string") return null;
    if (enabled !== null && typeof enabled !== "boolean") return null;
    return { timezone, enabled };
  } catch {
    return null;
  }
}
