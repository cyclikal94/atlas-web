import { useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { useFormRecoveryPort } from "../data";
import { RecoveryBanner } from "../lib/form-recovery/RecoveryBanner";
import { pageFormRegistry } from "../lib/form-recovery/registry";
import { useRecoverableForm } from "../lib/form-recovery/use-recoverable-form";

// FIXTURE: the page's registry of recoverable forms, for a spec to read what the app-update coordinator sees.
(window as unknown as { __atlasForms?: typeof pageFormRegistry }).__atlasForms =
  pageFormRegistry;

/**
 * FIXTURE ONLY (WEB-14a). The recoverable form the PWA browser checks drive (P-U3, P-U5): the `/__session` harness mounts it in the REAL
 * protected tree with `?form=1`, over the displayed account's real `form_recovery` store, using the contract feature slices will use
 * (`useFormRecoveryPort` + `useRecoverableForm` + WEB-07's `RecoveryBanner`). Submitting sends nothing anywhere: it only discards the
 * copies, as a real form does after a successful submission, and records that it happened. No product form exists yet (WEB-10a onwards).
 */
export const FIXTURE_FORM_CONTEXT = "fixture-note:/today";
const ALLOW = [{ name: "title" }, { name: "notes" }];

export function FixtureRecoveryForm() {
  const port = useFormRecoveryPort();
  const form = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const [submitted, setSubmitted] = useState(0);
  const recovery = useRecoverableForm({
    formContext: FIXTURE_FORM_CONTEXT,
    allow: ALLOW,
    formRef: form,
    port,
  });
  return (
    <section
      aria-label="Fixture recovery form"
      data-fixture-form=""
      data-ready={recovery.ready ? "true" : "false"}
      data-port={port ? "open" : "none"}
      data-submitted={submitted}
      className="m-4 flex flex-col gap-3"
    >
      {recovery.restored ? (
        <RecoveryBanner
          state={{ kind: "restored", onDiscard: () => void recovery.discard() }}
          firstFieldRef={first}
        />
      ) : null}
      {recovery.alternatives.length > 0 ? (
        <div data-alternatives={recovery.alternatives.length}>
          <p>Other saved copies of this form:</p>
          {recovery.alternatives.map((copy) => (
            <Button
              key={copy.tabInstanceId}
              onClick={() => recovery.restoreAlternative(copy.tabInstanceId)}
            >
              {`Restore the copy saved ${copy.savedAt}`}
            </Button>
          ))}
        </div>
      ) : null}
      <form
        ref={form}
        aria-label="Fixture note"
        onSubmit={(event) => {
          event.preventDefault();
          void recovery.onSubmitted().then(() => setSubmitted((n) => n + 1));
        }}
        className="flex flex-col gap-2"
      >
        <label className="flex flex-col gap-1">
          Title
          <input ref={first} name="title" defaultValue="" />
        </label>
        <label className="flex flex-col gap-1">
          Notes
          <textarea name="notes" defaultValue="" />
        </label>
        <label className="flex flex-col gap-1">
          Password
          <input name="password" type="password" defaultValue="" />
        </label>
        <div>
          <Button type="submit">Save note</Button>
        </div>
      </form>
    </section>
  );
}
