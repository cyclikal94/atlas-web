import { useMemo, useSyncExternalStore } from "react";
import type { AccountId, Epoch } from "../../data";
import { recogniseAtlasError } from "../../lib/api-client/problem";
import { type Session, StampedRequestError, useSession } from "../../session";
import { NOT_SENT_DELAYS_MS } from "../settings/sessions-devices/until-sent";
import type { DirectCommand } from "./model/commands";
import type {
  CalendarFailure,
  CalendarResult,
  LiveSource,
  LiveSources,
} from "./model/result";

/**
 * The DIRECT calendar requests of WEB-13a: the online-only commands (a connection is linked, replaced or removed), the manual refresh,
 * the live list of sources (its read-time `refresh_in_progress`) and the capability read. Every request goes through the session's
 * stamped client for the displayed identity (`ordinary`, account, epoch), so an answer that arrives after the identity changed is
 * dropped by the session (`stale`) and is never shown under another account.
 *
 * Nothing here is stored: a body, a key and a live value live in the caller's memory only. Every answer is classified once
 * (`model/result.ts`) and every body is validated strictly; a TypeScript type is not validation.
 */
export interface CalendarApi {
  /** The identity every request of this client is stamped with. */
  readonly identity: { account: AccountId; epoch: Epoch };
  /** `POST /calendar-commands {command}` with `Idempotency-Key: key`: the ONLINE-ONLY commands only (never a queued one). */
  command(
    command: DirectCommand,
    key: string,
    live?: Live,
  ): Promise<CalendarResult<{ revision: number }>>;
  /** `POST /calendar-sources/{id}/refresh` (no body) with `Idempotency-Key: key`. */
  refresh(
    sourceId: string,
    key: string,
    live?: Live,
  ): Promise<CalendarResult<{ revision: number }>>;
  /** `GET /calendar-sources?limit=200`, at most `LIVE_PAGES` pages: what the server says NOW, held in memory only. */
  liveSources(live?: Live): Promise<CalendarResult<LiveSources>>;
  /** `GET /notification-capabilities`: whether this server can hold calendar connections. */
  capabilities(
    live?: Live,
  ): Promise<CalendarResult<{ calendarLinks: boolean }>>;
}

/**
 * Whether the CALLER still wants its request (its screen is mounted, its form open, its refresh run current, the page online). Asked
 * before every admission of the request, the first and each one after a `not_sent`: a request whose caller has gone is never sent,
 * and its answer is `closed`. The session's stamp cannot do this alone: a caller can go (a closed form, a left screen) while the
 * identity it was stamped for is still the displayed one.
 */
export type Live = () => boolean;

export const LIVE_PAGE_SIZE = 200;
export const LIVE_PAGES = 5;

interface Answer {
  data?: unknown;
  error?: unknown;
  response: Response;
}

type Sleep = (ms: number) => Promise<void>;
const wait: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `IntegrationReceipt`: exactly `{revision}`, an integer of at least 0 (a revision of zero is a valid receipt). */
export function decodeReceipt(data: unknown): { revision: number } | null {
  if (!isObject(data)) return null;
  const keys = Object.keys(data);
  if (keys.length !== 1 || keys[0] !== "revision") return null;
  const revision = data.revision;
  return typeof revision === "number" &&
    Number.isInteger(revision) &&
    revision >= 0
    ? { revision }
    : null;
}

/** One page of `ResourcePage` for calendar sources: each item's id, its read-time `refresh_in_progress` and its health. */
export function decodeSourcePage(
  data: unknown,
): { items: Array<[string, LiveSource]>; next: string | null } | null {
  if (!isObject(data) || !Array.isArray(data.items)) return null;
  const next = data.next_after;
  if (next !== null && typeof next !== "string") return null;
  const items: Array<[string, LiveSource]> = [];
  for (const item of data.items) {
    if (!isObject(item) || typeof item.id !== "string") return null;
    if (item.kind !== "calendar_source") return null;
    const value = item.value;
    if (value !== null && !isObject(value)) return null;
    const flag = value?.refresh_in_progress;
    if (typeof flag !== "boolean") return null;
    const health = value?.health;
    items.push([
      item.id,
      {
        refreshInProgress: flag,
        health: typeof health === "string" ? health : null,
      },
    ]);
  }
  return { items, next };
}

export function decodeCapabilities(
  data: unknown,
): { calendarLinks: boolean } | null {
  return isObject(data) && typeof data.calendar_links === "boolean"
    ? { calendarLinks: data.calendar_links }
    : null;
}

const STALE_REASONS = ["generation_changed", "lease_expired"];

/** Turns one answer of the typed client into a classified result. */
export function classifyAnswer<T>(
  answer: Answer,
  decode: (data: unknown) => T | null,
): CalendarResult<T> {
  const { response } = answer;
  if (response.ok) {
    const value = decode(answer.data);
    return value === null
      ? { ok: false, kind: "uncertain", status: response.status }
      : { ok: true, value };
  }
  const atlas = recogniseAtlasError(
    response.headers.get("content-type"),
    answer.error,
  );
  if (atlas === null)
    return { ok: false, kind: "uncertain", status: response.status };
  const reason = isObject(answer.error) ? answer.error.reason : undefined;
  return {
    ok: false,
    kind: "refused",
    status: response.status,
    code: atlas.code,
    requestId: atlas.request_id,
    ...(typeof reason === "string" && STALE_REASONS.includes(reason)
      ? { reason }
      : {}),
  };
}

/** What a thrown error of the stamped client means. */
export function classifyThrown(error: unknown): CalendarFailure {
  if (error instanceof StampedRequestError) {
    switch (error.kind) {
      case "not_sent":
      case "not_covered":
        return { kind: "not_sent" };
      default:
        // `stale` (the identity changed while it ran), `closed`, `closed_unresolved`, `auth_state`: this answer is not the screen's.
        return { kind: "closed" };
    }
  }
  // A network error, an abort or a time-out: it may have reached the server.
  return { kind: "uncertain" };
}

/**
 * Calls once, and again while the session says it did not send (`not_sent` is a hold of a moment, typically the verification after
 * display): bounded, about six seconds, after which `not_sent` is the answer. Nothing was sent by any of those calls. The caller's
 * `live` is asked before EVERY call, the first included: once it says no, nothing more is admitted and the answer is `closed`.
 */
export async function untilSent<T>(
  call: () => Promise<CalendarResult<T>>,
  sleep: Sleep = wait,
  live: Live = () => true,
): Promise<CalendarResult<T>> {
  for (let attempt = 0; ; attempt += 1) {
    if (!live()) return { ok: false, kind: "closed" };
    const result = await call();
    if (result.ok || result.kind !== "not_sent") return result;
    const delay = NOT_SENT_DELAYS_MS[attempt];
    if (delay === undefined) return result;
    await sleep(delay);
  }
}

export function createCalendarApi(
  session: Pick<Session, "api">,
  account: AccountId,
  epoch: Epoch,
  options: { sleep?: Sleep } = {},
): CalendarApi {
  const sleep = options.sleep ?? wait;
  const client = () => session.api.client("ordinary", account, epoch);
  const once = async <T>(
    run: () => Promise<Answer>,
    decode: (data: unknown) => T | null,
  ): Promise<CalendarResult<T>> => {
    try {
      return classifyAnswer(await run(), decode);
    } catch (error) {
      return { ok: false, ...classifyThrown(error) };
    }
  };
  const call = <T>(
    run: () => Promise<Answer>,
    decode: (data: unknown) => T | null,
    live: Live | undefined,
  ) => untilSent(() => once(run, decode), sleep, live);

  return {
    identity: { account, epoch },
    command: (command, key, live) =>
      call(
        () =>
          client().POST("/calendar-commands", {
            params: { header: { "Idempotency-Key": key } },
            body: { command } as never,
          }) as Promise<Answer>,
        decodeReceipt,
        live,
      ),
    refresh: (sourceId, key, live) =>
      call(
        () =>
          client().POST("/calendar-sources/{id}/refresh", {
            params: {
              header: { "Idempotency-Key": key },
              path: { id: sourceId },
            },
          }) as Promise<Answer>,
        decodeReceipt,
        live,
      ),
    async liveSources(live) {
      const sources = new Map<string, LiveSource>();
      let after: string | null = null;
      for (let page = 0; page < LIVE_PAGES; page += 1) {
        const query: { limit: number; after?: string } = {
          limit: LIVE_PAGE_SIZE,
          ...(after === null ? {} : { after }),
        };
        const result = await call(
          () =>
            client().GET("/calendar-sources", {
              params: { query },
            }) as Promise<Answer>,
          decodeSourcePage,
          live,
        );
        if (!result.ok) return result;
        for (const [id, source] of result.value.items) sources.set(id, source);
        after = result.value.next;
        if (after === null)
          return { ok: true, value: { sources, complete: true } };
      }
      return { ok: true, value: { sources, complete: false } };
    },
    capabilities: (live) =>
      call(
        () => client().GET("/notification-capabilities") as Promise<Answer>,
        decodeCapabilities,
        live,
      ),
  };
}

/**
 * The calendar client of the DISPLAYED identity, or null while none is displayed. A new identity (another account, a new epoch) is a
 * new client, so nothing a screen holds can be sent or shown under the next one.
 */
export function useCalendarApi(): CalendarApi | null {
  const session = useSession();
  const identity = useSyncExternalStore(
    (listener) => session.identity.subscribe(listener),
    () => session.identity.get(),
    () => session.identity.get(),
  );
  const account = identity?.account_id ?? null;
  const epoch = identity?.epoch ?? null;
  return useMemo(
    () =>
      account === null || epoch === null
        ? null
        : createCalendarApi(session, account, epoch),
    [session, account, epoch],
  );
}
