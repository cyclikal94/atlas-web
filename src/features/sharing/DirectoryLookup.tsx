import { useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { List } from "../../components/ui/list";
import { type DirectoryEntry, type SharingResult, untilSent } from "./api";
import * as copy from "./copy";
import { useSharingEnv } from "./env";

/**
 * WF-SHARING-05, the directory lookup, reached from the "+ Add …" rows of the editors (`gaps/sharing-05-desktop.html`). Two labelled
 * sections in ONE reading order (not tabs): "Search by name" and "Or look up an exact username". When the server's directory is disabled
 * it matches only an exact username, so a search that finds nothing is still answered by the exact lookup. "No account found" is an empty
 * state, never an error. Online-only. Your own account is never offered (you cannot grant or exclude yourself).
 *
 * It is shown as a VIEW of the open dialog or sheet (with Back), not as a second stacked dialog: the same content, sections and reading
 * order, without a nested modal's focus trap inside another (D-12a-11).
 */
type Found =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "done"; entries: DirectoryEntry[] }
  | { status: "failed"; requestId?: string };

export function DirectoryLookup({
  purpose,
  onChoose,
  onBack,
}: {
  /** What the choice is for, as the heading's description ("Add account grant", "Add exclusion"). */
  purpose: string;
  onChoose(entry: DirectoryEntry): void;
  onBack(): void;
}) {
  const env = useSharingEnv();
  const announcer = useAnnouncer();
  const ids = { search: useId(), exact: useId(), heading: useId() };
  const [query, setQuery] = useState("");
  const [exact, setExact] = useState("");
  const [search, setSearch] = useState<Found>({ status: "idle" });
  const [precise, setPrecise] = useState<Found>({ status: "idle" });
  const latest = useRef({ search: 0, exact: 0 });

  const ask = async (
    which: "search" | "exact",
    username: string,
    set: (found: Found) => void,
  ) => {
    const mine = ++latest.current[which];
    set({ status: "busy" });
    const result: SharingResult<DirectoryEntry[]> = await untilSent(() =>
      env.api.lookup(username),
    );
    if (mine !== latest.current[which]) return;
    if (result.ok) {
      const entries = result.value.filter(
        (entry) =>
          entry.id !== env.accountId &&
          (which === "search" || entry.username === username),
      );
      set({ status: "done", entries });
      announcer.announce(
        entries.length === 0 ? copy.LOOKUP_NONE : `${entries.length} found`,
      );
      return;
    }
    set({
      status: "failed",
      ...(result.kind === "uncertain" ||
      result.kind === "invalid" ||
      result.kind === "forbidden"
        ? { requestId: "requestId" in result ? result.requestId : undefined }
        : {}),
    });
  };

  const offline = !env.online;
  return (
    <section aria-labelledby={ids.heading} className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Button variant="quiet" onClick={onBack}>
          ‹ {copy.LOOKUP_BACK}
        </Button>
        <div className="flex flex-col">
          <h2 id={ids.heading} className="text-[15px] font-medium text-ink-1">
            {copy.LOOKUP_TITLE}
          </h2>
          <span className="text-[12.5px] text-ink-2">{purpose}</span>
        </div>
      </div>
      {offline ? (
        <p className="text-[13px] text-ink-2">{copy.LOOKUP_NEEDS_CONNECTION}</p>
      ) : null}
      <section
        aria-labelledby={`${ids.search}-h`}
        className="flex flex-col gap-2"
        data-lookup="search"
      >
        <h3
          id={`${ids.search}-h`}
          className="text-[13.5px] font-medium text-ink-1"
        >
          {copy.LOOKUP_SEARCH}
        </h3>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!offline && query.trim() !== "")
              void ask("search", query.trim(), setSearch);
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              label={copy.LOOKUP_SEARCH_LABEL}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
            />
          </div>
          {offline ? (
            <Button disabled reason={copy.LOOKUP_NEEDS_CONNECTION}>
              {copy.LOOKUP_SEARCH_BUTTON}
            </Button>
          ) : (
            <Button type="submit">{copy.LOOKUP_SEARCH_BUTTON}</Button>
          )}
        </form>
        <Results found={search} onChoose={onChoose} exact={false} />
      </section>
      <section
        aria-labelledby={`${ids.exact}-h`}
        className="flex flex-col gap-2"
        data-lookup="exact"
      >
        <h3
          id={`${ids.exact}-h`}
          className="text-[13.5px] font-medium text-ink-1"
        >
          {copy.LOOKUP_EXACT}
        </h3>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!offline && exact.trim() !== "")
              void ask("exact", exact.trim(), setPrecise);
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              label={copy.LOOKUP_EXACT_LABEL}
              value={exact}
              onChange={(event) => setExact(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
          {offline ? (
            <Button disabled reason={copy.LOOKUP_NEEDS_CONNECTION}>
              {copy.LOOKUP_EXACT_BUTTON}
            </Button>
          ) : (
            <Button type="submit">{copy.LOOKUP_EXACT_BUTTON}</Button>
          )}
        </form>
        <Results found={precise} onChoose={onChoose} exact />
      </section>
    </section>
  );
}

function Results({
  found,
  onChoose,
  exact,
}: {
  found: Found;
  onChoose(entry: DirectoryEntry): void;
  exact: boolean;
}) {
  if (found.status === "idle") return null;
  if (found.status === "busy")
    return <p className="text-[12.5px] text-ink-2">…</p>;
  if (found.status === "failed")
    return (
      <p className="text-[12.5px] text-ink-1" data-lookup-failed="">
        {copy.LOOKUP_FAILED}
        {found.requestId ? ` ${copy.REQUEST_ID(found.requestId)}` : ""}
      </p>
    );
  if (found.entries.length === 0)
    return (
      <div className="flex flex-col gap-1" data-lookup-empty="">
        <p className="text-[13px] font-medium text-ink-1">{copy.LOOKUP_NONE}</p>
        {exact ? (
          <p className="text-[12.5px] leading-[1.55] text-ink-2">
            {copy.LOOKUP_NONE_EXACT}
          </p>
        ) : null}
      </div>
    );
  return (
    <List className="flex flex-col gap-1.5">
      {found.entries.map((entry) => (
        <li
          key={entry.id}
          className="flex min-h-11 list-none items-center gap-3 rounded-row border border-hairline-strong bg-panel px-3 py-1.5"
        >
          <span className="min-w-0 flex-1 break-words text-[13.5px] text-ink-1">
            {entry.username}
          </span>
          <Button
            aria-label={`${copy.LOOKUP_CHOOSE}: ${entry.username}`}
            onClick={() => onChoose(entry)}
          >
            {copy.LOOKUP_CHOOSE}
          </Button>
        </li>
      ))}
    </List>
  );
}
