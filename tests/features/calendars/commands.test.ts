// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createCommandRegistry } from "../../../src/data";
import { commandKindOf } from "../../../src/data/model/outbox";
import {
  BEARER_TOO_LONG,
  DESCRIBE_CONFIGURE,
  DESCRIBE_CREATE,
  LABEL_REQUIRED,
  LABEL_TOO_LONG,
  TIMEZONE_INVALID,
  URL_INVALID,
  URL_REQUIRED,
  URL_REQUIRED_FOR_REPLACE,
} from "../../../src/features/calendars/copy";
import {
  CALENDAR_COMMANDS,
  configureSourceRequest,
  createSourceRequest,
  currentSettings,
  IMPORT_ENDPOINT,
  importRequest,
  linkCommand,
  removeCommand,
  replaceCommand,
  sourceValue,
} from "../../../src/features/calendars/model/commands";
import {
  bearerError,
  labelError,
  timezoneError,
  urlError,
} from "../../../src/features/calendars/model/validation";
import {
  projectSourceCreate,
  registerCalendarCommands,
} from "../../../src/features/calendars/register";
import { draftRow } from "../../support/data/rows";

/**
 * The calendar command builders (WEB-13a, D-13a-2): which bodies may be QUEUED and which go directly. A queued body can carry no
 * secret because its builder has nowhere to put one; the direct bodies carry exactly what the contract's `CalendarCommand` names.
 */
const ID = "00000000-0000-4000-8000-0000000000c1";
const SECRET_KEYS = [
  "connection",
  "disconnect",
  "initial_policy",
  "url",
  "bearer",
];
const keysDeep = (value: unknown, out: string[] = []): string[] => {
  if (value !== null && typeof value === "object")
    for (const [key, inner] of Object.entries(value)) {
      out.push(key);
      keysDeep(inner, out);
    }
  return out;
};

describe("queued commands (create_source, configure_source)", () => {
  test("Add source builds a credential-free create on /calendar-commands, seeded at version 1, with no secret key at any depth", () => {
    const request = createSourceRequest({
      id: ID,
      label: "Family",
      timezone: "Europe/Vienna",
      localId: "L1",
    });
    expect(request.endpoint).toBe(CALENDAR_COMMANDS);
    expect(request.localId).toBe("L1");
    expect(request.targets).toEqual([
      {
        resourceId: ID,
        role: "primary",
        basis: "resource",
        versionChecked: false,
        seedIfUntracked: 1,
      },
    ]);
    const built = request.build({});
    expect(built.command).toEqual({
      command: {
        kind: "create_source",
        id: ID,
        label: "Family",
        timezone: "Europe/Vienna",
      },
    });
    for (const key of SECRET_KEYS)
      expect(keysDeep(built.command)).not.toContain(key);
    expect(commandKindOf(built.command, request.endpoint)).toBe(
      "create_source",
    );
  });

  test("a queued settings change carries timezone and enabled only, and its expected_version is the OUTBOX's base, not the cache's", () => {
    const row = {
      id: ID,
      value: { timezone: "UTC", health: "healthy", last_success: 1 },
      version: 3,
    };
    const request = configureSourceRequest(
      row,
      { timezone: "Europe/London", enabled: false },
      "L2",
    );
    expect(request.endpoint).toBe(CALENDAR_COMMANDS);
    expect(request.targets).toEqual([
      {
        resourceId: ID,
        role: "primary",
        basis: "resource",
        versionChecked: true,
      },
    ]);
    // Built on version 7: a change queued behind other changes of this source is built on the version they leave.
    const built = request.build({ [ID]: 7 });
    expect(built.command).toEqual({
      command: {
        kind: "configure_source",
        id: ID,
        expected_version: 7,
        timezone: "Europe/London",
        enabled: false,
      },
    });
    for (const key of SECRET_KEYS)
      expect(keysDeep(built.command)).not.toContain(key);
    expect(built.displayPatch).toEqual({
      [ID]: {
        archived: true,
        value: {
          timezone: "Europe/London",
          health: "healthy",
          last_success: 1,
        },
      },
    });
    expect(commandKindOf(built.command, request.endpoint)).toBe(
      "configure_source",
    );
  });

  test("the import recipe for WEB-13b: templated endpoint, the source as an UNVERSIONED primary (so a pending create gates it), and exactly {ics, from, through}", () => {
    const request = importRequest({
      sourceId: ID,
      ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      from: "2026-01-01",
      through: "2026-12-31",
    });
    expect(request.endpoint).toBe(IMPORT_ENDPOINT);
    expect(request.targetId).toBe(ID);
    expect(request.targets).toEqual([
      {
        resourceId: ID,
        role: "primary",
        basis: "resource",
        versionChecked: false,
        seedIfUntracked: 1,
      },
    ]);
    expect(Object.keys(request.build({}).command)).toEqual([
      "ics",
      "from",
      "through",
    ]);
  });
});

describe("direct (online-only) commands", () => {
  const current = { id: ID, version: 4, timezone: "UTC", enabled: true };

  test("Link is a create WITH a connection; an empty token is sent as null", () => {
    expect(
      linkCommand({
        id: ID,
        label: "Rota",
        timezone: "UTC",
        connection: { url: "https://feed.example/a.ics", bearer: "" },
      }),
    ).toEqual({
      kind: "create_source",
      id: ID,
      label: "Rota",
      timezone: "UTC",
      connection: { url: "https://feed.example/a.ics", bearer: null },
    });
  });

  test("Replace restates timezone and enabled and replaces the connection; it never says disconnect", () => {
    const command = replaceCommand(current, {
      url: "https://feed.example/b.ics",
      bearer: "t",
    });
    expect(command).toEqual({
      kind: "configure_source",
      id: ID,
      expected_version: 4,
      timezone: "UTC",
      enabled: true,
      connection: { url: "https://feed.example/b.ics", bearer: "t" },
    });
    expect(command).not.toHaveProperty("disconnect");
  });

  test("Remove clears deliberately (disconnect: true) and carries no connection", () => {
    const command = removeCommand(current);
    expect(command).toEqual({
      kind: "configure_source",
      id: ID,
      expected_version: 4,
      timezone: "UTC",
      enabled: true,
      disconnect: true,
    });
    expect(command).not.toHaveProperty("connection");
  });

  test("the current settings come from the merged row: its version, its timezone, and enabled = not archived", () => {
    expect(
      currentSettings(
        {
          id: ID,
          version: 9,
          value: { timezone: "Asia/Tokyo" },
          archived: true,
        },
        "UTC",
      ),
    ).toEqual({ id: ID, version: 9, timezone: "Asia/Tokyo", enabled: false });
    expect(
      currentSettings(
        { id: ID, version: 1, value: null, archived: false },
        "UTC",
      ).timezone,
    ).toBe("UTC");
  });
});

describe("the source value", () => {
  test("reads health, last_success (unix seconds), timezone and the read-time refresh_in_progress, defensively", () => {
    expect(
      sourceValue({
        health: "healthy",
        last_success: 1_790_000_000,
        timezone: "UTC",
        refresh_in_progress: true,
      }),
    ).toEqual({
      health: "healthy",
      lastSuccess: 1_790_000_000,
      timezone: "UTC",
      refreshInProgress: true,
    });
    expect(sourceValue(null)).toEqual({
      health: null,
      lastSuccess: null,
      timezone: null,
      refreshInProgress: null,
    });
    expect(
      sourceValue({ last_success: "x", refresh_in_progress: "yes" }),
    ).toMatchObject({
      lastSuccess: null,
      refreshInProgress: null,
    });
  });
});

describe("validation", () => {
  test("label: required, at most 300 characters (code points)", () => {
    expect(labelError("")).toBe(LABEL_REQUIRED);
    expect(labelError("   ")).toBe(LABEL_REQUIRED);
    expect(labelError("a".repeat(300))).toBeNull();
    expect(labelError("a".repeat(301))).toBe(LABEL_TOO_LONG);
    // 300 astral characters are 600 UTF-16 units and still 300 characters.
    expect(labelError("😀".repeat(300))).toBeNull();
  });
  test("timezone: an IANA name the browser knows", () => {
    expect(timezoneError("Europe/Vienna")).toBeNull();
    expect(timezoneError("UTC")).toBeNull();
    expect(timezoneError("Mars/Olympus")).toBe(TIMEZONE_INVALID);
    expect(timezoneError("")).toBe(TIMEZONE_INVALID);
  });
  test("url: required (Replace's own words), parsed, http or https only", () => {
    expect(urlError("")).toBe(URL_REQUIRED);
    expect(urlError("", "replace")).toBe(URL_REQUIRED_FOR_REPLACE);
    expect(urlError("not a url")).toBe(URL_INVALID);
    expect(urlError("ftp://feed.example/a.ics")).toBe(URL_INVALID);
    expect(urlError("https://feed.example/a.ics")).toBeNull();
    expect(urlError("http://127.0.0.1:9/a.ics")).toBeNull();
  });
  test("bearer: at most 4,096 characters", () => {
    expect(bearerError("")).toBeNull();
    expect(bearerError("x".repeat(4096))).toBeNull();
    expect(bearerError("x".repeat(4097))).toBe(BEARER_TOO_LONG);
  });
});

describe("the registry (D-13a-5)", () => {
  test("registers both queued kinds with content-free descriptions, once", () => {
    const registry = createCommandRegistry();
    registerCalendarCommands(registry);
    const create = draftRow({
      endpoint: "/calendar-commands",
      command: {
        command: {
          kind: "create_source",
          id: ID,
          label: "Secret plans",
          timezone: "UTC",
        },
      },
    });
    const configure = draftRow({
      endpoint: "/calendar-commands",
      command: { command: { kind: "configure_source", id: ID } },
    });
    expect(registry.describe(create)).toBe(DESCRIBE_CREATE);
    expect(registry.describe(configure)).toBe(DESCRIBE_CONFIGURE);
    expect(registry.describe(create)).not.toMatch(/Secret plans/);
    expect(() => registerCalendarCommands(registry)).toThrow(/twice/);
  });
  test("a queued create projects the source it will become; anything else projects nothing", () => {
    const create = draftRow({
      command: {
        command: {
          kind: "create_source",
          id: ID,
          label: "Family",
          timezone: "UTC",
        },
      },
    });
    expect(projectSourceCreate(create)).toMatchObject({
      id: ID,
      kind: "calendar_source",
      label: "Family",
      version: 1,
      archived: false,
      can_edit: true,
      value: { health: "pending", timezone: "UTC" },
    });
    expect(
      projectSourceCreate(
        draftRow({ command: { command: { kind: "configure_source" } } }),
      ),
    ).toBeNull();
    expect(
      projectSourceCreate(draftRow({ command: { kind: "edit" } })),
    ).toBeNull();
  });
});
