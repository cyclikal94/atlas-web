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
  | { status: number; body: unknown }
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
}

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
  if (next !== undefined) return route.fulfill(json(next.status, next.body));
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
      return route.fulfill(json(200, served.snapshot));
    if (path === "/households")
      return route.fulfill(
        json(200, (served.snapshot as { households: unknown[] }).households),
      );
    if (path === "/invitations") return route.fulfill(json(200, []));
    const duplicates = /^\/people\/([0-9a-f-]{36})\/duplicates$/.exec(path);
    if (duplicates) {
      served.log.push(`GET ${path}${url.search}`);
      return route.fulfill(
        json(200, served.duplicates.shift() ?? { items: [], next_after: null }),
      );
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
      const personId = (body() as { command: { person_id: string } }).command
        .person_id;
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

/** One `/sync` delta page upserting `resources`, applied through the fixture leader (which it starts on first use). */
export async function publish(
  page: Page,
  net: SyncStub,
  resources: Projection[],
  options: { start?: boolean } = {},
): Promise<void> {
  net.script.push(() => ({
    status: 200,
    body: pageText(
      [resources.map((resource) => ({ kind: "upsert", resource }))],
      `cursor-${net.requests.length + 1}`,
    ),
  }));
  if (options.start !== false) {
    await startLeader(page);
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
