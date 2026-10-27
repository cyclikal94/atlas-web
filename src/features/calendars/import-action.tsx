import { Button } from "../../components/ui/button";
import { useOptionalDataEnv, useOutstanding } from "../../data";
import { NEEDS_DATABASE } from "./copy";
import {
  IMPORT_EVENTS,
  importEventsName,
  TURNED_OFF_IMPORT,
  VIEW_ONLY_IMPORT,
} from "./copy-import";
import { useOpenImport } from "./import-opener";
import { CONFIGURE_SOURCE } from "./model/commands";
import { displayedRow, type Enablement } from "./model/status";
import type { CalendarSourceView } from "./row-actions";

/**
 * Whether "Import events" may open for a source (WEB-13b §4.2). Composing an import never needs a connection (Q22: it queues, offline
 * included) and is allowed on a source this device is still creating (it waits for the create). It needs this device's account
 * database, edit access (a view-only source cannot be imported into: the server answers `403`), and the source on as the row shows it
 * (a turned-off source answers `422`), counting a settings change that is still waiting to send.
 */
export function importEnablement(input: {
  database: boolean;
  canEdit: boolean;
  /** Whether the source is off as the row displays it (a waiting settings change included). */
  turnedOff: boolean;
}): Enablement {
  if (!input.database) return { enabled: false, reason: NEEDS_DATABASE };
  if (!input.canEdit) return { enabled: false, reason: VIEW_ONLY_IMPORT };
  if (input.turnedOff) return { enabled: false, reason: TURNED_OFF_IMPORT };
  return { enabled: true };
}

/** The row action WEB-13b registers (`row-actions.ts`): "Import events" for one source, cached or pending. */
export function ImportAction({ source }: { source: CalendarSourceView }) {
  const env = useOptionalDataEnv();
  const open = useOpenImport();
  // The newest settings change that still applies, as the row shows it (a header read: never an import's body, `readOutstanding`).
  const outstanding = useOutstanding(source.id, CONFIGURE_SOURCE);
  const shown =
    outstanding.status === "ready"
      ? displayedRow(source.row, outstanding.value.latestOfKind)
      : source.row;
  const enablement = importEnablement({
    database: env?.service() != null && open !== null,
    canEdit: source.row.can_edit,
    turnedOff: shown.archived,
  });
  const name = importEventsName(source.label);
  return enablement.enabled ? (
    <Button aria-label={name} onClick={() => open?.open(source.id)}>
      {IMPORT_EVENTS}
    </Button>
  ) : (
    <Button aria-label={name} disabled reason={enablement.reason ?? ""}>
      {IMPORT_EVENTS}
    </Button>
  );
}
