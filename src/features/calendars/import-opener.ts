import { createContext, useContext } from "react";

/**
 * How a row's "Import events" (and the page's drop zone) open the import dialog (WEB-13b): the screen owns the dialog, so a row that
 * changes from pending to cached while it is open (its create published) does not take the dialog with it. `sourceId` null: the person
 * chooses the source in the dialog (the drop zone). `file`: a file already chosen or dropped.
 */
export type OpenImport = (sourceId: string | null, file?: File) => void;

export const ImportOpenerContext = createContext<OpenImport | null>(null);

export const useOpenImport = (): OpenImport | null =>
  useContext(ImportOpenerContext);
