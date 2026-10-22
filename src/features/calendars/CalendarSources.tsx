import { Link } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../../components/ui/button";
import { List } from "../../components/ui/list";
import { PageHeading } from "../../components/ui/page-heading";
import {
  type CacheRow,
  type DraftWithCommand,
  type ListedResource,
  useDataActions,
  useOptionalDataEnv,
  usePendingCreates,
  useResourceList,
  useStatusInputs,
} from "../../data";
import { useSession } from "../../session";
import { CacheGate } from "../sync/CacheGate";
import { AddSourceDialog } from "./AddSourceDialog";
import { type CalendarApi, useCalendarApi } from "./api";
import {
  ADD_SOURCE,
  ADD_SOURCE_CLASS,
  DISMISS,
  EMPTY,
  LINK_CALENDAR,
  LOAD_FAILED,
  LOAD_FAILED_ACTION,
  LOADING,
  NO_DATABASE,
  ONLINE_ONLY,
  SCREEN_EYEBROW,
  SCREEN_HEADING,
  SHOW_NEXT,
  SHOW_PREVIOUS,
  WAITING_GROUP,
} from "./copy";
import { LinkCalendarDialog } from "./LinkCalendarDialog";
import { ManageSourceDialog } from "./ManageSourceDialog";
import { identityMemory } from "./memory";
import { type Compat, type Environment, headerActions } from "./model/status";
import type {
  ObserverAttachment,
  SourceObserver,
} from "./observation-controller";
import {
  createRefreshController,
  type RefreshController,
} from "./refresh-controller";
import { projectSourceCreate } from "./register";
import { PendingRow, SourceRow } from "./SourceRow";
import { type CalendarVisit, documentVisitBoundary, enterVisit } from "./visit";

/**
 * "Calendar sources" (WEB-13a; `wireframes/q21/calendar-journeys.html`), the Settings registry's Calendars page. It lists the cached
 * sources a page at a time, then this device's creates that the server has not confirmed yet, and offers the two entry points the
 * wireframe separates: "Add source" (credential-free, QUEUED, offline or online) and "Link a calendar…" (with a connection, ONLINE
 * ONLY, never stored). Every row's status and every enablement comes from `model/status.ts`.
 *
 * A queued create is stored and shown as pending, and is sent by the production leader (WEB-09b, `app/data-leader.ts`) when this
 * device's leader runs. When the screen opens it reads the live list once for the sources it shows, and follows a refresh it finds
 * running elsewhere until it ends (`observation-controller.ts`, D-13a-13): it sends nothing. What it reads by itself (that list and the
 * capability) is read once per VISIT, which a remount under the same identity continues and the person leaving the screen ends, whether
 * or not it is mounted then (`visit.ts`, revisions 5 and 6, R11 and R13).
 */
export function CalendarSources() {
  const env = useOptionalDataEnv();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          to="/settings"
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-[13.5px] text-ink-2 hover:text-ink-1"
        >
          Settings
        </Link>
        <p className="text-[12px] uppercase tracking-[0.06em] text-ink-2">
          {SCREEN_EYEBROW}
        </p>
        <PageHeading>{SCREEN_HEADING}</PageHeading>
      </div>
      {env === null ? (
        <p className="max-w-[700px] text-[13px] leading-[1.6] text-ink-2">
          {NO_DATABASE}
        </p>
      ) : (
        <Sources />
      )}
    </div>
  );
}

export type Dialog =
  | { kind: "add" }
  | { kind: "link" }
  | {
      kind: "manage";
      row: CacheRow;
      cached: boolean;
      /** Open with the connection's Replace… panel showing (cause 1's "Update connection"). */
      replace?: boolean;
      /** Open with Enabled on (cause 6a's "Turn on"). */
      enable?: boolean;
      /** The conflicted draft a Save replaces (D-13a-12). */
      supersede?: string;
    };

/** The online settings changes made on this screen whose result the cache has not caught up with (D-13a-8), by source. */
export type AwaitingSync = ReadonlyMap<string, number>;

function useCompat(): Compat {
  const session = useSession();
  return useSyncExternalStore(
    (listener) => session.compat.subscribe(listener),
    () => session.compat.get().status,
    () => session.compat.get().status,
  );
}

/**
 * One refresh controller per calendar client: replaced with the identity, disposed on unmount (Strict Mode safe). Which press of a
 * source may record its outcome is the identity's (`refresh-ownership.ts`, revision 6, R12), so an answer that arrives after a remount
 * is shown by the screen mounted then, unless a newer press of that source was admitted since. The observer of refresh activity and
 * the capability read are the VISIT's (`visit.ts`, revision 5, R11): the mount attaches to the identity's current visit and detaches
 * on unmount, and never ends it. The visit ends when the DOCUMENT leaves the screen (`VisitBoundary`, revision 6, R13), observed whether
 * or not this screen is mounted: a remount at the same address (the session's re-check of a `403`, a router made again, Strict Mode)
 * continues it, reading nothing again. The document entering or leaving the screen while this is mounted builds afresh, and no
 * visit is entered while the document is not at the screen (its own address, not the router's). A press admitted by the controller
 * ends that source's observation (revision 4, R10).
 */
function useRefresh(api: CalendarApi | null): {
  controller: RefreshController | null;
  observer: SourceObserver | null;
  attachment: ObserverAttachment | null;
  visit: CalendarVisit | null;
} {
  const [built, setBuilt] = useState<{
    controller: RefreshController;
    observer: SourceObserver;
    attachment: ObserverAttachment;
    visit: CalendarVisit;
  } | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const boundary = documentVisitBoundary();
  const moved = useSyncExternalStore(
    boundary.subscribe,
    boundary.changes,
    boundary.changes,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the document entering or leaving the screen while it is mounted builds afresh (the boundary is read itself)
  useEffect(() => {
    // The visit has ended already at a departure (`enterVisit`), and none is entered while the DOCUMENT is not at the screen. Its own
    // address, not the router's: Back is seen by the document's record before the router (a browser runs this between the two), and a
    // router's push reaches the document a moment after the router has it (the screen then mounts, and builds once the document is there).
    if (api === null || !boundary.inside()) {
      setBuilt(null);
      return;
    }
    const memory = identityMemory(api.identity.account, api.identity.epoch);
    const visit = enterVisit(memory, api, boundary);
    const observer = visit.observer;
    const attachment = observer.attach();
    const controller = createRefreshController({
      api,
      mintKey: () => crypto.randomUUID(),
      // What must outlive a remount of this screen under the same identity (a `403` is re-checked by the session), and who may still
      // record a refresh's outcome: `memory.ts`, `refresh-ownership.ts`.
      ownership: memory.refresh,
      onBegin: (id) => observer.yieldTo(id),
    });
    const offController = controller.subscribe(rerender);
    const offObserver = observer.subscribe(rerender);
    setBuilt({ controller, observer, attachment, visit });
    return () => {
      offController();
      offObserver();
      controller.dispose();
      // Only this mount's hold ends: the visit goes on until the document leaves the screen (`VisitBoundary`), mounted or not.
      attachment.detach();
    };
  }, [api, boundary, moved]);
  return {
    controller: built?.controller ?? null,
    observer: built?.observer ?? null,
    attachment: built?.attachment ?? null,
    visit: built?.visit ?? null,
  };
}

const NO_CAPABILITY = (): boolean | null => null;
const NO_LISTENER = () => () => undefined;

function Sources() {
  const env = useOptionalDataEnv();
  const inputs = useStatusInputs();
  const compat = useCompat();
  const api = useCalendarApi();
  const service = useSyncExternalStore(
    (listener) => env?.serviceStore.subscribe(listener) ?? (() => undefined),
    () => env?.serviceStore.get() ?? null,
    () => env?.serviceStore.get() ?? null,
  );
  const online = inputs.online;
  const { controller, observer, attachment, visit } = useRefresh(api);
  const capability = visit?.capability ?? null;
  const calendarLinks = useSyncExternalStore(
    capability?.subscribe ?? NO_LISTENER,
    capability?.get ?? NO_CAPABILITY,
    capability?.get ?? NO_CAPABILITY,
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [awaiting, setAwaiting] = useState<AwaitingSync>(new Map());

  // The capability is read once per VISIT while online (D-13a-10; revision 5, R11: a remount does not read it again); unknown
  // (offline, or a failed read) pre-disables nothing.
  useEffect(() => {
    if (capability === null || !online) return;
    let current = true;
    capability.read(() => current);
    return () => {
      current = false;
    };
  }, [capability, online]);

  // Offline stops every refresh and admits no new one; nothing resumes when the page comes back online (a new press may start one).
  // It also ends the observation of refresh activity for good: only opening the screen again reads the live list again.
  useEffect(() => {
    if (!online) {
      controller?.offline();
      observer?.offline();
    } else controller?.online();
  }, [online, controller, observer]);

  // The live list is read only for a compatible server (the ordinary requests' own rule, `direct` in `model/status.ts`).
  useEffect(() => {
    observer?.compatible(compat === "supported");
  }, [compat, observer]);

  const environment: Environment = {
    online,
    compat,
    hasOutbox: service !== null && (env?.outbox() ?? null) !== null,
    calendarLinks,
  };
  const actions = headerActions(environment);
  const memory =
    api === null
      ? null
      : identityMemory(api.identity.account, api.identity.epoch);
  const [, dismissedLink] = useReducer((n: number) => n + 1, 0);
  const linkNotice = memory?.notices.get("link");
  const markAwaiting = useCallback((id: string, version: number) => {
    setAwaiting((previous) => new Map(previous).set(id, version));
  }, []);

  return (
    <>
      <section
        aria-label={SCREEN_HEADING}
        className="flex max-w-[760px] flex-col gap-4"
      >
        <div className="flex flex-wrap items-start gap-3">
          <EntryPoint label={ADD_SOURCE_CLASS}>
            {actions.add.enabled ? (
              <Button
                variant="primary"
                onClick={() => setDialog({ kind: "add" })}
              >
                {ADD_SOURCE}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled
                reason={actions.add.reason ?? ""}
              >
                {ADD_SOURCE}
              </Button>
            )}
          </EntryPoint>
          <EntryPoint label={ONLINE_ONLY}>
            {actions.link.enabled ? (
              <Button onClick={() => setDialog({ kind: "link" })}>
                {LINK_CALENDAR}
              </Button>
            ) : (
              <Button disabled reason={actions.link.reason ?? ""}>
                {LINK_CALENDAR}
              </Button>
            )}
          </EntryPoint>
        </div>
        {linkNotice !== undefined ? (
          <div
            data-row-notice="link"
            className="flex flex-wrap items-center gap-2 text-[12.5px] leading-[1.6] text-ink-1"
          >
            <span>{linkNotice}</span>
            <Button
              variant="quiet"
              onClick={() => {
                memory?.notices.delete("link");
                dismissedLink();
              }}
            >
              {DISMISS}
            </Button>
          </div>
        ) : null}
        {service === null ? (
          <p
            data-no-database=""
            className="text-[13px] leading-[1.6] text-ink-2"
          >
            {NO_DATABASE}
          </p>
        ) : (
          <>
            <CacheGate>
              <CachedSources
                environment={environment}
                controller={controller}
                observer={observer}
                attachment={attachment}
                notices={memory?.notices ?? null}
                onDialog={setDialog}
              />
            </CacheGate>
            <PendingSources environment={environment} onDialog={setDialog} />
          </>
        )}
      </section>
      {dialog?.kind === "add" ? (
        <AddSourceDialog online={online} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "link" && api !== null ? (
        <LinkCalendarDialog
          api={api}
          environment={environment}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "manage" ? (
        <ManageSourceDialog
          api={api}
          dialog={dialog}
          environment={environment}
          awaiting={awaiting}
          onAwaiting={markAwaiting}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

function EntryPoint({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11.5px] uppercase tracking-[0.06em] text-ink-2">
        {label}
      </span>
      {children}
    </div>
  );
}

function CachedSources({
  environment,
  controller,
  observer,
  attachment,
  notices,
  onDialog,
}: {
  environment: Environment;
  controller: RefreshController | null;
  observer: SourceObserver | null;
  attachment: ObserverAttachment | null;
  notices: Map<string, string> | null;
  onDialog(dialog: Dialog): void;
}) {
  const [, dismissed] = useReducer((n: number) => n + 1, 0);
  const actions = useDataActions();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const after = cursors[cursors.length - 1] ?? null;
  const page = useResourceList({
    kind: "calendar_source",
    after,
    limit: 100,
  });
  // The sources listed now are the ones whose refresh activity is observed (D-13a-13): one key for the page, so an ordinary re-render
  // (a health or draft change) neither reads again nor restarts a time limit. Leaving the list (the cache gate closing, another page)
  // hides them; the visit keeps what was observed (revision 5, R11).
  const listed =
    page.status === "ready"
      ? page.value.rows.map((row) => row.base.id).join("\n")
      : null;
  useEffect(() => {
    if (attachment === null || listed === null) return;
    attachment.watch(listed === "" ? [] : listed.split("\n"));
  }, [attachment, listed]);
  useEffect(() => () => attachment?.watch([]), [attachment]);
  if (page.status === "loading")
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        <p className="sr-only">{LOADING}</p>
        {[0, 1].map((n) => (
          <div
            key={n}
            data-skeleton=""
            className="h-[68px] rounded-row border border-hairline bg-panel"
          />
        ))}
      </div>
    );
  if (page.status === "unavailable")
    return page.reason === "absent" ? null : (
      <div
        data-load-error=""
        className="flex flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3.5"
      >
        <p className="text-[13.5px] text-ink-1">{LOAD_FAILED}</p>
        <Button onClick={() => actions.retryLoad()}>
          {LOAD_FAILED_ACTION}
        </Button>
      </div>
    );
  const rows: ListedResource[] = page.value.rows;
  const next = page.value.next;
  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 && cursors.length === 1 ? (
        <p data-empty="" className="text-[13px] text-ink-2">
          {EMPTY}
        </p>
      ) : (
        <List className="flex flex-col gap-2">
          {rows.map((row) => (
            <SourceRow
              key={row.base.id}
              row={row}
              environment={environment}
              controller={controller}
              observation={observer?.observation(row.base.id) ?? null}
              notice={notices?.get(row.base.id)}
              onDismissNotice={() => {
                notices?.delete(row.base.id);
                dismissed();
              }}
              onDialog={onDialog}
            />
          ))}
        </List>
      )}
      {cursors.length > 1 || next !== null ? (
        <div className="flex flex-wrap gap-2">
          {cursors.length > 1 ? (
            <Button
              variant="quiet"
              onClick={() => setCursors((list) => list.slice(0, -1))}
            >
              {SHOW_PREVIOUS}
            </Button>
          ) : null}
          {next !== null ? (
            <Button
              variant="quiet"
              onClick={() => setCursors((list) => [...list, next])}
            >
              {SHOW_NEXT}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PendingSources({
  environment,
  onDialog,
}: {
  environment: Environment;
  onDialog(dialog: Dialog): void;
}) {
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const after = cursors[cursors.length - 1] ?? null;
  const page = usePendingCreates("create_source", after);
  const drafts = useMemo(
    () =>
      page.status === "ready"
        ? page.value.drafts.flatMap((draft: DraftWithCommand) => {
            const row = projectSourceCreate(draft);
            return row === null ? [] : [{ draft, row }];
          })
        : [],
    [page],
  );
  if (page.status !== "ready" || page.value.total === 0) return null;
  const next = page.value.next;
  return (
    <section aria-labelledby="pending-sources" className="flex flex-col gap-2">
      <h2 id="pending-sources" className="text-[13.5px] font-medium text-ink-1">
        {WAITING_GROUP}
      </h2>
      <List className="flex flex-col gap-2">
        {drafts.map(({ draft, row }) => (
          <PendingRow
            key={draft.local_id}
            draft={draft}
            row={row}
            environment={environment}
            onDialog={onDialog}
          />
        ))}
      </List>
      {cursors.length > 1 || next !== null ? (
        <div className="flex flex-wrap gap-2">
          {cursors.length > 1 ? (
            <Button
              variant="quiet"
              onClick={() => setCursors((list) => list.slice(0, -1))}
            >
              {SHOW_PREVIOUS}
            </Button>
          ) : null}
          {next !== null ? (
            <Button
              variant="quiet"
              onClick={() => setCursors((list) => [...list, next])}
            >
              {SHOW_NEXT}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
