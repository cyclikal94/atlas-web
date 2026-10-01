import { bootCanary } from "../model/reducers/misc";
import type { AuthStore } from "../ports/store";

/**
 * The `atlas-auth` boot canary (matrix 3.7.2 item 3): one small write of `boot.last_boot_at`. A page that cannot write the
 * record cannot coordinate, so it never exposes anything: the compatibility screen replaces the application. It runs
 * before `start()`, and before the static gate could ever lift.
 */
export async function runAuthCanary(
  store: AuthStore,
  now: () => string = () => new Date().toISOString(),
): Promise<boolean> {
  try {
    await store.transact((records) => bootCanary(records, { now: now() }), {
      label: "canary",
    }).complete;
    return true;
  } catch {
    return false;
  }
}
