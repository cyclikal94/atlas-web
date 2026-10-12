import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { PageHeading } from "../../../components/ui/page-heading";
import { useCachedResource, useResourceList } from "../../../data";
import type { PeopleFailure } from "../api";
import * as copy from "../copy";
import { usePeopleEnv } from "../env";
import { useMemoryRevision } from "../memory";
import {
  addPage,
  type DuplicatesState,
  initialDuplicates,
  summarise,
  visibleHints,
} from "../model/duplicates";
import { Avatar, Banner } from "../parts";

/**
 * WF-PEOPLE-04, possible duplicates of one person (§4.5, PPL-3). Online `GET /people/{id}/duplicates?limit=50`, paged with "Check more"
 * while `next_after` is set; never read automatically beyond the page asked for (Q9). "Nothing looks like a duplicate right now." only
 * after a page with `next_after: null`; an empty page with a cursor says there are more people to check. "Not the same" hides a pair
 * for this identity while Atlas is open (D-11a-9). WEB-11b's slot adds "Compare & merge" to each hint.
 */
const LIMIT = 50;

export function DuplicatesView({
  personId,
  duplicateActions,
}: {
  personId: string;
  duplicateActions?: (personId: string, otherId: string) => ReactNode;
}) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const person = useCachedResource(personId);
  const name =
    person.status === "ready" && person.value.merged?.kind === "person"
      ? person.value.merged.label
      : null;
  const [state, setState] = useState<DuplicatesState>(initialDuplicates);
  const [failure, setFailure] = useState<PeopleFailure | null>(null);
  const [reading, setReading] = useState(false);
  const generation = useRef(0);
  const read = useCallback(
    async (after: string | null) => {
      const mine = ++generation.current;
      setReading(true);
      setFailure(null);
      const result = await env.api.readDuplicates(personId, {
        after,
        limit: LIMIT,
      });
      if (mine !== generation.current) return;
      setReading(false);
      if (result.ok)
        setState((previous) =>
          addPage(
            previous,
            {
              items: result.value.items.map((item) => ({
                id: item.id,
                label: item.label,
              })),
              next_after: result.value.next_after,
            },
            personId,
          ),
        );
      else setFailure(result);
    },
    [env, personId],
  );
  // The first page is asked for once per view (an effect replayed by Strict Mode does not ask twice).
  const asked = useRef(false);
  useEffect(() => {
    if (!env.online || state.pages > 0 || asked.current) return;
    asked.current = true;
    void read(null);
  }, [env.online, read, state.pages]);

  const dismissed = env.memory.dismissedOf(personId);
  const hints = visibleHints(state, dismissed);
  const summary = summarise(state, dismissed);
  const title = name ?? copy.PAGE_TITLE;

  return (
    <div
      className="flex max-w-[760px] flex-col gap-5"
      data-duplicates={personId}
    >
      <Link
        to="/people/$personId"
        params={{ personId }}
        className="atlas-transition inline-flex min-h-11 w-fit items-center gap-1.5 text-[13.5px] text-ink-2 hover:text-ink-1"
      >
        <ArrowLeft aria-hidden="true" size={16} />
        {title}
      </Link>
      <div className="flex flex-col gap-2">
        <PageHeading>{copy.DUPLICATES_TITLE(title)}</PageHeading>
        <p className="text-[13.5px] leading-[1.55] text-ink-2">
          {copy.DUPLICATES_SUBHEAD}
        </p>
      </div>
      {!env.online && state.pages === 0 ? (
        <p data-duplicates-state="offline" className="text-[13.5px] text-ink-1">
          {copy.DUPLICATES_OFFLINE}.
        </p>
      ) : null}
      {failure !== null ? (
        failure.kind === "not_found" || failure.kind === "forbidden" ? (
          <Banner message={copy.DUPLICATES_GONE} />
        ) : failure.kind === "closed" ? null : (
          <Banner
            message={
              failure.kind === "offline" || failure.kind === "not_sent"
                ? `${copy.DUPLICATES_OFFLINE}.`
                : copy.DUPLICATES_FAILED
            }
            {...("requestId" in failure && failure.requestId
              ? { requestId: failure.requestId }
              : {})}
            action={
              env.online ? (
                <Button onClick={() => void read(state.cursor)}>
                  {copy.TRY_AGAIN}
                </Button>
              ) : undefined
            }
          />
        )
      ) : null}
      {hints.length > 0 ? (
        <List className="flex flex-col gap-2">
          {hints.map((hint) => (
            <li
              key={hint.id}
              data-duplicate-hint={hint.id}
              className="flex list-none flex-wrap items-center gap-3 rounded-row border border-hairline-strong bg-panel p-3"
            >
              <Avatar name={hint.label} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[14px] text-ink-1">{hint.label}</span>
                <span className="flex flex-wrap gap-2 text-[12.5px] text-ink-2">
                  <span>{copy.SIMILAR_NAME}</span>
                  <HintFieldCount personId={hint.id} />
                </span>
              </span>
              <span className="flex flex-wrap gap-2">
                <Button
                  data-people-action="not-the-same"
                  onClick={() => env.memory.dismiss(personId, hint.id)}
                >
                  {copy.NOT_THE_SAME}
                </Button>
                {duplicateActions?.(personId, hint.id)}
              </span>
            </li>
          ))}
        </List>
      ) : null}
      {summary.kind === "none_at_all" ? (
        <p data-duplicates-state="none" className="text-[13.5px] text-ink-1">
          {copy.NONE_AT_ALL}
        </p>
      ) : summary.kind === "none_so_far" ? (
        <p
          data-duplicates-state="none-so-far"
          className="text-[13.5px] text-ink-1"
        >
          {copy.NONE_SO_FAR}
        </p>
      ) : null}
      {state.pages > 0 && !state.exhausted ? (
        env.online ? (
          reading ? (
            <Button disabled reason={copy.CHECKING}>
              {copy.CHECK_MORE}
            </Button>
          ) : (
            <Button
              data-people-action="check-more"
              onClick={() => void read(state.cursor)}
            >
              {copy.CHECK_MORE}
            </Button>
          )
        ) : (
          <Button disabled reason={copy.DUPLICATES_OFFLINE}>
            {copy.CHECK_MORE}
          </Button>
        )
      ) : null}
      <p className="text-[12.5px] leading-[1.55] text-ink-2">
        {copy.DUPLICATES_FOOTER}
      </p>
    </div>
  );
}

/** The candidate's field count when the cache holds its fields (nothing is asked for). */
function HintFieldCount({ personId }: { personId: string }) {
  const page = useResourceList({ kind: "field", parentId: personId });
  if (page.status !== "ready" || page.value.rows.length === 0) return null;
  const count = page.value.rows.filter((row) => !row.merged.archived).length;
  return (
    <span>
      {page.value.next === null
        ? copy.FIELD_COUNT(count)
        : `${copy.FIELD_COUNT(count)}+`}
    </span>
  );
}
