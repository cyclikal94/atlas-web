/**
 * Who controls a person's profile (D-11a-2, D-11a-5, D-11a-6). PURE.
 *
 * Linkage is NOT synced: a `Projection` carries none, and `can_edit` says nothing about it (a person linked to another account syncs
 * read-only, exactly like an ordinary read-only share). The only source is the online `GET /people/{id}` (`PersonDetail.linked_account_id`),
 * read for the displayed identity. Until such a read has answered on this page, the linkage is UNKNOWN, and nothing is inferred.
 */
export type LinkageState =
  | {
      known: true;
      /** `self`: linked to the signed-in account; `other`: to another account; `unlinked`: to none. */
      kind: "self" | "other" | "unlinked";
      accountId: string | null;
      /** The person's version in that answer (what `rename_profile`/`unlink` are guarded by). */
      version: number;
      readAt: number;
    }
  | {
      known: false;
      /** `offline`: nothing read this page and no connection; `loading`; `failed`: the read failed; `refused`: 403/404. */
      reason: "offline" | "loading" | "failed" | "refused";
    };

export const unknownLinkage = (
  reason: Extract<LinkageState, { known: false }>["reason"],
): LinkageState => ({ known: false, reason });

/**
 * A kept answer as the linkage NOW (review 25, R25.1): only while it is of the latest version of the person known (`floor`). A later
 * version may have changed who the person is linked to, so an older answer says nothing about now; it is never taken for "unlinked".
 */
export const currentLinkage = (
  kept: LinkageState | undefined,
  floor: number,
): LinkageState | null => (kept?.known && kept.version >= floor ? kept : null);

/** The linkage a `PersonDetail` answer says, for the signed-in `accountId`. */
export function linkageOf(
  answer: { linked_account_id: string | null; person: { version: number } },
  accountId: string,
  readAt: number,
): LinkageState {
  const linked = answer.linked_account_id;
  return {
    known: true,
    kind:
      linked === null ? "unlinked" : linked === accountId ? "self" : "other",
    accountId: linked,
    version: answer.person.version,
    readAt,
  };
}

/**
 * How "Rename" works for this person (D-11a-5):
 *  - known self: `rename_profile` (online-only; 1–200 characters);
 *  - known unlinked: the ordinary content `edit` (queueable; 1–300; needs `can_edit` and a policy version);
 *  - known other: disabled, the linked account owns the name;
 *  - unknown: disabled, a connection is needed to check who controls it.
 */
export type RenameRoute =
  | { kind: "rename_profile"; maxLength: 200 }
  | { kind: "edit"; maxLength: 300 }
  | { kind: "disabled"; reason: "other_owns" | "unknown" | "cannot_edit" };

export function renameRoute(
  linkage: LinkageState,
  canEdit: boolean,
): RenameRoute {
  if (!linkage.known) return { kind: "disabled", reason: "unknown" };
  switch (linkage.kind) {
    case "self":
      return { kind: "rename_profile", maxLength: 200 };
    case "unlinked":
      return canEdit
        ? { kind: "edit", maxLength: 300 }
        : { kind: "disabled", reason: "cannot_edit" };
    case "other":
      return { kind: "disabled", reason: "other_owns" };
  }
}

/** How "Unlink account" is offered (D-11a-6): enabled for the linked self only; disabled with a reason for another; absent otherwise. */
export type UnlinkOffer =
  | { kind: "enabled" }
  | { kind: "disabled"; reason: "other_owns" }
  | { kind: "absent" };

export function unlinkOffer(linkage: LinkageState): UnlinkOffer {
  if (!linkage.known) return { kind: "absent" };
  switch (linkage.kind) {
    case "self":
      return { kind: "enabled" };
    case "other":
      return { kind: "disabled", reason: "other_owns" };
    case "unlinked":
      return { kind: "absent" };
  }
}
