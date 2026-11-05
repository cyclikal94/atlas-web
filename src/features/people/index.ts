/**
 * WEB-11a's PUBLIC INTERFACE for WEB-11b and WEB-12b (docs/people.md). Import the people screens and model from here, never from a deeper
 * path.
 *  - `peopleSlots`: WEB-11b fills `headerActions` ("Ask to link…") and `duplicateActions` ("Compare & merge"); WEB-11a renders nothing in them.
 *  - `usePersonLinkage(personId)`: who controls a profile, from an online `GET /people/{id}` only (never inferred), with Try again.
 *  - `personPath`, `duplicatesPath`: deep links.
 *  - the field value model (parse, validate, format) for every `FieldValue` kind.
 *  - `PeopleBoundary`: the people env (and the sharing env it builds on) for a screen outside the People routes.
 *  - `archivedLedgerKinds`: where WEB-10a/WEB-10b add their kinds to Settings → "Archived items".
 *  - `registerPeopleCommands`: the queue registrations (called once by the protected tree).
 */
export {
  type ArchivedLedgerKind,
  archivedLedgerKinds,
  type LedgerReport,
} from "./archived/ledger";
export type { PersonDetailSlots } from "./detail/PersonDetail";
export { PeopleBoundary, type PeopleEnv, PeopleEnvProvider } from "./env";
export type { LinkageState } from "./model/linkage";
export {
  type FieldKind,
  type FieldValue,
  formatDate,
  formatValue,
  labelProblem,
  parseFieldValue,
  valueProblem,
} from "./model/values";
export { usePersonLinkage } from "./reads";
export { registerPeopleCommands } from "./register";
export { duplicatesPath, peopleSlots, personPath } from "./route";
