import { useId, useRef } from "react";
import { Button } from "../../components/ui/button";
import { useRecoveryHost } from "../../lib/form-recovery/editor";
import {
  BOUNDS,
  BROWSE,
  DROP_CLASS,
  DROP_PROMPT,
  NO_SOURCE_YET,
} from "./copy-import";
import { useImportableSources } from "./ImportDialog";
import { useOpenImport } from "./import-opener";
import { importContext } from "./import-recovery";
import { useCalendarRecoveryIdentity } from "./recovery";
import { useOpenWhenReady } from "./session-recovery";

/**
 * The page's import entry (WEB-13b §4.2; the wireframe's "Import — offline-queueable" zone): a real file control behind "browse" is the
 * primary way in; dropping a file on the zone is an enhancement only. A chosen file opens the import dialog with a source to choose. The
 * zone is unavailable, with its reason, when this account has no source it can import into. Revision 6 (R7): while the zone's import is
 * kept (the in-dialog sync control), Browse shows it again, and a dropped file is a new file chosen in it.
 */
export function ImportDropZone() {
  const open = useOpenImport();
  const sources = useImportableSources();
  const input = useRef<HTMLInputElement | null>(null);
  const labelId = useId();
  // A later page of sources may hold one this account can import into (the dialog pages them, R4).
  const available =
    open !== null && (sources.rows.length > 0 || sources.page.partial);
  // M-13b-1 G-3 (WEB-13b maintenance merge of accepted main): the chooser's import left by the page before an app update is
  // reopened once on its copy (its source and window; the file is never in a copy, so the person chooses it again).
  useRecoveryHost({
    identity: useCalendarRecoveryIdentity(),
    context: importContext(null),
    open: useOpenWhenReady(available, () => open?.open(null)),
  });
  return (
    <div className="flex flex-col gap-1">
      <span
        id={labelId}
        className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground"
      >
        {DROP_CLASS}
      </span>
      <section
        aria-labelledby={labelId}
        data-import-drop=""
        className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-card p-3.5"
        onDragOver={(event) => {
          if (available) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!available) return;
          event.preventDefault();
          const file = event.dataTransfer.files[0];
          if (file !== undefined) open?.open(null, file);
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-foreground">{DROP_PROMPT}</span>
          <input
            ref={input}
            type="file"
            accept=".ics,text/calendar"
            // Not rendered (no 1 px target, nothing in the tab order): the button beside it opens it.
            hidden
            // Cleared just before the picker opens, never after a choice (WebKit fails reading a File whose input was cleared).
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) open?.open(null, file);
            }}
          />
          {available ? (
            <Button
              aria-describedby={labelId}
              onClick={() => {
                // The chooser's import kept by the in-dialog sync control is shown again, without another file (R7).
                if (open?.resumeChooser() === true) return;
                const control = input.current;
                if (control === null) return;
                control.value = "";
                control.click();
              }}
            >
              {BROWSE}
            </Button>
          ) : (
            <Button aria-describedby={labelId} disabled reason={NO_SOURCE_YET}>
              {BROWSE}
            </Button>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{BOUNDS}</span>
      </section>
    </div>
  );
}
