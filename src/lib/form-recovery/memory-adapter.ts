import type { FormRecoveryPort, RecoverySnapshot, SaveResult } from "./port";

/**
 * Fixture adapter for tests and fixture mode. It is NOT the real store: WEB-09a implements FormRecoveryPort over
 * the Dexie form_recovery store (src/data/ports/form-recovery.ts). A passing test against this adapter is not evidence about real storage.
 */
export class MemoryRecoveryAdapter implements FormRecoveryPort {
  private readonly store = new Map<string, RecoverySnapshot>();
  /** Set to make the next saves fail, to exercise the failure path. */
  failSaves = false;
  /** Set to make the next saves refuse, as the real store does while an account is being signed out. */
  refuseSaves = false;

  private key(formContext: string, tabInstanceId: string): string {
    return JSON.stringify([formContext, tabInstanceId]);
  }

  async save(snapshot: RecoverySnapshot): Promise<SaveResult> {
    if (this.refuseSaves) return "refused";
    if (this.failSaves) return "failed";
    this.store.set(
      this.key(snapshot.formContext, snapshot.tabInstanceId),
      structuredClone(snapshot),
    );
    return "saved";
  }

  async load(
    formContext: string,
    tabInstanceId: string,
  ): Promise<RecoverySnapshot | null> {
    const found = this.store.get(this.key(formContext, tabInstanceId));
    return found ? structuredClone(found) : null;
  }

  async discard(formContext: string, tabInstanceId: string): Promise<void> {
    this.store.delete(this.key(formContext, tabInstanceId));
  }
}
