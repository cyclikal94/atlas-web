import { useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import type { CalendarApi } from "./api";
import {
  ACCESS_LOST,
  BEARER_LABEL,
  CANCEL,
  CAUSE_FETCH,
  CAUSE_UNCONFIGURED,
  CHECK,
  CHECK_FAILED,
  CHECK_NOT_FOUND,
  CONNECT,
  LABEL,
  LINK_TITLE,
  LINKED,
  NEEDS_CONNECTION,
  ONLINE_ONLY,
  RETRY,
  SAVE_FAILED,
  SECRET_HELP,
  SOURCE_GONE,
  TIMEZONE,
  URL_LABEL,
  URL_NOT_ALLOWED,
  URL_REFUSED,
  VALUE_REFUSED,
} from "./copy";
import { Field, FormMessage, TimezoneSuggestions } from "./fields";
import { useLive } from "./live";
import { identityMemory } from "./memory";
import { linkCommand } from "./model/commands";
import type { Environment } from "./model/status";
import { headerActions } from "./model/status";
import {
  classifySubmission,
  createSubmission,
  type SubmissionOutcome,
} from "./model/submission";
import {
  bearerError,
  defaultTimezone,
  labelError,
  timezoneError,
  urlError,
} from "./model/validation";

interface Fields {
  label: string;
  timezone: string;
  url: string;
  bearer: string;
}

type Errors = Partial<Record<keyof Fields, string | null>>;

/** What the form says after an answer (never a value the person typed). */
export function submissionMessage(outcome: SubmissionOutcome): {
  message: string | null;
  field?: { name: "url"; message: string };
} {
  switch (outcome.kind) {
    case "uncertain":
    case "not_sent":
      return { message: SAVE_FAILED };
    case "offline":
      return { message: NEEDS_CONNECTION };
    case "refused":
      switch (outcome.reason) {
        case "url_refused":
          return {
            message: null,
            field: { name: "url", message: URL_REFUSED },
          };
        case "url_not_allowed":
          return {
            message: null,
            field: { name: "url", message: URL_NOT_ALLOWED },
          };
        case "unconfigured":
          return { message: CAUSE_UNCONFIGURED };
        case "fetch_failed":
          return { message: CAUSE_FETCH };
        case "access":
          return { message: ACCESS_LOST };
        case "gone":
          return { message: SOURCE_GONE };
        default:
          return { message: VALUE_REFUSED };
      }
    default:
      return { message: null };
  }
}

/**
 * "Link a calendar…" (ONLINE ONLY; WEB-13a, D-13a-7): a create WITH a connection, sent directly and never stored. The URL and token
 * live in this form's state alone and leave with it (success, close, unmount); a reload requires re-entering them. "Retry" resends the
 * identical pair (key and body), so an answer that was lost is recognised and the source is not created twice; an edit of any field
 * makes the next attempt a new operation. After an uncertain attempt, "Check" asks the server whether the source now exists.
 *
 * Revision 2: entering a URL or token is online only as well (Q22): offline, both fields are disabled with the reason and a change that
 * arrives anyway is put back, while what was entered stays in the open form for the person to send once back online. A request is
 * admitted only while Link is still available; a second press before the screen shows the first as busy does nothing; and an answer
 * that arrives after the form has closed closes nothing (another dialog may be open by then).
 */
export function LinkCalendarDialog({
  api,
  environment,
  onClose,
}: {
  api: CalendarApi;
  environment: Environment;
  onClose(): void;
}) {
  const announcer = useAnnouncer();
  const formId = useId();
  const zonesId = useId();
  const [fields, setFields] = useState<Fields>(() => ({
    label: "",
    timezone: defaultTimezone(),
    url: "",
    bearer: "",
  }));
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const submission = useRef(
    createSubmission<Fields>(() => crypto.randomUUID()),
  );
  const sourceIds = useRef(new Map<string, string>());
  const available = headerActions(environment).link;
  const latestAvailable = useRef(available);
  latestAvailable.current = available;
  // Its requests are admitted only while this form is open, under the client it was opened with, online, and while Link is available.
  const lifetime = useLive(
    api,
    environment.online,
    () => latestAvailable.current.enabled,
  );
  // A synchronous latch over Connect and Check: one request at a time, whatever arrives before the next render.
  const inFlight = useRef(false);

  const edit = (name: keyof Fields, value: string) => {
    setFields((previous) => ({ ...previous, [name]: value }));
    submission.current.invalidate();
    setUncertain(false);
  };

  /** A connection field: offline it is disabled, and a change that arrives anyway is put back (Q22: entry is online only). */
  const editSecret = (
    name: "url" | "bearer",
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (!lifetime.online()) {
      event.target.value = fields[name];
      return;
    }
    edit(name, event.target.value);
  };

  const done = () => {
    announcer.announce(LINKED);
    if (lifetime.mounted()) onClose();
  };

  const submit = async () => {
    if (inFlight.current) return;
    const next: Errors = {
      label: labelError(fields.label),
      timezone: timezoneError(fields.timezone),
      url: urlError(fields.url, "link"),
      bearer: bearerError(fields.bearer),
    };
    setErrors(next);
    if (Object.values(next).some((value) => value !== null)) return;
    if (!available.enabled) {
      setMessage(available.reason ?? NEEDS_CONNECTION);
      return;
    }
    const pair = submission.current.attempt({
      label: fields.label.trim(),
      timezone: fields.timezone.trim(),
      url: fields.url.trim(),
      bearer: fields.bearer,
    });
    let id = sourceIds.current.get(pair.key);
    if (id === undefined) {
      id = crypto.randomUUID();
      sourceIds.current.set(pair.key, id);
    }
    const afterUncertain = submission.current.uncertain;
    setBusy(true);
    setMessage(null);
    inFlight.current = true;
    const answer = await api
      .command(
        linkCommand({
          id,
          label: pair.body.label,
          timezone: pair.body.timezone,
          connection: { url: pair.body.url, bearer: pair.body.bearer },
        }),
        pair.key,
        lifetime.live,
      )
      .finally(() => {
        inFlight.current = false;
      });
    setBusy(false);
    const outcome =
      !answer.ok && answer.kind === "closed" && !lifetime.online()
        ? ({ kind: "offline" } as const)
        : classifySubmission(answer, afterUncertain);
    if (outcome.kind === "succeeded") return done();
    if (outcome.kind === "uncertain") {
      submission.current.markUncertain();
      setUncertain(true);
    }
    if (outcome.kind === "refused" && outcome.reason === "access")
      // A 403 remounts the screen (the session re-checks it): the words are kept for the header, the typed values are not.
      identityMemory(api.identity.account, api.identity.epoch).notices.set(
        "link",
        ACCESS_LOST,
      );
    const shown = submissionMessage(outcome);
    setMessage(shown.message);
    if (shown.field) setErrors((e) => ({ ...e, url: shown.field?.message }));
  };

  const check = async () => {
    if (inFlight.current || !latestAvailable.current.enabled) return;
    const pair = submission.current.current();
    const id = pair === null ? undefined : sourceIds.current.get(pair.key);
    if (id === undefined) return;
    setBusy(true);
    inFlight.current = true;
    const found = await api.liveSources(lifetime.live).finally(() => {
      inFlight.current = false;
    });
    setBusy(false);
    if (found.ok && found.value.sources.has(id)) return done();
    setMessage(
      found.ok && found.value.complete ? CHECK_NOT_FOUND : CHECK_FAILED,
    );
  };

  const entry = environment.online
    ? {}
    : ({ disabled: true, hint: NEEDS_CONNECTION } as const);
  return (
    <Dialog
      open
      onClose={onClose}
      title={LINK_TITLE}
      description={ONLINE_ONLY}
      footer={
        <>
          {busy ? (
            <Button variant="primary" disabled reason="Working…">
              {uncertain ? RETRY : CONNECT}
            </Button>
          ) : !available.enabled ? (
            <Button variant="primary" disabled reason={available.reason ?? ""}>
              {CONNECT}
            </Button>
          ) : (
            <Button variant="primary" type="submit" form={formId}>
              {uncertain ? RETRY : CONNECT}
            </Button>
          )}
          {uncertain && !busy && available.enabled ? (
            <Button onClick={() => void check()}>{CHECK}</Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {CANCEL}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        autoComplete="off"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label={LABEL}
          name="label"
          value={fields.label}
          error={errors.label}
          onChange={(event) => edit("label", event.target.value)}
        />
        <Field
          label={TIMEZONE}
          name="timezone"
          value={fields.timezone}
          list={zonesId}
          autoComplete="off"
          error={errors.timezone}
          onChange={(event) => edit("timezone", event.target.value)}
        />
        <TimezoneSuggestions id={zonesId} />
        <Field
          label={URL_LABEL}
          name="url"
          type="url"
          secret
          error={errors.url}
          {...entry}
          onChange={(event) => editSecret("url", event)}
        />
        <Field
          label={BEARER_LABEL}
          name="bearer"
          type="password"
          secret
          error={errors.bearer}
          {...entry}
          onChange={(event) => editSecret("bearer", event)}
        />
        <p className="text-[12.5px] leading-[1.6] text-ink-2">{SECRET_HELP}</p>
        <FormMessage message={message} />
      </form>
    </Dialog>
  );
}
