import { createIssueTransport } from "../../lib/api-client/boundary";
import { createUnstampedApi } from "../../lib/api-client/unstamped";
import type { SessionPorts } from "../kernel/state";
import type { DeletionPorts } from "../ports/deletion";
import type { AuthStore } from "../ports/store";
import type { ProtectedSurface } from "../ports/surface";
import { noopTrace, type Trace } from "../ports/trace";
import { createBroadcastHints } from "./broadcast-hints";
import {
  createBrowserClock,
  createBrowserIds,
  createBrowserPage,
} from "./browser-page";
import { createDefaultDeletionPorts } from "./default-deletion";
import { createWebLocksPort } from "./web-locks";

export interface BrowserPortsOptions {
  /** Opened by the composition root, which also uses it for the boot canary. */
  store: AuthStore;
  surface: ProtectedSurface;
  /** WEB-09a registers the real database, local-work and coordination adapters here (D-14). */
  deletion?: Partial<Omit<DeletionPorts, "ledger">>;
  /** Test instrumentation only (the fixture-only harness); production passes nothing and gets the no-op trace. */
  trace?: Trace;
}

/** The production ports. The api-client transports are assembled here so the kernel never imports `fetch`. */
export function browserPorts(options: BrowserPortsOptions): SessionPorts {
  return {
    store: options.store,
    locks: createWebLocksPort(navigator.locks),
    hints: createBroadcastHints(),
    clock: createBrowserClock(),
    ids: createBrowserIds(),
    page: createBrowserPage(),
    surface: options.surface,
    transport: createIssueTransport(),
    unstamped: createUnstampedApi(),
    deletion: createDefaultDeletionPorts(options.store, options.deletion),
    trace: options.trace ?? noopTrace,
  };
}
