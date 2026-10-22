import type {
  CacheRow,
  EnqueueRequest,
  JsonObject,
  LocalId,
  Observation,
  ResourceId,
} from "../../../data";

/**
 * The calendar commands (WEB-13a, D-13a-2): which travel through the OUTBOX and which go DIRECTLY, chosen per command and never per
 * connectivity.
 *
 *  - Queued (offline or online): `create_source` WITHOUT `connection` and `initial_policy`, and `configure_source` WITHOUT `connection`
 *    and `disconnect` (timezone and enabled only). Q22 lets both queue: they carry nothing secret, and the backend preserves a stored
 *    connection when `connection` is omitted (BE-Q22).
 *  - Direct (online only, never stored): `create_source` with a connection ("Link a calendar…"), `configure_source` with a connection
 *    ("Replace…") or with `disconnect: true` ("Remove…"), and the manual refresh. A secret never reaches a draft, a body store or a
 *    recovery copy, because the queued builders below have no parameter that could carry one.
 *
 * Every body is `{command: {kind, ...}}` (`CalendarCommandInput`). The import draft (`importRequest`) is WEB-13b's to build a screen
 * for; it is here so the dynamic-routing recipe is one tested function (case 2).
 */
export const CALENDAR_COMMANDS = "/calendar-commands";
export const IMPORT_ENDPOINT = "/calendar-sources/{id}/import";
export const CREATE_SOURCE = "create_source";
export const CONFIGURE_SOURCE = "configure_source";

/** A connection as the person typed it: held in a form's memory only, and only for a direct command. */
export interface Connection {
  url: string;
  /** Empty means none (sent as `null`). */
  bearer: string;
}

/** The values of a calendar source projection the screens read (`{health, last_success, coverage_*, timezone}`). */
export interface SourceValue {
  health: string | null;
  /** Unix seconds of the last successful refresh, or null. */
  lastSuccess: number | null;
  timezone: string | null;
  /** Read-time only (`GET /calendar-sources`), never in the synced cache; null when absent. */
  refreshInProgress: boolean | null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

export function sourceValue(value: JsonObject | null | undefined): SourceValue {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    health: text(v.health),
    lastSuccess:
      typeof v.last_success === "number" && Number.isFinite(v.last_success)
        ? v.last_success
        : null,
    timezone: text(v.timezone),
    refreshInProgress:
      typeof v.refresh_in_progress === "boolean" ? v.refresh_in_progress : null,
  };
}

// ---- queued ---------------------------------------------------------------------------------------------------------------------
/**
 * "Add source": a credential-free create. The source's id is minted by the caller (so a retry of a save whose completion was lost
 * names the same source) and becomes the draft's only target, seeded at version 1 so that a later settings change against the
 * still-pending source is built on version 1 and waits for the create (`depends_on`).
 */
export function createSourceRequest(input: {
  id: ResourceId;
  label: string;
  timezone: string;
  localId?: LocalId;
}): EnqueueRequest {
  const { id, label, timezone } = input;
  return {
    endpoint: CALENDAR_COMMANDS,
    targets: [
      {
        resourceId: id,
        role: "primary",
        basis: "resource",
        versionChecked: false,
        seedIfUntracked: 1,
      },
    ],
    build: () => ({
      command: { command: { kind: CREATE_SOURCE, id, label, timezone } },
      displayPatch: { [id]: { label, value: { timezone } } },
    }),
    ...(input.localId === undefined ? {} : { localId: input.localId }),
  };
}

/**
 * A queued settings change (timezone, enabled). `expected_version` is the version the OUTBOX assumes at the moment the draft is built
 * (`bases`), never the cached row's: a change saved behind another queued change of the same source is built on that change.
 *
 * `observed` is what the dialog read when it chose the values (revision 2): both fields are restated, so a value the person did not touch
 * is only as current as that read. With it, the outbox writes the change only if the transaction that picks the version still reads the
 * same source and the same drafts; otherwise nothing is stored (`refused / changed`), and the person sees the new values first.
 */
export function configureSourceRequest(
  row: Pick<CacheRow, "id" | "value">,
  settings: { timezone: string; enabled: boolean },
  localId?: LocalId,
  observed?: Observation,
): EnqueueRequest {
  const { id } = row;
  const { timezone, enabled } = settings;
  return {
    endpoint: CALENDAR_COMMANDS,
    targets: [
      {
        resourceId: id,
        role: "primary",
        basis: "resource",
        versionChecked: true,
      },
    ],
    build: (bases) => ({
      command: {
        command: {
          kind: CONFIGURE_SOURCE,
          id,
          expected_version: bases[id] as number,
          timezone,
          enabled,
        },
      },
      displayPatch: {
        [id]: {
          archived: !enabled,
          value: {
            ...((row.value ?? {}) as Record<string, unknown>),
            timezone,
          },
        },
      },
    }),
    ...(localId === undefined ? {} : { localId }),
    ...(observed === undefined ? {} : { observed }),
  };
}

/**
 * The import draft of WEB-13b (case 2, the dynamic-routing extension): addressed to `/calendar-sources/{id}/import` through
 * `targetId`, with the source as an UNVERSIONED primary target, so a pending create of that source is a dependency (`depends_on`) and
 * the import is never sent before the source exists. The body is `{ics, from, through}` exactly, so a resend is byte-identical.
 */
export function importRequest(input: {
  sourceId: ResourceId;
  ics: string;
  from: string;
  through: string;
  localId?: LocalId;
}): EnqueueRequest {
  const { sourceId, ics, from, through } = input;
  return {
    endpoint: IMPORT_ENDPOINT,
    targetId: sourceId,
    targets: [
      {
        resourceId: sourceId,
        role: "primary",
        basis: "resource",
        versionChecked: false,
        seedIfUntracked: 1,
      },
    ],
    build: () => ({ command: { ics, from, through } }),
    ...(input.localId === undefined ? {} : { localId: input.localId }),
  };
}

// ---- direct (online only) -----------------------------------------------------------------------------------------------------------
export type DirectCommand = JsonObject & { kind: string; id: ResourceId };

const wire = (connection: Connection) => ({
  url: connection.url,
  bearer: connection.bearer === "" ? null : connection.bearer,
});

/** "Link a calendar…": a create WITH a connection. Sent directly; a retry resends the identical body under the identical key. */
export function linkCommand(input: {
  id: ResourceId;
  label: string;
  timezone: string;
  connection: Connection;
}): DirectCommand {
  return {
    kind: CREATE_SOURCE,
    id: input.id,
    label: input.label,
    timezone: input.timezone,
    connection: wire(input.connection),
  };
}

/** The current settings a direct configure must restate (both are required by the contract). */
export interface CurrentSettings {
  id: ResourceId;
  version: number;
  timezone: string;
  enabled: boolean;
}

/** "Replace…": the connection is replaced; timezone and enabled are restated from the merged row. */
export function replaceCommand(
  current: CurrentSettings,
  connection: Connection,
): DirectCommand {
  return {
    kind: CONFIGURE_SOURCE,
    id: current.id,
    expected_version: current.version,
    timezone: current.timezone,
    enabled: current.enabled,
    connection: wire(connection),
  };
}

/** "Remove…": the stored connection is cleared, deliberately (`disconnect: true`), never by omission. */
export function removeCommand(current: CurrentSettings): DirectCommand {
  return {
    kind: CONFIGURE_SOURCE,
    id: current.id,
    expected_version: current.version,
    timezone: current.timezone,
    enabled: current.enabled,
    disconnect: true,
  };
}

/** The current settings of a source as the merged (overlaid) row says them. */
export function currentSettings(
  row: Pick<CacheRow, "id" | "version" | "value" | "archived">,
  fallbackTimezone: string,
): CurrentSettings {
  return {
    id: row.id,
    version: row.version,
    timezone: sourceValue(row.value).timezone ?? fallbackTimezone,
    enabled: !row.archived,
  };
}
