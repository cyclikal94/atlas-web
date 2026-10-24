import type {
  CacheRow,
  CommandRegistry,
  CommandSpec,
  CurrentRead,
  CurrentReadIo,
  DraftWithCommand,
  EnqueueRequest,
} from "../../data";

/**
 * THE registration of the `archive` command kind (`/task-commands` `archive {id, expected_version, archived}`), which several slices share:
 * a person and a field (WEB-11a), a task and a list (WEB-10a/WEB-10b). The command registry throws on a second registration of one kind,
 * so no slice registers `archive` itself: each adds a per-kind CURRENT READER here (`registerArchiveReader`), and this module registers
 * the one spec, once (WEB-11a §3.4, §6 item 3).
 *
 * - `describe`: "Archive or restore".
 * - `readCurrent`: the readers are asked in the order they were added; the first that recognises the target answers. A reader answers
 *   `null` for a target that is not of its kind (a `404` from a person read is not proof the target is gone: it may be a task or a field).
 *   When none recognises it, the current state is `indeterminate`: the dialog says it could not load it, and the row's own conflict UI
 *   (the slice's screen) covers it.
 * - `rebuild`: the same `archived` choice on the version the current read returned (never the cache), or nothing without one. A slice
 *   can register its own rebuilder by resource kind, retaining its reviewed-base, permission and captured-defaults rules.
 */
export type ArchiveReader = (
  id: string,
  io: CurrentReadIo,
) => Promise<CurrentRead | null>;

const readers: ArchiveReader[] = [];
const rebuilders = new Map<
  CacheRow["kind"],
  NonNullable<CommandSpec["rebuild"]>
>();

/** A slice can retain its version, permission and captured-defaults rules for its resource kind. */
export function registerArchiveRebuilder(
  kind: CacheRow["kind"],
  rebuild: NonNullable<CommandSpec["rebuild"]>,
): void {
  rebuilders.set(kind, rebuild);
}

/** Adds a per-kind reader (idempotent for the same function). */
export function registerArchiveReader(reader: ArchiveReader): void {
  if (!readers.includes(reader)) readers.push(reader);
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The archive command a draft carries, or null when its body is not one. */
export function archiveOf(
  draft: DraftWithCommand,
): { id: string; archived: boolean } | null {
  const command = (draft.command as Obj).command;
  if (
    !isObject(command) ||
    command.kind !== "archive" ||
    typeof command.id !== "string" ||
    typeof command.archived !== "boolean"
  )
    return null;
  return { id: command.id, archived: command.archived };
}

/** The current state through the readers, in order. */
export async function readArchiveTarget(
  draft: DraftWithCommand,
  io: CurrentReadIo,
): Promise<CurrentRead> {
  const target = archiveOf(draft);
  if (target === null) return { kind: "indeterminate" };
  for (const reader of readers) {
    const answer = await reader(target.id, io);
    if (answer !== null) return answer;
  }
  return { kind: "indeterminate" };
}

export function rebuildArchive(
  draft: DraftWithCommand,
  current: CacheRow | null,
  related?: readonly CacheRow[],
): EnqueueRequest | null {
  const target = archiveOf(draft);
  if (target === null || current === null || current.id !== target.id)
    return null;
  const rebuild = rebuilders.get(current.kind);
  if (rebuild !== undefined) return rebuild(draft, current, related);
  return {
    endpoint: "/task-commands",
    targets: [
      {
        resourceId: target.id,
        role: "primary",
        basis: "resource",
        versionChecked: true,
      },
    ],
    build: () => ({
      command: {
        command: {
          kind: "archive",
          id: target.id,
          expected_version: current.version,
          archived: target.archived,
        },
      },
      displayPatch: { [target.id]: { archived: target.archived } },
    }),
  };
}

const registered = new WeakSet<CommandRegistry>();

/** Registers the `archive` spec into `registry`, once per registry (a second call does nothing). */
export function registerArchiveKind(registry: CommandRegistry): void {
  if (registered.has(registry)) return;
  registry.register("archive", {
    describe: () => "Archive or restore",
    readCurrent: readArchiveTarget,
    rebuild: rebuildArchive,
    admission: (draft) => {
      const target = archiveOf(draft);
      return target === null ? {} : { [target.id]: { requiresEdit: true } };
    },
  });
  registered.add(registry);
}

/** For tests: forget the readers and slice rebuilders. */
export function forgetArchiveReaders(): void {
  readers.length = 0;
  rebuilders.clear();
}
