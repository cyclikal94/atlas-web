import type { BrowserContext, Page, Route } from "@playwright/test";
import { serveIdentityReads } from "./data-local-faults";
import {
  ACCOUNT,
  dataPage,
  type SyncStub,
  seedSettled,
  startOutbox,
  stubNetwork,
  untilTreeSettled,
} from "./data-sync-helpers";
import { expect } from "./helpers";

/**
 * WEB-13b's native fixture helpers (E-IMP, E-ANC, E-REV): the PRODUCTION composition (`/__session`: the production session, its adapters,
 * the protected tree with its `DataProvider` and the application's registries, Dexie and real IndexedDB), the network stubbed by
 * `context.route`, and the data harness's fixture leader sending what the screens queue (its conflict registry has the import's terminal
 * answers, as the page host's has). A copy of WEB-13a's in-file helpers of `fixture.calendars.spec.ts` (that accepted spec is unchanged),
 * plus the task binding read and a booted page at any route. FIXTURE evidence: no backend behind any of it.
 */
export const API = "/api/experimental/v1";
export { ACCOUNT };

export interface Wire {
  method: string;
  path: string;
  key: string | null;
  body: string;
  /** The test's phase when the request arrived. */
  phase: string;
  at: number;
}
export type Answer =
  | { status: number; body: unknown; contentType?: string }
  | { abort: true }
  | { wait: Promise<{ status: number; body: unknown }> }
  | ((
      wire: Wire,
    ) =>
      | { status: number; body: unknown; contentType?: string }
      | { abort: true });

/** The calendar endpoints and the task binding read, scripted: every request recorded; each path answers from its queue, then its default. */
export interface CalendarStub {
  wire: Wire[];
  answers: Map<string, Answer[]>;
  /** `GET /calendar-sources`'s items. */
  live: Array<Record<string, unknown>>;
  /** `GET /tasks/{id}/anchor`'s default answer. */
  binding: unknown;
  phase: string;
}

/** The answers' keys: the path with any id replaced by `*` (`/calendar-sources/*\/import`, `/tasks/*\/anchor`). */
export const pathKey = (path: string): string =>
  path.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    "/*",
  );

export async function stubCalendars(
  context: BrowserContext,
): Promise<CalendarStub> {
  const stub: CalendarStub = {
    wire: [],
    answers: new Map(),
    live: [],
    binding: { binding: null },
    phase: "open",
  };
  let revision = 200;
  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(API, "");
    const wire: Wire = {
      method: request.method(),
      path,
      key: request.headers()["idempotency-key"] ?? null,
      body: request.postData() ?? "",
      phase: stub.phase,
      at: Date.now(),
    };
    stub.wire.push(wire);
    const queue = stub.answers.get(pathKey(path)) ?? [];
    let next = queue.shift();
    if (typeof next === "function") next = next(wire);
    if (next !== undefined && "wait" in next) next = await next.wait;
    if (next === undefined) {
      if (path === "/notification-capabilities")
        next = {
          status: 200,
          body: {
            calendar_links: true,
            ntfy: false,
            web_push: false,
            native_local: false,
            apns: false,
            fcm: false,
            vapid_public_key: null,
          },
        };
      else if (path === "/calendar-sources")
        next = { status: 200, body: { items: stub.live, next_after: null } };
      else if (/^\/tasks\/[^/]+\/anchor$/.test(path))
        next = { status: 200, body: stub.binding };
      else {
        revision += 1;
        next = { status: 200, body: { revision } };
      }
    }
    if ("abort" in next) return route.abort("connectionreset");
    return route.fulfill({
      status: next.status,
      contentType:
        "contentType" in next && next.contentType !== undefined
          ? next.contentType
          : "application/json",
      body:
        typeof next.body === "string" ? next.body : JSON.stringify(next.body),
    });
  };
  await context.route(`**${API}/calendar-commands`, handle);
  await context.route(`**${API}/calendar-sources`, handle);
  await context.route(`**${API}/calendar-sources?*`, handle);
  await context.route(`**${API}/calendar-sources/*/refresh`, handle);
  await context.route(`**${API}/calendar-sources/*/import`, handle);
  await context.route(`**${API}/notification-capabilities`, handle);
  await context.route(`**${API}/tasks/*/anchor`, handle);
  return stub;
}

export const atlasBody = (
  code: string,
  extra: Record<string, unknown> = {},
) => ({
  code,
  message: "m",
  request_id: "22222222-2222-4222-8222-222222222222",
  details: [],
  ...extra,
});

/** A projection as the cache holds it (`kind_date` included). */
export const projection = (over: Record<string, unknown>) => ({
  parent_id: null,
  value: null,
  version: 1,
  can_edit: true,
  archived: false,
  kind_date: null,
  ...over,
});

export const sourceProjection = (
  id: string,
  over: Record<string, unknown> = {},
) =>
  projection({
    id,
    kind: "calendar_source",
    label: "Work rota",
    value: {
      health: "healthy",
      last_success: 1_790_000_000,
      coverage_start: null,
      coverage_end: null,
      timezone: "Europe/London",
    },
    version: 2,
    ...over,
  });

/** The rows of one store of the account database, read through the data harness (reopening its own handle after a remount). */
export const rows = (page: Page, store: string) =>
  page.evaluate(
    async ({ a, s }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      try {
        return await data.rows(a, s as never);
      } catch (error) {
        if (!String(error).includes("no open store")) throw error;
        data.setIdentity(a);
        const opened = await data.open(a, { create: false });
        if (opened !== "opened") throw new Error(`open: ${opened}`);
        return await data.rows(a, s as never);
      }
    },
    { a: ACCOUNT, s: store },
  ) as Promise<Array<Record<string, unknown>>>;

export interface Booted {
  page: Page;
  net: SyncStub;
  cal: CalendarStub;
}

/**
 * A booted page of the production composition at `route`, with the account's database created first (the tree binds only a database
 * that exists when it looks), the fixture leader bound to it (not started), and `cache` rows put into the cache.
 */
export interface BootOptions {
  cache?: Array<Record<string, unknown>>;
  heading?: string;
  viewport?: { width: number; height: number };
  colorScheme?: "light" | "dark";
}

export async function bootAt(
  context: BrowserContext,
  route: string,
  options: BootOptions = {},
): Promise<Booted> {
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  const cal = await stubCalendars(context);
  await seedSettled(context);
  const setup = await dataPage(context);
  await setup.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    data.setIdentity(a);
    const opened = await data.open(a, { create: true });
    if (opened !== "created" && opened !== "opened")
      throw new Error(`open: ${opened}`);
    await data.seedDelta(a, "cursor-0");
    data.close(a);
  }, ACCOUNT);
  await setup.close();
  const page = await context.newPage();
  if (options.viewport) await page.setViewportSize(options.viewport);
  if (options.colorScheme)
    await page.emulateMedia({ colorScheme: options.colorScheme });
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  if (options.heading)
    await expect(
      page.getByRole("heading", { level: 1, name: options.heading }),
    ).toBeVisible();
  await untilTreeSettled(page, { connections: 2 });
  await startOutbox(page, ACCOUNT, { start: false });
  await untilTreeSettled(page, { connections: 2 });
  if (options.cache?.length)
    await page.evaluate(
      ({ a, r }) => window.__atlasData?.put(a, "cache", r as never),
      { a: ACCOUNT, r: options.cache },
    );
  cal.phase = "test";
  return { page, net, cal };
}

/** The Calendars screen booted, its listed sources' first observation read answered before the test arms anything. */
export async function calendarsPage(
  context: BrowserContext,
  options: Omit<BootOptions, "heading"> = {},
): Promise<Booted> {
  const booted = await bootAt(context, "/settings/calendars", {
    ...options,
    heading: "Calendar sources",
  });
  for (const row of options.cache ?? [])
    if (row.kind === "calendar_source")
      await expect(
        booted.page.locator(`[data-source-row="${String(row.id)}"]`),
      ).toHaveAttribute(
        "data-observation",
        /^(busy|idle|unknown|unconfirmed|ended)$/,
      );
  booted.cal.phase = "test";
  return booted;
}

/** The fixture leader sends what is queued now (a save in the tree only posts a hint; the fixture leader is woken explicitly). */
export async function send(page: Page): Promise<void> {
  await page.evaluate(() => window.__atlasData?.beginOutbox());
  await page.evaluate(() => window.__atlasData?.retryOutbox());
}

/** The POSTs to one path key (`/calendar-sources/*\/import`), in arrival order. */
export const posts = (cal: CalendarStub, key: string) =>
  cal.wire.filter((w) => w.method === "POST" && pathKey(w.path) === key);

export const IMPORT_PATH = "/calendar-sources/*/import";

/** A valid calendar of `events` all-day events (CRLF lines), optionally padded with an `X-` property to `bytes` UTF-8 bytes. */
export function calendarText(events = 1, bytes?: number): string {
  const head = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Atlas test//EN\r\n";
  let body = "";
  for (let n = 0; n < events; n += 1)
    body += `BEGIN:VEVENT\r\nUID:event-${n}@example\r\nDTSTAMP:20260101T000000Z\r\nDTSTART;VALUE=DATE:20261102\r\nSUMMARY:Bin day ${n}\r\nEND:VEVENT\r\n`;
  const tail = "END:VCALENDAR\r\n";
  let text = head + body + tail;
  if (bytes !== undefined) {
    const pad =
      bytes - new TextEncoder().encode(text).length - "X-PAD:\r\n".length;
    if (pad > 0) text = `${head}X-PAD:${"x".repeat(pad)}\r\n${body}${tail}`;
  }
  return text;
}

/**
 * Every control a person can press in `main` or an open dialog is at least 44 x 44; a native radio or checkbox is measured by the label
 * that activates it (the WEB-10a task form's pattern). A visually hidden file control behind "browse" is not a target.
 */
export const smallTargets = (page: Page, only?: string) =>
  page.evaluate((selector) => {
    const out: string[] = [];
    const scopes = (
      selector === null
        ? [
            document.querySelector("main"),
            ...document.querySelectorAll('[role="dialog"]'),
          ]
        : [...document.querySelectorAll(selector)]
    ).filter(Boolean) as Element[];
    for (const scope of scopes)
      for (const element of scope.querySelectorAll<HTMLElement>(
        'button, a[href], input:not([type="file"]), select, textarea, [role="button"]',
      )) {
        const target =
          element instanceof HTMLInputElement &&
          (element.type === "radio" || element.type === "checkbox")
            ? (element.closest("label") ?? element)
            : element;
        const rect = target.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width < 43.5 || rect.height < 43.5)
          out.push(
            `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? target.textContent ?? "").trim().slice(0, 40)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`,
          );
      }
    return out;
  }, only ?? null);
