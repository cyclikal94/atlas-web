import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { PageHeading } from "../../../components/ui/page-heading";
import {
  type CacheRow,
  useCachedResource,
  useOptionalDataEnv,
} from "../../../data";
import { CacheGate } from "../../sync/CacheGate";
import * as copy from "../copy";
import { archiveRequest } from "../model/commands";
import { changesOfAll, foldRows, type ShownRow } from "../model/project";
import { PendingBadge, useOutboxSave } from "../parts";
import { OutstandingChain, ResourceChain } from "../reads";
import { archivedLedgerKinds } from "./ledger";

/**
 * Settings → "Archived items" (Q21 gap 9, `archive-restore.html`; D-11a-11): "Kind | Name" with "Restore" per row, no date column (the
 * projection has no `archived_at`). People and fields are WEB-11a's kinds; other slices add theirs through `archivedLedgerKinds`. A field
 * is listed only while its person is on this device and visible (PPL-5), named with its person ("Old emergency contact · Mo").
 */
const LEDGER_PAGES = 50;

export function ArchivedItems() {
  const env = useOptionalDataEnv();
  const heading = useId();
  return (
    <div className="flex max-w-[700px] flex-col gap-5" data-archived-items="">
      <div className="flex flex-col gap-2">
        <Link
          to="/settings"
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-[13.5px] text-ink-2 hover:text-ink-1"
        >
          Settings
        </Link>
        <PageHeading>{copy.ARCHIVED_ITEMS}</PageHeading>
        <p className="text-[12.5px] leading-[1.6] text-ink-2">
          {copy.ARCHIVED_NOTE}
        </p>
      </div>
      {env === null ? null : (
        <CacheGate>
          <Ledger headingId={heading} />
        </CacheGate>
      )}
    </div>
  );
}

function Ledger({ headingId }: { headingId: string }) {
  const kinds = archivedLedgerKinds.list();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const reporters = kinds.map((kind) => kind.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: one reporter per registered kind
  const reportFor = useCallback(
    (id: string) => (count: number) =>
      setCounts((previous) =>
        previous[id] === count ? previous : { ...previous, [id]: count },
      ),
    [reporters],
  );
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const reported = kinds.every((kind) => counts[kind.id] !== undefined);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="sr-only">
        {copy.ARCHIVED_ITEMS}
      </h2>
      <div
        aria-hidden="true"
        className="grid grid-cols-[96px_minmax(0,1fr)_auto] gap-3 px-3 text-[12px] text-ink-2"
      >
        <span>{copy.COLUMN_KIND}</span>
        <span>{copy.COLUMN_NAME}</span>
        <span />
      </div>
      <List className="flex flex-col gap-1">
        {kinds.map((kind) => (
          <kind.Rows key={kind.id} report={reportFor(kind.id)} />
        ))}
      </List>
      {reported && total === 0 ? (
        <p
          data-archived-state="empty"
          className="text-[13px] leading-[1.6] text-ink-2"
        >
          {copy.ARCHIVED_EMPTY}
        </p>
      ) : null}
    </section>
  );
}

function LedgerRow({
  kindLabel,
  name,
  shown,
}: {
  kindLabel: string;
  name: string;
  shown: ShownRow;
}) {
  const save = useOutboxSave();
  const announcer = useAnnouncer();
  const [message, setMessage] = useState<string | null>(null);
  const nameId = useId();
  return (
    <li
      data-archived-row={shown.row.id}
      className="grid list-none grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-3 rounded-row border border-hairline px-3 py-2"
    >
      <span className="text-[12.5px] text-ink-2">{kindLabel}</span>
      <span className="flex min-w-0 flex-col gap-1">
        <span id={nameId} className="truncate text-[13.5px] text-ink-1">
          {name}
        </span>
        <PendingBadge mark={shown.pending} />
        {message ? (
          <span className="text-[12px] text-conflict-text">{message}</span>
        ) : null}
      </span>
      {shown.row.can_edit && !shown.projected ? (
        <Button
          variant="quiet"
          aria-describedby={nameId}
          data-people-action="ledger-restore"
          onClick={async () => {
            const outcome = await save((outbox) =>
              outbox.enqueue(
                archiveRequest({ id: shown.row.id, archived: false }),
              ),
            );
            if (outcome.ok) {
              setMessage(null);
              announcer.announce(copy.SAVED_NOT_SENT, "polite");
            } else if (outcome.message !== null) setMessage(outcome.message);
          }}
        >
          {copy.RESTORE}
        </Button>
      ) : (
        <span />
      )}
    </li>
  );
}

function ArchivedPeople({ report }: { report(count: number): void }) {
  return (
    <ResourceChain kind="person" cap={LEDGER_PAGES}>
      {(chain) => (
        <OutstandingChain>
          {(outstanding) => {
            const rows = foldRows(
              chain.rows,
              changesOfAll(outstanding.rows),
              "person",
            ).filter((row) => row.row.archived);
            return (
              <Reported
                count={chain.status === "loading" ? null : rows.length}
                report={report}
              >
                {rows.map((row) => (
                  <LedgerRow
                    key={row.row.id}
                    kindLabel={copy.KIND_PERSON}
                    name={row.row.label}
                    shown={row}
                  />
                ))}
              </Reported>
            );
          }}
        </OutstandingChain>
      )}
    </ResourceChain>
  );
}

function ArchivedFields({ report }: { report(count: number): void }) {
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const onVisible = useCallback(
    (id: string, shown: boolean) =>
      setVisible((previous) =>
        previous[id] === shown ? previous : { ...previous, [id]: shown },
      ),
    [],
  );
  return (
    <ResourceChain kind="field" cap={LEDGER_PAGES}>
      {(chain) => (
        <OutstandingChain>
          {(outstanding) => {
            const rows = foldRows(
              chain.rows,
              changesOfAll(outstanding.rows),
              "field",
            ).filter((row) => row.row.archived);
            const count =
              chain.status === "loading" ||
              rows.some((row) => visible[row.row.id] === undefined)
                ? null
                : rows.filter((row) => visible[row.row.id]).length;
            return (
              <Reported count={count} report={report}>
                {rows.map((row) => (
                  <FieldLedgerRow
                    key={row.row.id}
                    shown={row}
                    onVisible={onVisible}
                  />
                ))}
              </Reported>
            );
          }}
        </OutstandingChain>
      )}
    </ResourceChain>
  );
}

/** PPL-5: a field is listed only under a person this device holds and can see. */
function FieldLedgerRow({
  shown,
  onVisible,
}: {
  shown: ShownRow;
  onVisible(id: string, shown: boolean): void;
}) {
  const parentId = shown.row.parent_id ?? "";
  const parent = useCachedResource(parentId);
  const person: CacheRow | null =
    parent.status === "ready" && parent.value.merged?.kind === "person"
      ? parent.value.merged
      : null;
  const settled = parent.status !== "loading";
  useEffect(() => {
    if (settled) onVisible(shown.row.id, person !== null);
  }, [settled, person, shown.row.id, onVisible]);
  if (person === null) return null;
  return (
    <LedgerRow
      kindLabel={copy.KIND_FIELD}
      name={copy.FIELD_OF(shown.row.label, person.label)}
      shown={shown}
    />
  );
}

function Reported({
  count,
  report,
  children,
}: {
  count: number | null;
  report(count: number): void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (count !== null) report(count);
  }, [count, report]);
  return <>{children}</>;
}

archivedLedgerKinds.register({ id: "person", order: 10, Rows: ArchivedPeople });
archivedLedgerKinds.register({ id: "field", order: 20, Rows: ArchivedFields });
