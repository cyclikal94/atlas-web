import type {
  DiscardResult,
  FormRecoveryPort,
  RecoverySnapshot,
  SaveResult,
} from "./port";

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
  /**
   * Revision 7 (R13): set to make the next reads REJECT, as the real store's do when it cannot be read (an aborted transaction, a closed
   * handle): never an empty answer. `true` fails every read; a function fails the reads it answers true for.
   */
  failReads:
    | boolean
    | ((formContext: string, tabInstanceId?: string) => boolean) = false;

  private failing(formContext: string, tabInstanceId?: string): boolean {
    const fail = this.failReads;
    return typeof fail === "function" ? fail(formContext, tabInstanceId) : fail;
  }

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
    if (this.failing(formContext, tabInstanceId))
      throw new Error("injected recovery read failure");
    const found = this.store.get(this.key(formContext, tabInstanceId));
    return found ? structuredClone(found) : null;
  }

  /** Set to make the next discards fail (the copy stays), to exercise the honest failure of a discard. */
  failDiscards = false;

  async discard(
    formContext: string,
    tabInstanceId: string,
  ): Promise<DiscardResult> {
    if (this.refuseSaves) return "refused";
    if (this.failDiscards) return "failed";
    this.store.delete(this.key(formContext, tabInstanceId));
    return "discarded";
  }

  async list(formContext: string): Promise<readonly RecoverySnapshot[]> {
    if (this.failing(formContext))
      throw new Error("injected recovery read failure");
    return [...this.store.values()]
      .filter((snapshot) => snapshot.formContext === formContext)
      .sort((a, b) =>
        a.savedAt === b.savedAt ? 0 : a.savedAt < b.savedAt ? 1 : -1,
      )
      .map((snapshot) => structuredClone(snapshot));
  }
}
