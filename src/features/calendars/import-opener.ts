import { createContext, useContext } from "react";

/**
 * How a row's "Import events" (and the page's drop zone) open the import dialog (WEB-13b): the screen owns the dialog, so a row that
 * changes from pending to cached while it is open (its create published) does not take the dialog with it. `sourceId` null: the person
 * chooses the source in the dialog (the drop zone). `file`: a file already chosen or dropped.
 *
 * Revision 6 (R7): the dialog shows the import's editing session, which the in-dialog sync control keeps (`import-kept.ts`). Opening it
 * again from the same entry shows that session; `resumeChooser` shows the drop zone's kept session without asking for another file (false:
 * there is none, and Browse opens the file picker).
 */
export type OpenImport = (sourceId: string | null, file?: File) => void;

export interface ImportOpener {
  open: OpenImport;
  resumeChooser(): boolean;
}

export const ImportOpenerContext = createContext<ImportOpener | null>(null);

export const useOpenImport = (): ImportOpener | null =>
  useContext(ImportOpenerContext);
