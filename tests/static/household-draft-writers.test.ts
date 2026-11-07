// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * WEB-12b revision 2 (Review 3 F-R3-1, finding family `m1-household-submission-rules-without-sensitive-tests`; design assessment of
 * 7 November 2026, invariants I-9 and I-10): every site that WRITES the household page memory's drafts or bases, completes a submission
 * ticket, or wires an input to its recovery model, is listed here with the writer it is and the tests that pin it. Each household input
 * has two authorities that must move in one step (page memory and its WEB-14a recoverable model, `households/form-recovery.ts`), kept by
 * hand at each call site; a new writer, a fourth input, or a writer gone fails this test until it is classified and covered.
 *
 * Writers (the design assessment's numbering): W1 typing, W2 a directory choice, W3 a restore, W4 "Discard instead", W5 a first-try
 * success, W6 a first-try answer that is not one (and Rename's conflict), W7 a Try again that completed the form, W8 Rename's Escape,
 * W9 another identity, W10 the tests' forget, W11 the lookup's own bookkeeping (presentation, never recovered: D-12b-15). `P` is page
 * memory's own primitive, `T` the ticket protocol, `D` a definition, `R` a reader of a restored rename's base.
 *
 * Known asymmetries are listed, not hidden (`known`): O-R3-3 (a conflict forgets the base in page memory only), and decision D-1 / the
 * latent DA-2 (a Try again success, and Rename's Escape, drop page memory without the registry's freeze being asked; no product path
 * reaches it while the dialogs are modal: O-R3-4). The second half is the RULE-TO-TEST MAP (I-10): for each documented rule and input,
 * the tests that pin it, mirrored as a table in `docs/pwa.md` ("WEB-12b's household dialogs").
 */
const ROOT = join(import.meta.dirname, "..", "..");
const DIR = "src/features/sharing/households";

type Writer =
  | "W1"
  | "W2"
  | "W3"
  | "W4"
  | "W5"
  | "W6"
  | "W7"
  | "W8"
  | "W9"
  | "W10"
  | "W11"
  | "P"
  | "T"
  | "D"
  | "R";
interface Pin {
  file: string;
  title: string;
}
interface Site {
  /** The source line, trimmed (comments removed). */
  line: string;
  writer: Writer;
  /** The inputs it serves and the rule it must honour. */
  what: string;
  /** The tests that fail when it breaks (each must exist). */
  pins?: Pin[];
  /** Why nothing pins it (presentation, a definition): required when `pins` is absent. */
  reason?: string;
  /** A known asymmetry, with its decision or observation id. */
  known?: string;
}

const RULES = "tests/features/sharing/households-submission-rules.test.tsx";
const RECOVERY = "tests/features/sharing/households-recovery.test.tsx";
const OWNER_DISCARD = "tests/features/recovery-owner-discard.test.tsx";
const INVITATIONS = "tests/features/sharing/households-invitations.test.tsx";
const PAGE = "tests/features/sharing/households-page.test.tsx";
const rules = (title: string): Pin => ({ file: RULES, title });
const recovery = (title: string): Pin => ({ file: RECOVERY, title });

const T = {
  createTyped: recovery(
    "M-1 New household: registered while open, dirty once typed; the accepted update saves the name and reloads once; after the reload the dialog restores it and nothing is sent",
  ),
  createFrozen: recovery(
    "M-1 while an update reload is being prepared typing changes nothing and Create sends nothing",
  ),
  createI7: recovery(
    "M-1 I7: a create answered after a newer name was typed keeps that name as the New household draft, still dirty",
  ),
  createO1: rules(
    "O1 New household (R2's control): a create answered with nothing typed since clears the name and removes the saved copy",
  ),
  createR3: rules(
    "R3 New household, uncertain: the name stays dirty, and an update saves it",
  ),
  createR3Refused: rules(
    "R3 New household, a definite refusal (your 32 households): the name stays dirty, and an update saves it",
  ),
  createR3Update: rules(
    "R3 New household, uncertain then an accepted update: the name is saved, restored after the reload, and nothing is resent",
  ),
  createDiscard: {
    file: OWNER_DISCARD,
    title:
      "S1 create: newer input survives a late removal, on screen and in the model",
  },
  createD1: rules(
    "D-1 New household: a successful Try again of a lost create forgets the name, even one typed since; it was resent byte for byte",
  ),
  renameRestored: recovery(
    "M-1 Rename: the accepted update saves the name with the household version it was composed against; after the reload the dialog restores it once the household is read",
  ),
  renameConflict: recovery(
    "M-1 Rename: a restored rename is saved under the version it was composed against; a household renamed since meets the conflict, and the next Save is against the version read now",
  ),
  renameEscape: recovery(
    "M-1 Rename: Escape (the dialog's discard) drops the draft, and its recovery session ends: its copy goes and nothing is left for an update",
  ),
  renameTypingFrozen: rules(
    "R1 Rename: while an update reload is being prepared typing changes nothing (and, the freeze over, it is taken again)",
  ),
  renameSendFrozen: rules(
    "R1 Rename: while an update reload is being prepared Save name sends nothing (and, the freeze over, it sends)",
  ),
  renameI7: rules(
    "R2 Rename I7: a name typed while Save name is on its way stays the draft, dirty, and an update saves it",
  ),
  renameO1: rules(
    "O1 Rename (R2's control): a rename answered with nothing typed since clears the draft, removes the saved copy and closes the dialog",
  ),
  renameR3: rules(
    "R3 Rename, uncertain: the name stays dirty, and an update saves it",
  ),
  renameR3Refused: rules(
    "R3 Rename, a definite refusal (changed elsewhere): the name stays dirty, and an update saves it",
  ),
  renameR3Update: rules(
    "R3 Rename, uncertain then an accepted update: the name is saved, restored after the reload, and nothing is resent",
  ),
  renameBase: rules(
    "R4 Rename CONTROL: a restored rename is saved under the version it was composed against (3)",
  ),
  renameEscapeBase: rules(
    "R4 Rename Escape: the restored draft dropped, a fresh rename is saved under the household's version of now (4)",
  ),
  renameDiscardBase: rules(
    "R4 Rename Discard instead: the restored draft reset, a fresh rename is saved under the household's version of now (4)",
  ),
  renameD1: rules(
    "D-1 Rename: a successful Try again of a lost rename forgets the name, even one typed since; it was resent byte for byte",
  ),
  renameRetryCloses: {
    file: PAGE,
    title:
      "MU-6233: a rename whose answer was lost, then a Try again answered: the dialog closes and the household's own route shows its new name (E-HH5 adapted)",
  },
  inviteTyped: recovery(
    "M-1 Invite: the username typed in the household's Invitations is saved by the accepted update and restored after the reload; nothing is looked up or sent",
  ),
  inviteChosen: recovery(
    "M-1 Invite: an account chosen in the directory lookup is the person's input: it replaces what was typed in the model too, and an update saves the chosen account",
  ),
  inviteTypingFrozen: rules(
    "R1 Invite: while an update reload is being prepared typing changes nothing (and, the freeze over, it is taken again)",
  ),
  inviteSendFrozen: rules(
    "R1 Invite: while an update reload is being prepared Invite looks nothing up and sends nothing (and, the freeze over, it does both)",
  ),
  inviteChoiceFrozen: rules(
    "R1 Invite: while an update reload is being prepared an account chosen in the directory lookup changes nothing (control: unfrozen, it replaces the input)",
  ),
  inviteI7: rules(
    "R2 Invite I7: a username typed while the invitation is on its way stays the draft, dirty, and an update saves it",
  ),
  inviteO1: rules(
    "O1 Invite (R2's control): an invitation answered with nothing typed since clears the field and removes the saved copy",
  ),
  inviteR3: rules(
    "R3 Invite, uncertain: the username stays dirty, and an update saves it",
  ),
  inviteR3Refused: rules(
    "R3 Invite, a definite refusal (the recipient's waiting invitations): the username stays dirty, and an update saves it",
  ),
  inviteR3NotFound: rules(
    "R3 Invite, the lookup finds nobody: nothing is sent and the username stays dirty, and an update saves it",
  ),
  inviteR3Update: rules(
    "R3 Invite, uncertain then an accepted update: the username is saved, restored after the reload, and nothing is looked up or resent",
  ),
  inviteDiscard: {
    file: OWNER_DISCARD,
    title:
      "S1 invite: newer input survives a late removal; nothing else is dirty",
  },
  inviteD1: rules(
    "D-1 Invite: a successful Try again of a lost invitation forgets the username, even one typed since; it was resent byte for byte",
  ),
  inviteRetryClears: {
    file: INVITATIONS,
    title:
      "MU-6232: an invite whose answer was lost, then a Try again that is answered: the username field is cleared (as after a first-try success), and the same key and body were sent",
  },
  identity: recovery(
    "M-1 another identity: the previous identity's household models leave the page's registry with its page memory",
  ),
} satisfies Record<string, Pin>;

const DA2 =
  "D-1 / DA-2 (latent): drops page memory without asking the registry's freeze; the model refuses its discard while frozen, so the two authorities split until the next edit. No product path: the dialogs are modal and the update banner inert (O-R3-4)";

/** The registry: per file, every matching line in source order. */
const SITES: Record<string, Site[]> = {
  [`${DIR}/InvitationsDialog.tsx`]: [
    {
      line: "const recovery = useHouseholdRecovery({",
      writer: "D",
      what: "the invitation's username: its model",
      pins: [T.inviteTyped],
    },
    {
      line: "if (draftKey !== null) memory.recovered(draftKey, value);",
      writer: "W3",
      what: "invite: a restored copy into an untouched field",
      pins: [T.inviteTyped],
    },
    {
      line: "if (draftKey !== null) memory.recovered(draftKey, null);",
      writer: "W4",
      what: "invite: Discard instead (admitted at the gesture, frozen refuses)",
      pins: [T.inviteDiscard],
    },
    {
      line: "memory.draft(draftKey, entry.username);",
      writer: "W2",
      what: "invite: the account chosen; R1 (the model first, refused while frozen)",
      pins: [T.inviteChosen, T.inviteChoiceFrozen],
    },
    {
      line: "memory.draft(lookupKey, null);",
      writer: "W11",
      what: "the lookup view closes",
      reason: "presentation key; never recovered (D-12b-15)",
    },
    {
      line: "onBack={() => memory.draft(lookupKey, null)}",
      writer: "W11",
      what: "the lookup view closes",
      reason: "presentation key; never recovered (D-12b-15)",
    },
    {
      // The template placeholders spelt with `$` joined in, so the registry is no template-in-string (lint).
      line: [
        "memory.drafts.set(`households:lookup-",
        "{which}:",
        "{scope}`, value);",
      ].join("$"),
      writer: "W11",
      what: "the lookup's typed queries, kept across a 403 remount",
      reason:
        "presentation; never recovered (D-12b-15); pinned natively by E-HH9 (MU-6302)",
    },
    {
      line: "onDiscard={() => memory.draft(lookupKey, null)}",
      writer: "W11",
      what: "Escape closes the lookup view (the username draft stays)",
      reason: "presentation key; never recovered (D-12b-15)",
    },
    {
      line: "const ticket = recovery?.submitting() ?? null;",
      writer: "T",
      what: "invite: the ticket, in the step of what it sends; R1 (none while frozen: nothing looked up or sent)",
      pins: [T.inviteSendFrozen],
    },
    {
      line: "completeTicket(ticket, ok);",
      writer: "W6",
      what: "invite: R3, only a durable success covers what was sent",
      pins: [
        T.inviteR3,
        T.inviteR3Refused,
        T.inviteR3NotFound,
        T.inviteR3Update,
      ],
    },
    {
      line: "if (ok && unchanged) memory.draft(draftKey, null);",
      writer: "W5",
      what: "invite: R2 (I7) and O1",
      pins: [T.inviteI7, T.inviteO1],
    },
    {
      line: "memory.draft(draftKey, event.target.value);",
      writer: "W1",
      what: "invite: typing; R1 (the model first, refused while frozen)",
      pins: [T.inviteTyped, T.inviteTypingFrozen],
    },
    {
      line: 'onClick={() => memory.draft(lookupKey, "open")}',
      writer: "W11",
      what: "Find an account opens the lookup view",
      reason: "presentation key; never recovered (D-12b-15)",
    },
  ],
  [`${DIR}/NameDialogs.tsx`]: [
    {
      line: "const recovery = useHouseholdRecovery({",
      writer: "D",
      what: "New household's name: its model",
      pins: [T.createTyped],
    },
    {
      line: "restored: (value) => memory.recovered(key, value),",
      writer: "W3",
      what: "create: a restored copy into an untouched dialog",
      pins: [T.createTyped],
    },
    {
      line: "reset: () => memory.recovered(key, null),",
      writer: "W4",
      what: "create: Discard instead",
      pins: [T.createDiscard],
    },
    {
      line: "const ticket = recovery.submitting();",
      writer: "T",
      what: "create: the ticket; R1 (none while frozen: nothing sent)",
      pins: [T.createFrozen],
    },
    {
      line: "completeTicket(ticket, result?.ok === true);",
      writer: "W6",
      what: "create: R3, only a durable success covers what was sent",
      pins: [T.createR3, T.createR3Refused, T.createR3Update],
    },
    {
      line: "if (unchanged) memory.draft(key, null);",
      writer: "W5",
      what: "create: R2 (I7) and O1",
      pins: [T.createI7, T.createO1],
    },
    {
      line: "memory.draft(key, event.target.value);",
      writer: "W1",
      what: "create: typing; R1 (the model first, refused while frozen)",
      pins: [T.createTyped, T.createFrozen],
    },
    {
      line: "const recovery = useHouseholdRecovery<RenameInput>({",
      writer: "D",
      what: "Rename's name and base: its model",
      pins: [T.renameRestored],
    },
    {
      line: "base: memory.bases.get(key) ?? household?.version ?? null,",
      writer: "R",
      what: "rename: the model's value carries the base the draft was composed against",
      pins: [T.renameRestored],
    },
    {
      line: "restored: (value) => memory.recovered(key, value.text, value.base),",
      writer: "W3",
      what: "rename: a restored copy WITH its base",
      pins: [T.renameRestored, T.renameBase],
    },
    {
      line: "reset: () => memory.recovered(key, null),",
      writer: "W4",
      what: "rename: Discard instead; R4 (the base goes with the draft)",
      pins: [T.renameDiscardBase],
    },
    {
      line: "onDiscard={() => memory.draft(key, null)}",
      writer: "W8",
      what: "rename: Escape drops the draft and its base (R4)",
      pins: [T.renameEscape, T.renameEscapeBase],
      known: DA2,
    },
    {
      line: "const base = memory.bases.get(key);",
      writer: "R",
      what: "rename: Save name is guarded by a restored rename's base",
      pins: [T.renameBase, T.renameConflict],
    },
    {
      line: "const ticket = recovery.submitting();",
      writer: "T",
      what: "rename: the ticket; R1 (none while frozen: nothing sent)",
      pins: [T.renameSendFrozen],
    },
    {
      line: "completeTicket(ticket, result?.ok === true);",
      writer: "W6",
      what: "rename: R3, only a durable success covers what was sent",
      pins: [T.renameR3, T.renameR3Refused, T.renameR3Update],
    },
    {
      line: "if (unchanged) memory.draft(key, null);",
      writer: "W5",
      what: "rename: R2 (I7) and O1",
      pins: [T.renameI7, T.renameO1],
    },
    {
      line: "memory.bases.delete(key);",
      writer: "W6",
      what: "rename: after a conflict the next Save is against the version read now",
      pins: [T.renameConflict],
      known:
        "O-R3-3: page memory forgets the base, the model's last copy keeps it until the next keystroke (the server's version guard backstops it)",
    },
    {
      line: "base: memory.bases.get(key) ?? household.version,",
      writer: "R",
      what: "rename: typing gives the model the base it is composed against",
      pins: [T.renameRestored],
    },
    {
      line: "memory.draft(key, event.target.value);",
      writer: "W1",
      what: "rename: typing; R1 (the model first, refused while frozen)",
      pins: [T.renameRestored, T.renameTypingFrozen],
    },
  ],
  [`${DIR}/form-recovery.ts`]: [
    {
      line: "export function retireHouseholdRecoveryExcept(identity: string | null): void {",
      writer: "D",
      what: "W9: another identity's models leave the registry",
      pins: [T.identity],
    },
    {
      line: "export function forgetHouseholdRecovery(): void {",
      writer: "D",
      what: "W10: the tests' forget",
      reason: "test support (`forgetHouseholdsMemory`)",
    },
    {
      line: "retireHouseholdRecoveryExcept(null);",
      writer: "W10",
      what: "the tests' forget",
      reason: "test support (`forgetHouseholdsMemory`)",
    },
    {
      line: "export function dropped(identity: string, key: string): void {",
      writer: "D",
      what: "page memory dropped a draft: the model's session follows",
      pins: [T.renameEscape, T.createO1],
    },
    {
      line: "retireHouseholdRecoveryExcept(memory.identity);",
      writer: "W9",
      what: "a model is made only for the current identity",
      pins: [T.identity],
    },
    {
      line: "export function useHouseholdRecovery<T>(",
      writer: "D",
      what: "overload (the form of a key)",
      reason: "a declaration",
    },
    {
      line: "export function useHouseholdRecovery<T>(",
      writer: "D",
      what: "overload (a dialog with no such form)",
      reason: "a declaration",
    },
    {
      line: "export function useHouseholdRecovery<T>(",
      writer: "D",
      what: "the hook",
      pins: [T.createTyped, T.renameRestored, T.inviteTyped],
    },
    {
      line: "submitting: () => model.submitting(),",
      writer: "T",
      what: "the ticket (null while frozen)",
      pins: [T.createFrozen, T.renameSendFrozen, T.inviteSendFrozen],
    },
    {
      line: "export function completeTicket(ticket: ModelTicket, durable: boolean): void {",
      writer: "D",
      what: "the shared completion: R3",
      pins: [T.createR3, T.renameR3, T.inviteR3],
    },
    {
      line: "if (durable) void ticket.succeeded();",
      writer: "T",
      what: "a durable success covers what was sent",
      pins: [T.createO1, T.renameO1, T.inviteO1],
    },
    {
      line: "else ticket.failed();",
      writer: "T",
      what: "anything else covers nothing (R3)",
      pins: [T.createR3, T.renameR3, T.inviteR3],
    },
  ],
  [`${DIR}/memory.ts`]: [
    {
      line: "this.drafts.delete(key);",
      writer: "P",
      what: "draft(key, null): the draft goes",
      pins: [T.createO1, T.renameO1, T.inviteO1],
    },
    {
      line: "this.bases.delete(key);",
      writer: "P",
      what: "draft(key, null): its base goes with it (R4)",
      pins: [T.renameEscapeBase],
    },
    {
      line: "dropped(this.identity, key);",
      writer: "P",
      what: "draft(key, null): the model's session follows (I-5)",
      pins: [T.renameEscape, T.createO1],
    },
    {
      line: "} else this.drafts.set(key, value);",
      writer: "P",
      what: "draft(key, text): the person's input",
      pins: [T.createTyped, T.renameRestored, T.inviteTyped],
    },
    {
      line: "if (value === null) this.drafts.delete(key);",
      writer: "P",
      what: "recovered(key, null): Discard instead's reset",
      pins: [T.createDiscard, T.renameDiscardBase],
    },
    {
      line: "else this.drafts.set(key, value);",
      writer: "P",
      what: "recovered(key, text): a restored copy",
      pins: [T.createTyped, T.renameRestored],
    },
    {
      line: "if (base === null) this.bases.delete(key);",
      writer: "P",
      what: "recovered without a base: none kept (R4)",
      pins: [T.renameDiscardBase],
    },
    {
      line: "else this.bases.set(key, base);",
      writer: "P",
      what: "recovered with a base: a restored rename keeps it",
      pins: [T.renameBase, T.renameConflict],
    },
    {
      line: "retireHouseholdRecoveryExcept(identity);",
      writer: "W9",
      what: "another identity asks: the previous identity's models leave",
      pins: [T.identity],
    },
    {
      line: "forgetHouseholdRecovery();",
      writer: "W10",
      what: "the tests' forget",
      reason: "test support",
    },
  ],
  [`${DIR}/operations.ts`]: [
    {
      line: "memory.draft(formContext.create(), null);",
      writer: "W7",
      what: "Try again completed a create: the name is forgotten (D-12b-18)",
      pins: [T.createD1],
      known: DA2,
    },
    {
      line: "memory.draft(formContext.rename(target), null);",
      writer: "W7",
      what: "Try again completed a rename: the name is forgotten (D-12b-18)",
      pins: [T.renameD1, T.renameRetryCloses],
      known: DA2,
    },
    {
      line: "memory.draft(formContext.invite(target), null);",
      writer: "W7",
      what: "Try again completed an invite: the username is forgotten (D-12b-18)",
      pins: [T.inviteD1, T.inviteRetryClears],
      known: DA2,
    },
  ],
};

/**
 * I-10, the rule-to-test map: each documented rule (`form-recovery.ts`'s header, `docs/pwa.md`) for each input it applies to. R4 is
 * Rename's alone (the only input with a base); D-1 is the Try again path as D-12b-18 is written (decision D-1 reported, not granted).
 */
const RULE_TESTS: Record<
  string,
  Record<"create" | "rename" | "invite", Pin[] | null>
> = {
  "R1 frozen: nothing sent, nothing changed": {
    create: [T.createFrozen],
    rename: [T.renameTypingFrozen, T.renameSendFrozen],
    invite: [T.inviteTypingFrozen, T.inviteSendFrozen, T.inviteChoiceFrozen],
  },
  "R2 I7: cleared only while still what was sent": {
    create: [T.createI7],
    rename: [T.renameI7],
    invite: [T.inviteI7],
  },
  "O1 a durable success with nothing typed since clears": {
    create: [T.createO1],
    rename: [T.renameO1],
    invite: [T.inviteO1],
  },
  "R3 only a durable success covers what was sent": {
    create: [T.createR3, T.createR3Refused, T.createR3Update],
    rename: [T.renameR3, T.renameR3Refused, T.renameR3Update],
    invite: [
      T.inviteR3,
      T.inviteR3Refused,
      T.inviteR3NotFound,
      T.inviteR3Update,
    ],
  },
  "R4 a rename's base lives and dies with its draft": {
    create: null,
    rename: [T.renameBase, T.renameEscapeBase, T.renameDiscardBase],
    invite: null,
  },
  "D-1 a successful Try again forgets text typed since (D-12b-18 as written)": {
    create: [T.createD1],
    rename: [T.renameD1],
    invite: [T.inviteD1],
  },
};

/** Lines of `text` with comments removed (line numbers kept). */
function code(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) =>
      "\n".repeat(block.split("\n").length - 1),
    )
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .split("\n");
}
const PATTERNS = [
  /\.draft\(/,
  /\.recovered\(/,
  /\.bases\.(get|set|delete|clear|has)\(/,
  /\.drafts\.(set|delete|clear)\(/,
  /\bcompleteTicket\(/,
  /\.submitting\(/,
  /\bticket\.(succeeded|failed)\(/,
  /\buseHouseholdRecovery\b(<[^>]*>)?\(/,
  /\bretireHouseholdRecoveryExcept\(|\bforgetHouseholdRecovery\(|\bdropped\(/,
];
/** Every matching line of `text`, trimmed, in order. */
function writerLines(text: string): string[] {
  return code(text)
    .filter((line) => PATTERNS.some((pattern) => pattern.test(line)))
    .map((line) => line.trim());
}

function sources(dir: string, out: Record<string, string> = {}) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(name))
      out[relative(ROOT, full)] = readFileSync(full, "utf8");
  }
  return out;
}
const readRepo = (path: string): string | null => {
  try {
    return readFileSync(join(ROOT, path), "utf8");
  } catch {
    return null;
  }
};
function pinProblems(
  where: string,
  pins: Pin[],
  read: (path: string) => string | null,
): string[] {
  const problems: string[] = [];
  for (const pin of pins) {
    const text = read(pin.file);
    if (text === null) problems.push(`${where}: ${pin.file} does not exist`);
    else if (!text.includes(JSON.stringify(pin.title)))
      problems.push(`${where}: no test titled "${pin.title}" in ${pin.file}`);
  }
  return problems;
}

/** Every difference between the households source `files` and the registry `sites` (empty when they agree). */
function audit(
  files: Record<string, string>,
  sites: Record<string, Site[]>,
  read: (path: string) => string | null,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    const found = writerLines(text);
    if (found.length === 0) continue;
    seen.add(file);
    const registered = sites[file];
    if (!registered) {
      problems.push(`${file}: ${found.length} unregistered writer site(s)`);
      continue;
    }
    const n = Math.max(found.length, registered.length);
    for (let i = 0; i < n; i += 1) {
      const line = found[i];
      const entry = registered[i];
      if (line === undefined)
        problems.push(`${file} #${i + 1}: registered "${entry?.line}" is gone`);
      else if (entry === undefined)
        problems.push(`${file} #${i + 1}: unregistered writer site "${line}"`);
      else if (line !== entry.line)
        problems.push(
          `${file} #${i + 1}: "${line}" where "${entry.line}" is registered`,
        );
    }
    registered.forEach((entry, i) => {
      if ((entry.pins?.length ?? 0) === 0 && entry.reason === undefined)
        problems.push(`${file} #${i + 1}: neither pinned nor given a reason`);
      problems.push(
        ...pinProblems(`${file} #${i + 1}`, entry.pins ?? [], read),
      );
    });
  }
  for (const file of Object.keys(sites))
    if (!seen.has(file))
      problems.push(`${file}: registered, but has no writer site`);
  return problems;
}

describe("WEB-12b revision 2 (F-R3-1; I-9, I-10): the household drafts' writers and the rule-to-test map", () => {
  const files = sources(join(ROOT, DIR));

  test("the registry and the source agree: every writer of drafts, bases and tickets is classified and pinned", () => {
    expect(audit(files, SITES, readRepo)).toEqual([]);
    expect(Object.values(SITES).flat()).toHaveLength(57);
  });

  test("three inputs, and only three, have a recovery model (a fourth input fails here until classified)", () => {
    const callers = Object.entries(files).flatMap(([file, text]) =>
      writerLines(text)
        .filter((line) => /=\s*useHouseholdRecovery\b/.test(line))
        .map(() => file),
    );
    expect(callers.sort()).toEqual([
      `${DIR}/InvitationsDialog.tsx`,
      `${DIR}/NameDialogs.tsx`,
      `${DIR}/NameDialogs.tsx`,
    ]);
  });

  test("the rule-to-test map: every documented rule names an existing test per input it applies to", () => {
    const problems = Object.entries(RULE_TESTS).flatMap(([rule, inputs]) =>
      Object.entries(inputs).flatMap(([input, pins]) =>
        pins === null
          ? []
          : pins.length === 0
            ? [`${rule} / ${input}: no test`]
            : pinProblems(`${rule} / ${input}`, pins, readRepo),
      ),
    );
    expect(problems).toEqual([]);
  });

  test("the known asymmetries are listed with their decision or observation", () => {
    const known = Object.values(SITES)
      .flat()
      .filter((site) => site.known !== undefined)
      .map((site) => `${site.writer} ${site.line}`);
    expect(known).toEqual([
      "W8 onDiscard={() => memory.draft(key, null)}",
      "W6 memory.bases.delete(key);",
      "W7 memory.draft(formContext.create(), null);",
      "W7 memory.draft(formContext.rename(target), null);",
      "W7 memory.draft(formContext.invite(target), null);",
    ]);
  });

  test("NEGATIVE: a new writer (a stray drop of a draft), unregistered, fails", () => {
    const file = `${DIR}/HouseholdDetail.tsx`;
    const extra = {
      ...files,
      [file]: `${files[file] ?? ""}\nconst x = () => memory.draft(key, null);\n`,
    };
    expect(audit(extra, SITES, readRepo)).toEqual([
      `${file}: 1 unregistered writer site(s)`,
    ]);
    const name = `${DIR}/NameDialogs.tsx`;
    const added = {
      ...files,
      [name]: `${files[name] ?? ""}\n  memory.bases.set(key, 1);\n`,
    };
    expect(audit(added, SITES, readRepo)).toEqual([
      `${name} #20: unregistered writer site "memory.bases.set(key, 1);"`,
    ]);
  });

  test("NEGATIVE: a writer gone (Invite's I7 clear removed), or a pinned test renamed, fails", () => {
    const file = `${DIR}/InvitationsDialog.tsx`;
    const removed = {
      ...files,
      [file]: (files[file] ?? "").replace(
        "if (ok && unchanged) memory.draft(draftKey, null);",
        "",
      ),
    };
    expect(audit(removed, SITES, readRepo)[0]).toBe(
      `${file} #11: "memory.draft(draftKey, event.target.value);" where "if (ok && unchanged) memory.draft(draftKey, null);" is registered`,
    );
    const renamed = (path: string) => {
      const text = readRepo(path);
      return path === RULES && text !== null
        ? text.replace("R2 Invite I7:", "R2 Invite:")
        : text;
    };
    expect(audit(files, SITES, renamed)).toEqual([
      `${file} #11: no test titled "${T.inviteI7.title}" in ${RULES}`,
    ]);
  });
});
