/**
 * The calendar slice's public surface for WEB-13b (see docs/calendars.md): the command builders (the import draft recipe included),
 * the row-action registry, the direct client and the copy. Screens of other slices import from here, never from a deeper path.
 */
export { type CalendarApi, createCalendarApi, useCalendarApi } from "./api";
export {
  CALENDAR_COMMANDS,
  CONFIGURE_SOURCE,
  CREATE_SOURCE,
  configureSourceRequest,
  createSourceRequest,
  IMPORT_ENDPOINT,
  importRequest,
  sourceValue,
} from "./model/commands";
export type {
  CalendarFailure,
  CalendarResult,
  LiveSources,
} from "./model/result";
export { projectSourceCreate, registerCalendarCommands } from "./register";
export {
  type CalendarRowAction,
  type CalendarSourceView,
  calendarRowActions,
} from "./row-actions";
