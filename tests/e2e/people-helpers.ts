import {
  type BrowserContext,
  expect,
  type Page,
  type Route,
} from "@playwright/test";
import {
  ACCOUNT,
  pageText,
  type SyncStub,
  seedSettled,
  startLeader,
  stubNetwork,
  waitForState,
} from "./data-sync-helpers";

/**
 * FIXTURE harness for the people native spec (WEB-11a §5 step 11; never packaged): the people and sharing endpoints the screens call,
 * stubbed with `context.route` AFTER `stubNetwork` (a later route wins), recording every request; and projections seeded into the account's
 * cache through the fixture leader's `/sync`. An answer here is the stub's, never the backend's (the I-P integration cases are).
 */
export const API = "/api/experimental/v1";
export const ME = ACCOUNT;
export const MO = "22222222-2222-4222-8222-222222222222";
export const HOME = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const rev = (n: number) => n.toString(16).padStart(64, "0");

export const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
export const atlas = (
  code: string,
  id = "61af3d02-0000-4000-8000-000000000000",
) => ({
  code,
  message: "m",
  request_id: id,
  details: [],
});

export interface Projection {
  id: string;
  kind: "person" | "field";
  parent_id: string | null;
  label: string;
  value: Record<string, unknown> | null;
  version: number;
  policy_version: number;
  can_edit: boolean;
  archived: boolean;
}
export const personP = (
  id: string,
  label: string,
  over: Partial<Projection> = {},
): Projection => ({
  id,
  kind: "person",
  parent_id: null,
  label,
  value: null,
  version: 1,
  policy_version: 1,
  can_edit: true,
  archived: false,
  ...over,
});
export const fieldP = (
  id: string,
  parent: string,
  label: string,
  value: Record<string, unknown>,
  over: Partial<Projection> = {},
): Projection => ({
  id,
  kind: "field",
  parent_id: parent,
  label,
  value,
  version: 1,
  policy_version: 1,
  can_edit: true,
  archived: false,
  ...over,
});

export type Answer =
  /** `after`: the answer is held until this settles (the request is already logged). */
  | { status: number; body: unknown; after?: Promise<void> }
  | "abort"
  | (() => Promise<void>);

export interface Served {
  /** Every request to a people or sharing endpoint: `METHOD path`, in order. */
  log: string[];
  people: Map<string, { person: Projection; linked: string | null }>;
  /** What `GET /people/{id}/duplicates` answers next, in order (default: an empty final page). */
  duplicates: Array<{ items: Projection[]; next_after: string | null }>;
  /** Policies by resource id (`GET /policies/{id}`); absent: 403 forbidden. */
  policies: Map<string, { version: number; policy: unknown }>;
  policyScript: Array<(id: string) => Answer>;
  peopleCommands: Array<{ key: string | null; body: unknown }>;
  peopleScript: Answer[];
  accessCommands: Array<{ key: string | null; body: unknown }>;
  management: Array<{ key: string | null; body: unknown }>;
  managementScript: Answer[];
  snapshot: unknown;
  /** `GET /defaults/snapshot` answers 503 from the first request (set in `arrange`, before the page boots): the defaults were never fetched. */
  snapshotUnavailable: boolean;
  /**
   * The viewer-safe summaries (API 0.29, finding 8), derived from `people`: by default the account's own private person, its linkage from
   * `linked`. `summaries` overrides fields of a person's summary by id; `rails` gives a person's "Shared with"; `fieldAudiences` lists a
   * person's field audiences (default: none). `summaryScript` answers `GET /people/summaries` first, in order (then the derived page).
   */
  summaries: Map<string, Record<string, unknown>>;
  rails: Map<string, unknown>;
  fieldAudiences: Map<string, Array<Record<string, unknown>>>;
  home: {
    id: string;
    name: string;
    version: number;
    member_count: number;
  } | null;
  preferencesVersion: number;
  summaryScript: Answer[];
  /**
   * WEB-11b: every request to its endpoints (`GET /people/requests`, `GET /people/requests/sent?…`, `GET /people/requests/{id}/merge-preview`,
   * `POST /people/merge-preview`, `GET /directory?username=…`) and each `/people-commands` call as `POST /people-commands <kind>`, in order;
   * kept apart from `log`, whose order earlier cases assert. `incoming`/`sent` are what the two lists answer (sent paged in id order);
   * `recipientPreviews` by request id (absent: 404); `mergePreviews` overrides by `source:target` (default: both people, no fields, no
   * approval, token "a"×64); `directory` the accounts an exact lookup finds; `requestScript` answers the next requests of a key
   * (`incoming`, `sent`, `review`, `merge`, `directory`) first, in order.
   */
  requestLog: string[];
  incoming: unknown[];
  sent: Array<{ id: string } & Record<string, unknown>>;
  /** Sent pages answered by their cursor (`""`: the first page), every time that page is read; else `sent` is paged. */
  sentPages: Map<string, unknown>;
  recipientPreviews: Map<string, unknown>;
  mergePreviews: Map<string, Record<string, unknown>>;
  directory: Array<{ id: string; username: string }>;
  requestScript: Map<string, Answer[]>;
  /**
   * WEB-19: `GET /people/{id}/activity`, kept apart from `log` (whose order earlier cases assert): every request as `GET path?query` in
   * `activityLog`; `activity` each canonical person's events, NEWEST FIRST; `activityCanonical` merged aliases (alias → canonical);
   * `activityCoverage` the coverage start (Unix seconds); `activityScript` answers the next requests first, in order. By default the
   * double pages exactly as the contract does: 404 for a person it does not serve, 422 `invalid_value` for a cursor that is not an
   * event of the timeline now, `next_after` only while more exist; an empty timeline by default.
   */
  activityLog: string[];
  activity: Map<string, unknown[]>;
  activityCanonical: Map<string, string>;
  activityCoverage: number;
  activityScript: Answer[];
}

/** Not one of the viewer-safe summary reads (finding 8), which any invalidation repeats: for logs that assert another order. */
export const notSummary = (line: string): boolean =>
  !/^GET \/people\/(summaries|[0-9a-f-]{36}\/(summary|field-audiences))/.test(
    line,
  );

export const OWNER_ONLY = {
  disclosure: "complete",
  in_home: false,
  households: [],
  your_direct_grant: null,
  direct_grant_count: 0,
  excluded_count: 0,
};

export function snapshotOf(
  revision: string,
  fieldTemplate: unknown = { kind: "private" },
) {
  return {
    defaults: {
      revision,
      preferences_version: 1,
      primary_household_id: HOME,
      person: { kind: "primary_household", edit: true },
      field: fieldTemplate,
      task: { kind: "private" },
      list: { kind: "private" },
      progress: { kind: "primary_household", edit: false },
    },
    households: [
      {
        id: HOME,
        name: "Home",
        version: 1,
        role: "manager",
        members: [
          { account_id: ME, username: "me", role: "manager" },
          { account_id: MO, username: "mo", role: "member" },
        ],
      },
    ],
  };
}

const answer = async (
  route: Route,
  next: Answer | undefined,
  fallback: () => unknown,
) => {
  if (next === "abort") return route.abort("connectionreset");
  if (typeof next === "function") {
    await next();
    return route.fulfill(json(200, fallback()));
  }
  if (next !== undefined) {
    await next.after;
    return route.fulfill(json(next.status, next.body));
  }
  return route.fulfill(json(200, fallback()));
};

export async function servePeople(context: BrowserContext): Promise<Served> {
  const served: Served = {
    log: [],
    people: new Map(),
    duplicates: [],
    policies: new Map(),
    policyScript: [],
    peopleCommands: [],
    peopleScript: [],
    accessCommands: [],
    management: [],
    managementScript: [],
    snapshot: snapshotOf(rev(1)),
    snapshotUnavailable: false,
    summaries: new Map(),
    rails: new Map(),
    fieldAudiences: new Map(),
    home: { id: HOME, name: "Home", version: 1, member_count: 2 },
    preferencesVersion: 1,
    summaryScript: [],
    requestLog: [],
    incoming: [],
    sent: [],
    sentPages: new Map(),
    recipientPreviews: new Map(),
    mergePreviews: new Map(),
    directory: [],
    requestScript: new Map(),
    activityLog: [],
    activity: new Map(),
    activityCanonical: new Map(),
    activityCoverage: 1793750400,
    activityScript: [],
  };
  const scripted = (name: string) => served.requestScript.get(name)?.shift();
  const summaryOf = (entry: { person: Projection; linked: string | null }) => {
    const { person, linked } = entry;
    return {
      id: person.id,
      label: person.label,
      version: person.version,
      policy_version: person.policy_version,
      archived: person.archived,
      linkage: linked === null ? "none" : linked === ME ? "you" : "other",
      linked_account_id: linked,
      owner: { account_id: ME, username: "me", you: true, person: null },
      added_by_you: "unknown",
      your_access: "owner",
      field_count: 0,
      audience: OWNER_ONLY,
      ...(served.summaries.get(person.id) ?? {}),
    } as Record<string, unknown> & {
      id: string;
      archived: boolean;
      linkage: string;
      added_by_you: string;
      owner: { you: boolean };
      audience: { in_home: boolean };
    };
  };
  const pageOf = <T extends { id: string; archived: boolean }>(
    all: T[],
    url: URL,
  ) => {
    const archived = url.searchParams.get("archived") === "true";
    const after = url.searchParams.get("after");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const rest = all
      .filter((item) => item.archived === archived)
      .filter((item) => after === null || item.id > after)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const items = rest.slice(0, limit);
    return {
      items,
      next_after: items.length === limit ? (items.at(-1)?.id ?? null) : null,
      home: served.home,
      preferences_version: served.preferencesVersion,
    };
  };
  let revision = 900;
  await context.route(`**${API}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(API, "");
    const method = route.request().method();
    const body = () => JSON.parse(route.request().postData() ?? "null");
    const key = () => route.request().headers()["idempotency-key"] ?? null;
    if (path === "/me")
      return route.fulfill(
        json(200, {
          id: ME,
          username: "me",
          has_password: true,
          oidc_issuers: [],
        }),
      );
    if (path === "/sessions")
      return route.fulfill(
        json(200, {
          sessions: [
            {
              id: "s1",
              device_id: "dev-1",
              current: true,
              authentication: "local",
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        }),
      );
    if (path === "/defaults/snapshot")
      return route.fulfill(
        served.snapshotUnavailable
          ? json(503, atlas("unavailable"))
          : json(200, served.snapshot),
      );
    if (path === "/households")
      return route.fulfill(
        json(200, (served.snapshot as { households: unknown[] }).households),
      );
    if (path === "/invitations") return route.fulfill(json(200, []));
    // ---- WEB-11b ----
    if (path === "/people/requests") {
      served.requestLog.push(`GET ${path}`);
      return answer(route, scripted("incoming"), () => ({
        items: served.incoming,
      }));
    }
    if (path === "/people/requests/sent") {
      served.requestLog.push(`GET ${path}${url.search}`);
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const items = [...served.sent]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .filter((item) => after === null || item.id > after)
        .slice(0, limit);
      const fixed = served.sentPages.get(after ?? "");
      if (fixed !== undefined) return route.fulfill(json(200, fixed));
      return answer(route, scripted("sent"), () => ({
        items,
        next_after: items.length === limit ? (items.at(-1)?.id ?? null) : null,
      }));
    }
    const review = /^\/people\/requests\/([0-9a-f-]{36})\/merge-preview$/.exec(
      path,
    );
    if (review) {
      served.requestLog.push(`GET ${path}`);
      const known = served.recipientPreviews.get(review[1] as string);
      const next = scripted("review");
      if (next === undefined && known === undefined)
        return route.fulfill(json(404, atlas("not_found")));
      return answer(route, next, () => known);
    }
    if (path === "/people/merge-preview" && method === "POST") {
      served.requestLog.push(`POST ${path}`);
      const { source_id, target_id } = body() as {
        source_id: string;
        target_id: string;
      };
      return answer(route, scripted("merge"), () => ({
        token: "a".repeat(64),
        source: served.people.get(source_id)?.person,
        target: served.people.get(target_id)?.person,
        fields: [],
        requires_approval: false,
        combines_identity_audiences: true,
        freezes_field_policies: true,
        ...(served.mergePreviews.get(`${source_id}:${target_id}`) ?? {}),
      }));
    }
    if (path === "/directory") {
      served.requestLog.push(`GET ${path}${url.search}`);
      const username = url.searchParams.get("username");
      return answer(route, scripted("directory"), () =>
        served.directory.filter(
          (entry) => username === null || entry.username === username,
        ),
      );
    }
    if (path === "/people/summaries") {
      served.log.push(`GET ${path}${url.search}`);
      const scope = url.searchParams.get("scope") ?? "all";
      const all = [...served.people.values()]
        .map(summaryOf)
        .filter(
          (s) =>
            scope === "all" ||
            (scope === "in_home" &&
              served.home !== null &&
              s.audience.in_home) ||
            (scope === "shared_with_me" &&
              !s.owner.you &&
              s.added_by_you !== "yes") ||
            (scope === "not_linked" && s.linkage === "none"),
        );
      return answer(route, served.summaryScript.shift(), () =>
        pageOf(all, url),
      );
    }
    const summary = /^\/people\/([0-9a-f-]{36})\/summary$/.exec(path);
    if (summary) {
      served.log.push(`GET ${path}`);
      const id = summary[1] as string;
      const known = served.people.get(id);
      if (!known) return route.fulfill(json(404, atlas("not_found")));
      const s = summaryOf(known);
      return route.fulfill(
        json(200, {
          summary: s,
          shared_with: served.rails.get(id) ?? {
            disclosure: s.owner.you ? "complete" : "partial",
            owner: s.owner,
            accounts: [],
            households: [],
            excluded_accounts: s.owner.you ? [] : null,
          },
          home: served.home,
          preferences_version: served.preferencesVersion,
        }),
      );
    }
    const audiences = /^\/people\/([0-9a-f-]{36})\/field-audiences$/.exec(path);
    if (audiences) {
      served.log.push(`GET ${path}${url.search}`);
      const id = audiences[1] as string;
      if (!served.people.has(id))
        return route.fulfill(json(404, atlas("not_found")));
      return route.fulfill(
        json(
          200,
          pageOf(
            (served.fieldAudiences.get(id) ?? []) as Array<{
              id: string;
              archived: boolean;
            }>,
            url,
          ),
        ),
      );
    }
    const duplicates = /^\/people\/([0-9a-f-]{36})\/duplicates$/.exec(path);
    if (duplicates) {
      served.log.push(`GET ${path}${url.search}`);
      return route.fulfill(
        json(200, served.duplicates.shift() ?? { items: [], next_after: null }),
      );
    }
    const activity = /^\/people\/([0-9a-f-]{36})\/activity$/.exec(path);
    if (activity) {
      served.activityLog.push(`GET ${path}${url.search}`);
      const id = activity[1] as string;
      const next = served.activityScript.shift();
      if (next !== undefined && typeof next !== "function")
        return answer(route, next, () => null);
      const canonical = served.activityCanonical.get(id) ?? id;
      if (!served.people.has(id))
        return route.fulfill(json(404, atlas("not_found")));
      const events = (served.activity.get(canonical) ?? []) as Array<{
        id: string;
      }>;
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      let rest = events;
      if (after !== null) {
        const at = events.findIndex((event) => event.id === after);
        if (at < 0) return route.fulfill(json(422, atlas("invalid_value")));
        rest = events.slice(at + 1);
      }
      const items = rest.slice(0, limit);
      return answer(route, next, () => ({
        person_id: canonical,
        items,
        next_after: rest.length > limit ? (items.at(-1)?.id ?? null) : null,
        coverage_started_at: served.activityCoverage,
      }));
    }
    const person = /^\/people\/([0-9a-f-]{36})$/.exec(path);
    if (person) {
      served.log.push(`GET ${path}`);
      const known = served.people.get(person[1] as string);
      if (!known) return route.fulfill(json(404, atlas("not_found")));
      return route.fulfill(
        json(200, { person: known.person, linked_account_id: known.linked }),
      );
    }
    const policy = /^\/policies\/([0-9a-f-]{36})$/.exec(path);
    if (policy) {
      served.log.push(`GET ${path}`);
      const id = policy[1] as string;
      const scripted = served.policyScript.shift();
      if (scripted)
        return answer(route, scripted(id), () => served.policies.get(id));
      const known = served.policies.get(id);
      if (!known) return route.fulfill(json(403, atlas("forbidden")));
      return route.fulfill(json(200, known));
    }
    if (path === "/people-commands" && method === "POST") {
      served.log.push(`POST ${path}`);
      served.peopleCommands.push({ key: key(), body: body() });
      revision += 1;
      const command = (body() as { command: Record<string, unknown> }).command;
      served.requestLog.push(`POST ${path} ${String(command.kind)}`);
      // A receipt names the canonical person: a merge's target; a request or an answer, the person it is about (WEB-11b).
      const about = [...served.incoming, ...served.sent].find(
        (request) => (request as { id: string }).id === command.id,
      ) as { proposal?: Record<string, string> } | undefined;
      const personId =
        (command.person_id as string | undefined) ??
        (command.target_id as string | undefined) ??
        about?.proposal?.person_id ??
        about?.proposal?.target_id ??
        ME;
      return answer(route, served.peopleScript.shift(), () => ({
        revision,
        person_id: personId,
      }));
    }
    if (path === "/task-access-commands" && method === "POST") {
      served.log.push(`POST ${path}`);
      served.accessCommands.push({ key: key(), body: body() });
      revision += 1;
      return route.fulfill(json(200, { revision }));
    }
    if (path === "/management-commands" && method === "POST") {
      served.log.push(`POST ${path}`);
      served.management.push({ key: key(), body: body() });
      revision += 1;
      return answer(route, served.managementScript.shift(), () => ({
        revision,
      }));
    }
    return route.fallback();
  });
  return served;
}

/** A booted session page (the production composition) on `route`, with the data harness attached. */
export async function bootAt(
  context: BrowserContext,
  route: string,
  query = "",
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/__session?route=${encodeURIComponent(route)}${query}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

/** In-app navigation (history and popstate): the page and its memory stay. */
export async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/** The server revision of the next published page: it only grows, as a real server's does (the applied revision follows it). */
let publishedRevision = 100;

/** One `/sync` delta page upserting `resources`, applied through the fixture leader (which it starts on first use). */
export async function publish(
  page: Page,
  net: SyncStub,
  resources: Projection[],
  options: { start?: boolean } = {},
): Promise<void> {
  await publishChanges(
    page,
    net,
    resources.map((resource) => ({ kind: "upsert", resource })),
    options,
  );
}

/** One `/sync` delta page of `changes` (upserts and removals, in order), applied as `publish` applies its page. */
export async function publishChanges(
  page: Page,
  net: SyncStub,
  changes: Array<
    { kind: "upsert"; resource: Projection } | { kind: "remove"; id: string }
  >,
  /**
   * `retake` (with `start: false`): nudge again until the page is taken. A single nudge that arrives while the leader's own follow-up
   * /sync is running starts nothing, and the page then waits for the live-edge poll a minute away; the running engine commits it
   * whichever of its requests takes it.
   */
  options: { start?: boolean; retake?: boolean } = {},
): Promise<void> {
  publishedRevision += 1;
  const revision = publishedRevision;
  net.script.push(() => ({
    status: 200,
    body: pageText(
      [changes],
      `cursor-${net.requests.length + 1}`,
      false,
      revision,
    ),
  }));
  if (options.start !== false) {
    await startLeader(page);
    await waitForState(page, "idle");
  } else if (options.retake) {
    await expect
      .poll(async () => {
        await page.evaluate(() => window.__atlasData?.nudgeSync());
        return net.script.length;
      })
      .toBe(0);
    await waitForState(page, "idle");
  } else {
    await page.evaluate(() => window.__atlasData?.nudgeSync());
    await expect.poll(() => net.script.length).toBe(0);
    await waitForState(page, "idle");
  }
}

export async function setup(
  context: BrowserContext,
  route: string,
  resources: Projection[],
  options: {
    linked?: Record<string, string | null>;
    arrange?: (served: Served) => void;
  } = {},
) {
  const net = await stubNetwork(context);
  const served = await servePeople(context);
  for (const resource of resources)
    if (resource.kind === "person")
      served.people.set(resource.id, {
        person: resource,
        linked: options.linked?.[resource.id] ?? null,
      });
  options.arrange?.(served);
  await seedSettled(context);
  const page = await bootAt(context, route);
  await publish(page, net, resources);
  return { net, served, page };
}

/** The browser's own connectivity (navigator.onLine follows it), waited for. */
export async function connectivity(
  context: BrowserContext,
  page: Page,
  online: boolean,
): Promise<void> {
  await context.setOffline(!online);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(online);
}

/** The account's drafts in real IndexedDB, through the harness. */
export async function draftsOf(
  page: Page,
): Promise<Array<Record<string, unknown>>> {
  return (await page.evaluate(
    (a) => window.__atlasData?.rows(a, "drafts"),
    ME,
  )) as Array<Record<string, unknown>>;
}
