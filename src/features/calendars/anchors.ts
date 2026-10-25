/**
 * The calendar slice's anchor surface for other slices (WEB-13b; see docs/calendars.md): the anchor-configuration panel, the anchor model
 * and its queued command, and the "Anchor review needed" pieces the task screens use. A narrow entry of its own, so a task screen that
 * imports it does not take the calendar screen's modules along.
 */
export { AnchorDialog, type AnchorKept } from "./AnchorDialog";
export {
  type AnchorDraft,
  type AnchorNames,
  anchorDraftOf,
  anchorOfCommand,
  type CalendarAnchor,
  describeAnchor,
  EMPTY_ANCHOR,
  setAnchorRequest,
  validateAnchor,
} from "./model/anchor";
