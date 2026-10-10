import type { BrowserPortsOptions } from "../../session";

/**
 * The three data ports of the canonical wipe, derived from the session's PUBLIC registration point
 * (`browserPorts({ deletion })`): the session index does not export the port interfaces, and nothing may import a deeper path
 * (F-BND-4). Deriving them keeps the data layer bound to exactly what the session accepts.
 */
type Deletion = NonNullable<BrowserPortsOptions["deletion"]>;
export type AccountDatabasePort = NonNullable<Deletion["database"]>;
export type LocalWorkPort = NonNullable<Deletion["localWork"]>;
export type WipeCoordinationPort = NonNullable<Deletion["coordination"]>;
export type DataDeletionPorts = {
  database: AccountDatabasePort;
  localWork: LocalWorkPort;
  coordination: WipeCoordinationPort;
};
