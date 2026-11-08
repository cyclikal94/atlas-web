// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { UNIT } from "../../scripts/mutation/data-catalogue.mjs";

/**
 * WEB-12b revision 2 (Review 3 F-R3-1) and revision 3 (Review 4 F-R4-1; finding family `m1-household-submission-rules-without-sensitive-tests`;
 * second design assessment of 7 November 2026, Branch B′, invariants I-9′, I-10′, I-11, I-12): the household drafts' WRITERS, their
 * decision EXITS and the CELLS of M-1's submission rules, each tied to the catalogued unit mutant that proves it. Each household input
 * has two authorities that must move in one step (page memory and its WEB-14a recoverable model, `households/form-recovery.ts`), kept by
 * hand at each call site.
 *
 *  - SITES (I-9′): every line that writes page memory's drafts or bases, completes a ticket or wires an input to its model, in source
 *    order. A rule-bearing site names the catalogued mutants that CHANGE ITS LINE and the tests they prove (`pins`): this test applies
 *    each mutant's patch to the source and checks that the registered line is among those it changes, that its `tests` hold the pinned
 *    file and that its `expect` names a pinned test, and that every pin is named by one of the site's mutants. A site with no mutant
 *    gives a reason from a closed set (`REASONS`).
 *  - EXITS (I-9′): every `return`, `case`, `default`, `else` and single-line `if (…) void …` arm of the functions that choose a writer's
 *    argument or branch (`run`, `sendAttempt`, `retry`, `invite`, `dropped`, `completeTicket`), each tied to the cells that pin the
 *    outcome it chooses, or given a reason.
 *  - CELLS (I-10′, I-11): rule × input × answer class or path. A cell names its test (a title in the rules, recovery, owner or page
 *    suites, or a title in `households-submission-cells.test.tsx` that BEGINS with the cell id) and the catalogued mutants whose `expect`
 *    names it; a mutant of one input's cell must not name another input's cell of the same rule (the cross-site rule, made static).
 *
 * What this test does NOT prove: that a named test fails when its mutant is applied. That is the qualification run (`qmut`: every
 * mutant here, applied whole with its control by `scripts/run-data-mutants.mjs`); a title here is the naming check only (Review 4 N6).
 * Known asymmetries are listed (`known`), not hidden: O-R3-3, DA-2 (latent; with D-1's follow-up card) and N-1 (decision D-2 open).
 * Decision D-1 is decided (Kieran, 7 November 2026, WEB12B-D1-ANSWER-20261107): a successful Try again forgets text typed since, as
 * D-12b-18 is written; its cells pin that. Mirrored as tables in `docs/pwa.md` ("WEB-12b's household dialogs").
 * Not pinned, deferred to a follow-up card (Review 5 F-R5-1 and F-R5-2; Kieran's decision WEB12B-R5-FINDINGS-TO-FOLLOW-UP-20261107):
 * that a durable success FINISHES its ticket (the cells tied to `completeTicket`'s durable arm check the draft, not the ticket, so an
 * accepted update's wait on it is untested), the per-household draft keys, the codecs' version gate, base integrity and length
 * boundaries, and R8's `sent` flag after a held-back Try again. Listed in `docs/pwa.md`; a tie here does not claim them.
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
/** The rule-bearing writers: each needs a mutant that changes its line, or a reason. */
const RULE_BEARING: readonly Writer[] = [
  "W1",
  "W2",
  "W3",
  "W4",
  "W5",
  "W6",
  "W7",
  "W8",
  "W9",
  "P",
  "T",
  "R",
];
/** The closed set of reasons a site or exit may have no mutant or cell (the assessment's I-10′). */
const REASONS = [
  "declaration",
  "presentation key",
  "test support",
  "equivalent",
  "unreachable",
  "no UI path",
  "race",
] as const;
/** The reasons that excuse a RULE-BEARING site: an argument, not a category. */
const ARGUED: readonly (typeof REASONS)[number][] = [
  "equivalent",
  "unreachable",
  "no UI path",
  "race",
];
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
  /** Catalogued unit mutants whose patch changes this line. */
  mutants?: string[];
  /** The tests those mutants prove (each named by one of them). */
  pins?: Pin[];
  /** `<one of REASONS>: why`, when no mutant changes it. */
  reason?: string;
  /** A known asymmetry, with its decision or observation id. */
  known?: string;
}
interface Exit {
  line: string;
  /** The cells that pin the outcome this exit chooses. */
  cells?: string[];
  reason?: string;
}
type Input = "create" | "rename" | "invite";
interface Cell {
  input: Input;
  test: Pin;
  /** Catalogued unit mutants whose `expect` names this cell's test. */
  mutants?: string[];
  /** The positive control of the named cell (a cell no defect is meant to break). */
  control?: string;
  known?: string;
}

const RULES = "tests/features/sharing/households-submission-rules.test.tsx";
const CELLS_FILE =
  "tests/features/sharing/households-submission-cells.test.tsx";
const RECOVERY = "tests/features/sharing/households-recovery.test.tsx";
const OWNER_DISCARD = "tests/features/recovery-owner-discard.test.tsx";
const INVITATIONS = "tests/features/sharing/households-invitations.test.tsx";
const PAGE = "tests/features/sharing/households-page.test.tsx";
const rules = (title: string): Pin => ({ file: RULES, title });
const recovery = (title: string): Pin => ({ file: RECOVERY, title });

const readRepo = (path: string): string | null => {
  try {
    return readFileSync(join(ROOT, path), "utf8");
  } catch {
    return null;
  }
};
const cellsText = readRepo(CELLS_FILE) ?? "";
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A cell of the cells file, by id: its title is the one that begins with `<id>:` (found in the file, so it is not written twice). */
function cell(id: string): Pin {
  const found = [
    ...cellsText.matchAll(
      new RegExp(`test\\(\\s*"(${escapeRegExp(id)}:[^"]*)"`, "g"),
    ),
  ];
  return {
    file: CELLS_FILE,
    title:
      found.length === 1 ? (found[0]?.[1] ?? "") : `${id}: (not found once)`,
  };
}

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
  createDiscardControl: {
    file: OWNER_DISCARD,
    title:
      "CONTROL create: with no newer input the discard clears the name and removes its copy",
  },
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
  renameRetryForgets: {
    file: PAGE,
    title:
      "MU-6238: a Try again pressed on the detail for a lost rename forgets the typed name, so Rename opens on the household's own name",
  },
  inviteTyped: recovery(
    "M-1 Invite: the username typed in the household's Invitations is saved by the accepted update and restored after the reload; nothing is looked up or sent",
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

/**
 * The CELLS (I-10′, I-11). Ids: `<rule>.<input>.<class or path>`. The 26 rules-suite cases and the older suites' cases keep their titles
 * (they are the `expect` patterns of MU-6239..MU-6268) and are registered here by title; revision 3's cells are titled by their id.
 */
const CELLS: Record<string, Cell> = {
  "R1.create.frozen": {
    input: "create",
    test: T.createFrozen,
    mutants: ["MU-6240", "MU-6241"],
  },
  "R1.rename.typing-frozen": {
    input: "rename",
    test: T.renameTypingFrozen,
    mutants: ["MU-6254", "MU-6295"],
  },
  "R1.rename.send-frozen": {
    input: "rename",
    test: T.renameSendFrozen,
    mutants: ["MU-6252", "MU-6292"],
  },
  "R1.invite.typing-frozen": {
    input: "invite",
    test: T.inviteTypingFrozen,
    mutants: ["MU-6255", "MU-6285", "MU-6295"],
  },
  "R1.invite.send-frozen": {
    input: "invite",
    test: T.inviteSendFrozen,
    mutants: ["MU-6253", "MU-6292"],
  },
  "R1.invite.choice-frozen": {
    input: "invite",
    test: T.inviteChoiceFrozen,
    mutants: ["MU-6256"],
  },
  "R2.create.i7": { input: "create", test: T.createI7, mutants: ["MU-6242"] },
  "R2.rename.i7": { input: "rename", test: T.renameI7, mutants: ["MU-6257"] },
  "R2.invite.i7": { input: "invite", test: T.inviteI7, mutants: ["MU-6258"] },
  "O1.create": { input: "create", test: T.createO1, mutants: ["MU-6293"] },
  "O1.rename": {
    input: "rename",
    test: T.renameO1,
    mutants: ["MU-6259", "MU-6293"],
  },
  "O1.invite": { input: "invite", test: T.inviteO1, mutants: ["MU-6293"] },
  "R3.create.uncertain": {
    input: "create",
    test: T.createR3,
    mutants: ["MU-6260", "MU-6261", "MU-6307"],
  },
  "R3.create.refused": {
    input: "create",
    test: T.createR3Refused,
    mutants: ["MU-6260", "MU-6261", "MU-6308"],
  },
  "R3.create.uncertain-then-update": {
    input: "create",
    test: T.createR3Update,
    mutants: ["MU-6260", "MU-6261", "MU-6307"],
  },
  "R3.create.closed": {
    input: "create",
    test: cell("R3.create.closed"),
    mutants: ["MU-6276"],
  },
  "R3.create.offline": {
    input: "create",
    test: cell("R3.create.offline"),
    mutants: ["MU-6309"],
  },
  "R3.create.not-sent": {
    input: "create",
    test: cell("R3.create.not-sent"),
    mutants: ["MU-6310"],
  },
  "R3.rename.uncertain": {
    input: "rename",
    test: T.renameR3,
    mutants: ["MU-6260", "MU-6262", "MU-6311"],
  },
  "R3.rename.refused": {
    input: "rename",
    test: T.renameR3Refused,
    mutants: ["MU-6260", "MU-6262", "MU-6312"],
  },
  "R3.rename.uncertain-then-update": {
    input: "rename",
    test: T.renameR3Update,
    mutants: ["MU-6260", "MU-6262", "MU-6311"],
  },
  "R3.rename.closed": {
    input: "rename",
    test: cell("R3.rename.closed"),
    mutants: ["MU-6277"],
  },
  "R3.rename.offline": {
    input: "rename",
    test: cell("R3.rename.offline"),
    mutants: ["MU-6313"],
  },
  "R3.rename.not-sent": {
    input: "rename",
    test: cell("R3.rename.not-sent"),
    mutants: ["MU-6314"],
  },
  "R3.invite.uncertain": {
    input: "invite",
    test: T.inviteR3,
    mutants: ["MU-6260", "MU-6263", "MU-6315"],
  },
  "R3.invite.refused": {
    input: "invite",
    test: T.inviteR3Refused,
    mutants: ["MU-6260", "MU-6263", "MU-6316"],
  },
  "R3.invite.uncertain-then-update": {
    input: "invite",
    test: T.inviteR3Update,
    mutants: ["MU-6260", "MU-6263", "MU-6315"],
  },
  "R3.invite.closed": {
    input: "invite",
    test: cell("R3.invite.closed"),
    mutants: ["MU-6278"],
  },
  "R3.invite.offline": {
    input: "invite",
    test: cell("R3.invite.offline"),
    mutants: ["MU-6317"],
  },
  "R3.invite.not-sent": {
    input: "invite",
    test: cell("R3.invite.not-sent"),
    mutants: ["MU-6318"],
  },
  "R3.invite.not-found": {
    input: "invite",
    test: T.inviteR3NotFound,
    mutants: ["MU-6260", "MU-6263"],
  },
  "R3.invite.lookup-failed": {
    input: "invite",
    test: cell("R3.invite.lookup-failed"),
    mutants: ["MU-6269"],
  },
  "R3.invite.self": {
    input: "invite",
    test: cell("R3.invite.self"),
    mutants: ["MU-6270"],
  },
  "R4.rename.restored-control": {
    input: "rename",
    test: T.renameBase,
    mutants: ["MU-6288", "MU-6291", "MU-6297", "MU-6298"],
  },
  "R4.rename.escape": {
    input: "rename",
    test: T.renameEscapeBase,
    mutants: ["MU-6264", "MU-6290"],
  },
  "R4.rename.discard-instead": {
    input: "rename",
    test: T.renameDiscardBase,
    mutants: ["MU-6265", "MU-6289"],
  },
  "R4.rename.first-try-conflict": {
    input: "rename",
    test: T.renameConflict,
    mutants: ["MU-6243", "MU-6244"],
  },
  "R4.rename.typed-control": {
    input: "rename",
    test: cell("R4.rename.typed-control"),
    control: "R4.rename.typed-after-restore",
  },
  "R4.rename.typed-after-restore": {
    input: "rename",
    test: cell("R4.rename.typed-after-restore"),
    mutants: ["MU-6271"],
  },
  "R4.rename.typed-after-restore-reopened": {
    input: "rename",
    test: cell("R4.rename.typed-after-restore-reopened"),
    mutants: ["MU-6271"],
  },
  "R4.rename.keep-on-refusal": {
    input: "rename",
    test: cell("R4.rename.keep-on-refusal"),
    mutants: ["MU-6279"],
  },
  "R4.rename.retry-conflict-keeps-stale-base": {
    input: "rename",
    test: cell("R4.rename.retry-conflict-keeps-stale-base"),
    mutants: ["MU-6282"],
    known:
      "N-1 (second design assessment, class new, low): retry() has no writer that forgets a restored base on a conflict; decision D-2 (fix or defer) is open, so the cell pins the product as it is",
  },
  "W1.create.typed": {
    input: "create",
    test: T.createTyped,
    mutants: ["MU-6240", "MU-6286"],
  },
  "W2.invite.choice-from-empty-field": {
    input: "invite",
    test: cell("W2.invite.choice-from-empty-field"),
    mutants: ["MU-6274", "MU-6284"],
  },
  "W3.invite.restored": {
    input: "invite",
    test: T.inviteTyped,
    mutants: ["MU-6283"],
  },
  "W4.create.discard-instead": {
    input: "create",
    test: T.createDiscardControl,
    mutants: ["MU-6287"],
  },
  "W4.invite.discard-instead": {
    input: "invite",
    test: cell("W4.invite.discard-instead"),
    mutants: ["MU-6272", "MU-6296"],
  },
  "D.rename.non-manager-not-bound": {
    input: "rename",
    test: cell("D.rename.non-manager-not-bound"),
    mutants: ["MU-6275"],
  },
  "D.invite.non-manager-not-bound": {
    input: "invite",
    test: cell("D.invite.non-manager-not-bound"),
    mutants: ["MU-6332"],
  },
  "W7.create.page-after-cancel": {
    input: "create",
    test: cell("W7.create.page-after-cancel"),
    mutants: ["MU-6273", "MU-6294"],
  },
  "W7.rename.page-after-cancel": {
    input: "rename",
    test: cell("W7.rename.page-after-cancel"),
    mutants: ["MU-6273", "MU-6294", "MU-6331"],
  },
  "W7.invite.page-after-close": {
    input: "invite",
    test: cell("W7.invite.page-after-close"),
    mutants: ["MU-6273", "MU-6294"],
  },
  "W7.create.refused-completes-nothing": {
    input: "create",
    test: cell("W7.create.refused-completes-nothing"),
    mutants: ["MU-6281"],
  },
  "W7.rename.refused-completes-nothing": {
    input: "rename",
    test: cell("W7.rename.refused-completes-nothing"),
    mutants: ["MU-6281"],
  },
  "W7.invite.refused-completes-nothing": {
    input: "invite",
    test: cell("W7.invite.refused-completes-nothing"),
    mutants: ["MU-6281"],
  },
  "W7.create.try-again-not-sent": {
    input: "create",
    test: cell("W7.create.try-again-not-sent"),
    mutants: ["MU-6281"],
  },
  "W7.invite.retried-in-rename-dialog": {
    input: "invite",
    test: cell("W7.invite.retried-in-rename-dialog"),
    mutants: ["MU-6280"],
  },
  "W7.rename.own-dialog-closes": {
    input: "rename",
    test: T.renameRetryCloses,
    mutants: ["MU-6233"],
  },
  "W7.rename.detail-forgets": {
    input: "rename",
    test: T.renameRetryForgets,
    mutants: ["MU-6238"],
  },
  "W7.invite.clears": {
    input: "invite",
    test: T.inviteRetryClears,
    mutants: ["MU-6232"],
  },
  "W8.rename.escape-ends-session": {
    input: "rename",
    test: T.renameEscape,
    mutants: ["MU-6247", "MU-6294", "MU-6299"],
  },
  "W9.rename.another-identity": {
    input: "rename",
    test: T.identity,
    mutants: ["MU-6248"],
  },
  "R3.create.refused-other-kinds": {
    input: "create",
    test: cell("R3.create.refused-other-kinds"),
    mutants: ["MU-6319"],
  },
  "R3.rename.refused-other-kinds": {
    input: "rename",
    test: cell("R3.rename.refused-other-kinds"),
    mutants: ["MU-6320"],
  },
  "R3.invite.refused-other-kinds": {
    input: "invite",
    test: cell("R3.invite.refused-other-kinds"),
    mutants: ["MU-6321"],
  },
  "G.create.refused-press": {
    input: "create",
    test: cell("G.create.refused-press"),
    mutants: ["MU-6322"],
  },
  "G.rename.refused-press": {
    input: "rename",
    test: cell("G.rename.refused-press"),
    mutants: ["MU-6323"],
  },
  "G.invite.empty-press": {
    input: "invite",
    test: cell("G.invite.empty-press"),
    mutants: ["MU-6324"],
  },
  "R4.rename.keep-when-not-sent": {
    input: "rename",
    test: cell("R4.rename.keep-when-not-sent"),
    mutants: ["MU-6325"],
  },
  "W7.create.try-again-other-answers": {
    input: "create",
    test: cell("W7.create.try-again-other-answers"),
    mutants: ["MU-6326"],
  },
  "W7.invite.detail-action-keeps-draft": {
    input: "invite",
    test: cell("W7.invite.detail-action-keeps-draft"),
    mutants: ["MU-6327"],
  },
  "O1.invite.typed-after-success": {
    input: "invite",
    test: cell("O1.invite.typed-after-success"),
    mutants: ["MU-6328"],
  },
  "W1.rename.typed-back-to-start": {
    input: "rename",
    test: cell("W1.rename.typed-back-to-start"),
    mutants: ["MU-6329"],
  },
  "W1.rename.reopened-after-rename-elsewhere": {
    input: "rename",
    test: cell("W1.rename.reopened-after-rename-elsewhere"),
    mutants: ["MU-6330"],
  },
  "D-1.create": { input: "create", test: T.createD1, mutants: ["MU-6266"] },
  "D-1.rename": { input: "rename", test: T.renameD1, mutants: ["MU-6267"] },
  "D-1.invite": { input: "invite", test: T.inviteD1, mutants: ["MU-6268"] },
};

const DA2 =
  "DA-2 (latent; with decision D-1's follow-up card, WEB12B-D1-ANSWER-20261107): drops page memory without asking the registry's freeze; the model refuses its discard while frozen, so the two authorities split until the next edit. No product path: the dialogs are modal and the update banner inert (O-R3-4)";
const pins = (...ids: string[]): Pin[] =>
  ids.map((id) => CELLS[id]?.test ?? { file: "(no cell)", title: id });

/** The SITES (I-9′): per file, every matching line in source order. */
const SITES: Record<string, Site[]> = {
  [`${DIR}/InvitationsDialog.tsx`]: [
    {
      line: "const recovery = useHouseholdRecovery({",
      writer: "D",
      what: "the invitation's username: its model",
      reason:
        "declaration: the model's wiring; what it does is the W1..W7 sites below",
    },
    {
      line: "if (draftKey !== null) memory.recovered(draftKey, value);",
      writer: "W3",
      what: "invite: a restored copy into an untouched field",
      mutants: ["MU-6283"],
      pins: pins("W3.invite.restored"),
    },
    {
      line: "if (draftKey !== null) memory.recovered(draftKey, null);",
      writer: "W4",
      what: "invite: Discard instead (admitted at the gesture, frozen refuses)",
      mutants: ["MU-6272"],
      pins: pins("W4.invite.discard-instead"),
    },
    {
      line: "memory.draft(draftKey, entry.username);",
      writer: "W2",
      what: "invite: the account chosen; R1 (the model first, refused while frozen)",
      mutants: ["MU-6284"],
      pins: pins("W2.invite.choice-from-empty-field"),
    },
    {
      line: "memory.draft(lookupKey, null);",
      writer: "W11",
      what: "the lookup view closes",
      reason: "presentation key: never recovered (D-12b-15)",
    },
    {
      line: "onBack={() => memory.draft(lookupKey, null)}",
      writer: "W11",
      what: "the lookup view closes",
      reason: "presentation key: never recovered (D-12b-15)",
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
        "presentation key: never recovered (D-12b-15); pinned natively by E-HH9 (MU-6302)",
    },
    {
      line: "onDiscard={() => memory.draft(lookupKey, null)}",
      writer: "W11",
      what: "Escape closes the lookup view (the username draft stays)",
      reason: "presentation key: never recovered (D-12b-15)",
    },
    {
      line: "const ticket = recovery?.submitting() ?? null;",
      writer: "T",
      what: "invite: the ticket, in the step of what it sends; R1 (none while frozen: nothing looked up or sent)",
      mutants: ["MU-6253"],
      pins: pins("R1.invite.send-frozen"),
    },
    {
      line: "completeTicket(ticket, ok);",
      writer: "W6",
      what: "invite: R3, only a durable success covers what was sent",
      mutants: ["MU-6263"],
      pins: pins(
        "R3.invite.uncertain",
        "R3.invite.refused",
        "R3.invite.not-found",
        "R3.invite.uncertain-then-update",
      ),
    },
    {
      line: "if (ok && unchanged) memory.draft(draftKey, null);",
      writer: "W5",
      what: "invite: R2 (I7) and O1",
      mutants: ["MU-6258"],
      pins: pins("R2.invite.i7"),
    },
    {
      line: "memory.draft(draftKey, event.target.value);",
      writer: "W1",
      what: "invite: typing; R1 (the model first, refused while frozen)",
      mutants: ["MU-6285"],
      pins: pins("R1.invite.typing-frozen"),
    },
    {
      line: 'onClick={() => memory.draft(lookupKey, "open")}',
      writer: "W11",
      what: "Find an account opens the lookup view",
      reason: "presentation key: never recovered (D-12b-15)",
    },
  ],
  [`${DIR}/NameDialogs.tsx`]: [
    {
      line: "const recovery = useHouseholdRecovery({",
      writer: "D",
      what: "New household's name: its model",
      reason:
        "declaration: the model's wiring; what it does is the sites below",
    },
    {
      line: "restored: (value) => memory.recovered(key, value),",
      writer: "W3",
      what: "create: a restored copy into an untouched dialog",
      mutants: ["MU-6286"],
      pins: pins("W1.create.typed"),
    },
    {
      line: "reset: () => memory.recovered(key, null),",
      writer: "W4",
      what: "create: Discard instead",
      mutants: ["MU-6287"],
      pins: pins("W4.create.discard-instead"),
    },
    {
      line: "const ticket = recovery.submitting();",
      writer: "T",
      what: "create: the ticket; R1 (none while frozen: nothing sent)",
      mutants: ["MU-6241"],
      pins: pins("R1.create.frozen"),
    },
    {
      line: "completeTicket(ticket, result?.ok === true);",
      writer: "W6",
      what: "create: R3, only a durable success covers what was sent (one mutant per answer class)",
      mutants: [
        "MU-6261",
        "MU-6276",
        "MU-6307",
        "MU-6308",
        "MU-6309",
        "MU-6310",
        "MU-6319",
      ],
      pins: pins(
        "R3.create.uncertain",
        "R3.create.refused",
        "R3.create.uncertain-then-update",
        "R3.create.closed",
        "R3.create.offline",
        "R3.create.not-sent",
        "R3.create.refused-other-kinds",
      ),
    },
    {
      line: "if (unchanged) memory.draft(key, null);",
      writer: "W5",
      what: "create: R2 (I7) and O1",
      mutants: ["MU-6242"],
      pins: pins("R2.create.i7"),
    },
    {
      line: "memory.draft(key, event.target.value);",
      writer: "W1",
      what: "create: typing; R1 (the model first, refused while frozen)",
      mutants: ["MU-6240"],
      pins: pins("W1.create.typed", "R1.create.frozen"),
    },
    {
      line: "const recovery = useHouseholdRecovery<RenameInput>({",
      writer: "D",
      what: "Rename's name and base: its model",
      reason:
        "declaration: the model's wiring; its binding for a manager only is cell D.rename.non-manager-not-bound (MU-6275)",
    },
    {
      line: "base: memory.bases.get(key) ?? household?.version ?? null,",
      writer: "R",
      what: "rename: the model's value() carries the base the draft was composed against",
      reason:
        "unreachable: value() is read only when a session BEGINS over a draft page memory already keeps; Rename's session is not ended while its draft is kept (only `leaving`, when nothing is kept, ends it), so no schedule begins one over a kept rename draft (Review 4 RN-32: no schedule found)",
    },
    {
      line: "restored: (value) => memory.recovered(key, value.text, value.base),",
      writer: "W3",
      what: "rename: a restored copy WITH its base",
      mutants: ["MU-6288"],
      pins: pins("R4.rename.restored-control"),
    },
    {
      line: "reset: () => memory.recovered(key, null),",
      writer: "W4",
      what: "rename: Discard instead; R4 (the base goes with the draft)",
      mutants: ["MU-6289"],
      pins: pins("R4.rename.discard-instead"),
    },
    {
      line: "onDiscard={() => memory.draft(key, null)}",
      writer: "W8",
      what: "rename: Escape drops the draft and its base (R4)",
      mutants: ["MU-6290"],
      pins: pins("R4.rename.escape"),
      known: DA2,
    },
    {
      line: "const base = memory.bases.get(key);",
      writer: "R",
      what: "rename: Save name is guarded by a restored rename's base",
      mutants: ["MU-6291"],
      pins: pins("R4.rename.restored-control"),
    },
    {
      line: "const ticket = recovery.submitting();",
      writer: "T",
      what: "rename: the ticket; R1 (none while frozen: nothing sent)",
      mutants: ["MU-6252"],
      pins: pins("R1.rename.send-frozen"),
    },
    {
      line: "completeTicket(ticket, result?.ok === true);",
      writer: "W6",
      what: "rename: R3, only a durable success covers what was sent (one mutant per answer class)",
      mutants: [
        "MU-6262",
        "MU-6277",
        "MU-6311",
        "MU-6312",
        "MU-6313",
        "MU-6314",
        "MU-6320",
      ],
      pins: pins(
        "R3.rename.uncertain",
        "R3.rename.refused",
        "R3.rename.uncertain-then-update",
        "R3.rename.closed",
        "R3.rename.offline",
        "R3.rename.not-sent",
        "R3.rename.refused-other-kinds",
      ),
    },
    {
      line: "if (unchanged) memory.draft(key, null);",
      writer: "W5",
      what: "rename: R2 (I7) and O1",
      mutants: ["MU-6257", "MU-6259"],
      pins: pins("R2.rename.i7", "O1.rename"),
    },
    {
      line: "memory.bases.delete(key);",
      writer: "W6",
      what: "rename: after a first-try conflict the next Save is against the version read now",
      mutants: ["MU-6244"],
      pins: pins("R4.rename.first-try-conflict"),
      known:
        "O-R3-3: page memory forgets the base, the model's last copy keeps it until the next keystroke (the server's version guard backstops it); N-1: retry() has no such writer (decision D-2 open)",
    },
    {
      line: "base: memory.bases.get(key) ?? household.version,",
      writer: "R",
      what: "rename: typing gives the model the base it is composed against (a restored rename's, through further typing)",
      mutants: ["MU-6254", "MU-6271"],
      pins: pins(
        "R1.rename.typing-frozen",
        "R4.rename.typed-after-restore",
        "R4.rename.typed-after-restore-reopened",
      ),
    },
    {
      line: "memory.draft(key, event.target.value);",
      writer: "W1",
      what: "rename: typing; R1 (the model first, refused while frozen)",
      mutants: ["MU-6254"],
      pins: pins("R1.rename.typing-frozen"),
    },
  ],
  [`${DIR}/form-recovery.ts`]: [
    {
      line: "export function retireHouseholdRecoveryExcept(identity: string | null): void {",
      writer: "D",
      what: "W9: another identity's models leave the registry",
      reason: "declaration: its callers are the W9 sites",
    },
    {
      line: "export function forgetHouseholdRecovery(): void {",
      writer: "D",
      what: "W10: the tests' forget",
      reason: "test support: `forgetHouseholdsMemory`",
    },
    {
      line: "retireHouseholdRecoveryExcept(null);",
      writer: "W10",
      what: "the tests' forget",
      reason: "test support: `forgetHouseholdsMemory`",
    },
    {
      line: "export function dropped(identity: string, key: string): void {",
      writer: "D",
      what: "page memory dropped a draft: the model's session follows",
      reason: "declaration: its branches are EXITS (below)",
    },
    {
      line: "retireHouseholdRecoveryExcept(memory.identity);",
      writer: "W9",
      what: "a model is made only for the current identity",
      reason:
        "equivalent: `householdsMemory()` retires every other identity's models before any `link()` for the new identity can run (its own site, memory.ts, is MU-6248; Review 4 RX-06 survives for this reason)",
    },
    {
      line: "export function useHouseholdRecovery<T>(",
      writer: "D",
      what: "overload (the form of a key)",
      reason: "declaration: an overload",
    },
    {
      line: "export function useHouseholdRecovery<T>(",
      writer: "D",
      what: "overload (a dialog with no such form)",
      reason: "declaration: an overload",
    },
    {
      line: "export function useHouseholdRecovery<T>(",
      writer: "D",
      what: "the hook",
      reason:
        "declaration: what it does is its writers (T below, the dialogs' sites) and cells W2/W7/W8",
    },
    {
      line: "submitting: () => model.submitting(),",
      writer: "T",
      what: "the ticket (null while frozen)",
      mutants: ["MU-6292"],
      pins: pins("R1.rename.send-frozen", "R1.invite.send-frozen"),
    },
    {
      line: "export function completeTicket(ticket: ModelTicket, durable: boolean): void {",
      writer: "D",
      what: "the shared completion: R3",
      reason: "declaration: its arms are EXITS (below)",
    },
    {
      line: "if (durable) void ticket.succeeded();",
      writer: "T",
      what: "a durable success covers what was sent",
      mutants: ["MU-6260"],
      pins: pins(
        "R3.create.uncertain",
        "R3.rename.uncertain",
        "R3.invite.uncertain",
      ),
    },
    {
      line: "else ticket.failed();",
      writer: "T",
      what: "anything else covers nothing (R3)",
      mutants: ["MU-6260"],
      pins: pins(
        "R3.create.uncertain",
        "R3.rename.uncertain",
        "R3.invite.uncertain",
      ),
    },
  ],
  [`${DIR}/memory.ts`]: [
    {
      line: "this.drafts.delete(key);",
      writer: "P",
      what: "draft(key, null): the draft goes",
      mutants: ["MU-6293"],
      pins: pins("O1.create", "O1.rename", "O1.invite"),
    },
    {
      line: "this.bases.delete(key);",
      writer: "P",
      what: "draft(key, null): its base goes with it (R4)",
      mutants: ["MU-6264"],
      pins: pins("R4.rename.escape"),
    },
    {
      line: "dropped(this.identity, key);",
      writer: "P",
      what: "draft(key, null): the model's session follows (I-5)",
      mutants: ["MU-6294"],
      pins: pins(
        "W7.create.page-after-cancel",
        "W7.rename.page-after-cancel",
        "W7.invite.page-after-close",
        "W8.rename.escape-ends-session",
      ),
    },
    {
      line: "} else this.drafts.set(key, value);",
      writer: "P",
      what: "draft(key, text): the person's input",
      mutants: ["MU-6295"],
      pins: pins("R1.rename.typing-frozen", "R1.invite.typing-frozen"),
    },
    {
      line: "if (value === null) this.drafts.delete(key);",
      writer: "P",
      what: "recovered(key, null): Discard instead's reset",
      mutants: ["MU-6296"],
      pins: pins("W4.invite.discard-instead"),
    },
    {
      line: "else this.drafts.set(key, value);",
      writer: "P",
      what: "recovered(key, text): a restored copy",
      mutants: ["MU-6297"],
      pins: pins("R4.rename.restored-control"),
    },
    {
      line: "if (base === null) this.bases.delete(key);",
      writer: "P",
      what: "recovered without a base: none kept (R4)",
      mutants: ["MU-6265"],
      pins: pins("R4.rename.discard-instead"),
    },
    {
      line: "else this.bases.set(key, base);",
      writer: "P",
      what: "recovered with a base: a restored rename keeps it",
      mutants: ["MU-6298"],
      pins: pins("R4.rename.restored-control"),
    },
    {
      line: "retireHouseholdRecoveryExcept(identity);",
      writer: "W9",
      what: "another identity asks: the previous identity's models leave",
      mutants: ["MU-6248"],
      pins: pins("W9.rename.another-identity"),
    },
    {
      line: "forgetHouseholdRecovery();",
      writer: "W10",
      what: "the tests' forget",
      reason: "test support: `forgetHouseholdsMemory`",
    },
  ],
  [`${DIR}/operations.ts`]: [
    {
      line: "memory.draft(formContext.create(), null);",
      writer: "W7",
      what: "Try again completed a create: the name is forgotten (D-12b-18, decision D-1)",
      mutants: ["MU-6266"],
      pins: pins("D-1.create"),
      known: DA2,
    },
    {
      line: "memory.draft(formContext.rename(target), null);",
      writer: "W7",
      what: "Try again completed a rename: the name is forgotten (D-12b-18, decision D-1)",
      mutants: ["MU-6238"],
      pins: pins("W7.rename.detail-forgets"),
      known: DA2,
    },
    {
      line: "memory.draft(formContext.invite(target), null);",
      writer: "W7",
      what: "Try again completed an invite: the username is forgotten (D-12b-18, decision D-1)",
      mutants: ["MU-6232"],
      pins: pins("W7.invite.clears"),
      known: DA2,
    },
  ],
};

const FIRST_TRY = (input: Input) =>
  [`R3.${input}.uncertain`, `R3.${input}.refused`, `O1.${input}`] as const;
/** The EXITS (I-9′): per file and function, every arm in source order (comments removed, trimmed). */
const EXITS: Record<string, Record<string, Exit[]>> = {
  [`${DIR}/operations.ts`]: {
    run: [
      {
        line: "if (token === null) return null;",
        reason:
          "no UI path: Create and Save name are disabled while `blockedReason` holds, which is the `refusal` admit asks; a null answer completes the ticket as not durable (Review 4 O-R4-3, RN-03/RN-04)",
      },
      {
        line: "return sendAttempt(ctx, token, nextAttempt(null, [command], ctx.newId), meta);",
        cells: [...FIRST_TRY("create"), ...FIRST_TRY("rename")],
      },
    ],
    sendAttempt: [
      {
        line: "return null;",
        reason:
          "no UI path: another identity is displayed, and the previous identity's models retire with its page memory (cell W9.rename.another-identity; Review 4 O-R4-3)",
      },
      {
        line: "return result;",
        cells: ["O1.create", "O1.rename", "O1.invite"],
      },
      {
        line: 'case "uncertain":',
        cells: [
          "R3.create.uncertain",
          "R3.rename.uncertain",
          "R3.invite.uncertain",
        ],
      },
      {
        line: "return result;",
        cells: [
          "R3.create.uncertain",
          "R3.rename.uncertain",
          "R3.invite.uncertain",
        ],
      },
      {
        line: 'case "not_sent":',
        cells: [
          "R3.create.not-sent",
          "R3.rename.not-sent",
          "R3.invite.not-sent",
        ],
      },
      {
        line: "return result;",
        cells: [
          "R3.create.not-sent",
          "R3.rename.not-sent",
          "R3.invite.not-sent",
        ],
      },
      {
        line: 'case "offline":',
        cells: ["R3.create.offline", "R3.rename.offline", "R3.invite.offline"],
      },
      {
        line: 'case "closed":',
        cells: ["R3.create.closed", "R3.rename.closed", "R3.invite.closed"],
      },
      {
        line: "return result;",
        cells: ["W7.create.try-again-not-sent"],
      },
      {
        line: "return result;",
        cells: [
          "R3.create.closed",
          "R3.rename.closed",
          "R3.invite.closed",
          "R3.create.offline",
          "R3.rename.offline",
          "R3.invite.offline",
        ],
      },
      {
        line: "default:",
        cells: [
          "R3.create.refused",
          "R3.rename.refused",
          "R3.invite.refused",
          "R3.create.refused-other-kinds",
          "R3.rename.refused-other-kinds",
          "R3.invite.refused-other-kinds",
        ],
      },
      {
        line: "return result;",
        cells: [
          "R3.create.refused",
          "R3.rename.refused",
          "R3.invite.refused",
          "W7.create.refused-completes-nothing",
          "W7.create.try-again-other-answers",
        ],
      },
    ],
    retry: [
      {
        line: "if (earlier === null || token === null) return null;",
        reason:
          "no UI path: Try again is drawn only with an unresolved attempt (`UnresolvedBanner`) and disabled while `retryRefusal` holds (admit's own checks)",
      },
      {
        line: "if (!result?.ok) return null;",
        cells: [
          "W7.create.refused-completes-nothing",
          "W7.rename.refused-completes-nothing",
          "W7.invite.refused-completes-nothing",
          "W7.create.try-again-not-sent",
          "W7.create.try-again-other-answers",
        ],
      },
      {
        line: [
          "} else if (target !== null && earlier.surface === `rename:",
          "{target}`)",
        ].join("$"),
        cells: ["D-1.rename", "W7.rename.detail-forgets"],
      },
      {
        line: [
          "else if (target !== null && earlier.surface === `invite:",
          "{target}`)",
        ].join("$"),
        cells: [
          "D-1.invite",
          "W7.invite.clears",
          "W7.invite.detail-action-keeps-draft",
        ],
      },
      {
        line: "return earlier;",
        cells: [
          "W7.rename.own-dialog-closes",
          "W7.invite.retried-in-rename-dialog",
        ],
      },
    ],
    invite: [
      {
        line: "if (token === null) return false;",
        reason:
          "no UI path: Invite is disabled while `blockedReason` holds, which is the `refusal` admit asks (Review 4 O-R4-3)",
      },
      {
        line: "return false;",
        reason:
          "no UI path: another identity is displayed after the lookup, and its models retire with page memory (Review 4 O-R4-3, RN-22)",
      },
      {
        line: "return false;",
        reason:
          "race: the connection drops, or the server's version stops being writable, while the lookup is on its way; nothing is sent and the ticket completes not durable (Review 4 O-R4-3, RN-20)",
      },
      {
        line: "return false;",
        cells: ["R3.invite.not-found", "R3.invite.lookup-failed"],
      },
      { line: "return false;", cells: ["R3.invite.self"] },
      {
        line: "if (!isCurrentHouseholds(memory)) return false;",
        reason:
          "no UI path: another identity is displayed while a conflict's reads are on their way; its models retire with page memory",
      },
      {
        line: "return result?.ok === true;",
        cells: [
          "O1.invite",
          "R3.invite.uncertain",
          "R3.invite.refused",
          "R3.invite.closed",
          "R3.invite.offline",
          "R3.invite.not-sent",
          "R3.invite.refused-other-kinds",
        ],
      },
    ],
  },
  [`${DIR}/form-recovery.ts`]: {
    dropped: [
      {
        line: "if (linked === undefined || !linked.active) return;",
        cells: ["W8.rename.escape-ends-session"],
      },
      {
        line: "if (linked.shown !== null) void linked.model.discard(linked.shown.start());",
        cells: [
          "W8.rename.escape-ends-session",
          "O1.create",
          "O1.invite.typed-after-success",
        ],
      },
      {
        line: "else {",
        cells: [
          "W7.create.page-after-cancel",
          "W7.rename.page-after-cancel",
          "W7.invite.page-after-close",
        ],
      },
    ],
    completeTicket: [
      {
        // The O1 cells pin the draft this arm leaves; that it finishes the ticket is not pinned (Review 5 F-R5-1, deferred: header).
        line: "if (durable) void ticket.succeeded();",
        cells: ["O1.create", "O1.rename", "O1.invite"],
      },
      {
        line: "else ticket.failed();",
        cells: [
          "R3.create.uncertain",
          "R3.rename.uncertain",
          "R3.invite.uncertain",
        ],
      },
    ],
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
/** Every matching line of `text`, trimmed, with its 0-based line index, in order. */
function writerSites(text: string): { at: number; line: string }[] {
  return code(text).flatMap((line, at) =>
    PATTERNS.some((pattern) => pattern.test(line))
      ? [{ at, line: line.trim() }]
      : [],
  );
}
const writerLines = (text: string) => writerSites(text).map((s) => s.line);
const EXIT = /\breturn\b|^case\b|^default:|\belse\b|^if \(.+\) void /;
/** The arms of function `name` in `text` (from its declaration to the first `}` in column 0), trimmed, in order. */
function exitLines(text: string, name: string): string[] | null {
  const lines = code(text);
  const start = lines.findIndex((line) =>
    new RegExp(`^(export )?(async )?function ${name}\\b`).test(line),
  );
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line === "}");
  return lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => EXIT.test(line));
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
function pinProblems(
  where: string,
  pinList: Pin[],
  read: (path: string) => string | null,
): string[] {
  const problems: string[] = [];
  for (const pin of pinList) {
    const text = read(pin.file);
    if (text === null) problems.push(`${where}: ${pin.file} does not exist`);
    else if (!text.includes(JSON.stringify(pin.title)))
      problems.push(`${where}: no test titled "${pin.title}" in ${pin.file}`);
  }
  return problems;
}
const reasonProblem = (where: string, reason: string | undefined) =>
  reason !== undefined &&
  !REASONS.some((kind) => reason.startsWith(`${kind}: `))
    ? [
        `${where}: reason "${reason.slice(0, 40)}…" is not one of ${REASONS.join(", ")}`,
      ]
    : [];

interface Mutant {
  id: string;
  file: string;
  tests: string[];
  expect?: RegExp;
  patch(text: string): string;
}
const CATALOGUE = UNIT as unknown as Mutant[];
const byId = (unit: Mutant[], id: string) => unit.find((m) => m.id === id);
/** The 0-based original lines a patch changes (one hunk: the patcher replaces exactly one occurrence), or null when it changes none. */
function changed(before: string, after: string): [number, number] | null {
  if (before === after) return null;
  const a = before.split("\n");
  const b = after.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= p && eb >= p && a[ea] === b[eb]) {
    ea -= 1;
    eb -= 1;
  }
  return [p, Math.max(p, ea)];
}
/** A mutant names a pin: its `tests` hold the pin's file and its `expect` matches the pin's title. */
const names = (m: Mutant, pin: Pin) =>
  m.tests.includes(pin.file) && m.expect?.test(pin.title) === true;

/** Every difference between the households source `files`, the registry `sites` and the catalogue `unit` (empty when they agree). */
function audit(
  files: Record<string, string>,
  sites: Record<string, Site[]>,
  read: (path: string) => string | null,
  unit: Mutant[] = CATALOGUE,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    const found = writerSites(text);
    if (found.length === 0) continue;
    seen.add(file);
    const registered = sites[file];
    if (!registered) {
      problems.push(`${file}: ${found.length} unregistered writer site(s)`);
      continue;
    }
    const n = Math.max(found.length, registered.length);
    for (let i = 0; i < n; i += 1) {
      const line = found[i]?.line;
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
      const where = `${file} #${i + 1}`;
      const mutants = entry.mutants ?? [];
      const pinned = entry.pins ?? [];
      if (mutants.length === 0 && entry.reason === undefined)
        problems.push(`${where}: neither a mutant nor a reason`);
      if (mutants.length > 0 && pinned.length === 0)
        problems.push(`${where}: mutants without the tests they prove`);
      problems.push(...reasonProblem(where, entry.reason));
      if (
        RULE_BEARING.includes(entry.writer) &&
        entry.reason !== undefined &&
        !ARGUED.some((kind) => entry.reason?.startsWith(`${kind}: `))
      )
        problems.push(
          `${where}: a ${entry.writer} site needs a mutant or an argued reason (${ARGUED.join(", ")})`,
        );
      if (!RULE_BEARING.includes(entry.writer) && entry.reason === undefined)
        problems.push(`${where}: a ${entry.writer} site states its reason`);
      problems.push(...pinProblems(where, pinned, read));
      const at = found[i]?.line === entry.line ? found[i]?.at : undefined;
      for (const id of mutants) {
        const m = byId(unit, id);
        if (m === undefined) {
          problems.push(`${where}: ${id} is not catalogued`);
          continue;
        }
        if (m.file !== file) {
          problems.push(`${where}: ${id} mutates ${m.file}`);
          continue;
        }
        let range: [number, number] | null = null;
        try {
          range = changed(text, m.patch(text));
        } catch (error) {
          problems.push(`${where}: ${id} does not apply (${String(error)})`);
          continue;
        }
        if (
          at !== undefined &&
          (range === null || at < range[0] || at > range[1])
        )
          problems.push(`${where}: ${id} does not change "${entry.line}"`);
        if (!pinned.some((pin) => names(m, pin)))
          problems.push(
            `${where}: ${id} names none of the site's pinned tests`,
          );
      }
      for (const pin of pinned)
        if (
          !mutants.some((id) => {
            const m = byId(unit, id);
            return m !== undefined && names(m, pin);
          })
        )
          problems.push(
            `${where}: no mutant of the site names "${pin.title.slice(0, 60)}…"`,
          );
    });
  }
  for (const file of Object.keys(sites))
    if (!seen.has(file))
      problems.push(`${file}: registered, but has no writer site`);
  return problems;
}

/** Every difference between the functions' arms and the `exits` registry (empty when they agree). */
function auditExits(
  files: Record<string, string>,
  exits: Record<string, Record<string, Exit[]>>,
  cells: Record<string, Cell>,
): string[] {
  const problems: string[] = [];
  for (const [file, functions] of Object.entries(exits))
    for (const [name, registered] of Object.entries(functions)) {
      const found = exitLines(files[file] ?? "", name);
      if (found === null) {
        problems.push(`${file} ${name}(): no such function`);
        continue;
      }
      const n = Math.max(found.length, registered.length);
      for (let i = 0; i < n; i += 1) {
        const where = `${file} ${name}() arm #${i + 1}`;
        const line = found[i];
        const entry = registered[i];
        if (line === undefined)
          problems.push(`${where}: registered "${entry?.line}" is gone`);
        else if (entry === undefined)
          problems.push(`${where}: unregistered arm "${line}"`);
        else if (line !== entry.line)
          problems.push(
            `${where}: "${line}" where "${entry.line}" is registered`,
          );
      }
      registered.forEach((entry, i) => {
        const where = `${file} ${name}() arm #${i + 1}`;
        if ((entry.cells?.length ?? 0) === 0 && entry.reason === undefined)
          problems.push(`${where}: neither a cell nor a reason`);
        problems.push(...reasonProblem(where, entry.reason));
        for (const id of entry.cells ?? [])
          if (cells[id] === undefined) problems.push(`${where}: no cell ${id}`);
      });
    }
  return problems;
}

const ruleOf = (id: string) => id.slice(0, id.indexOf("."));
/** Every problem of the cell table: its tests exist, each cell's mutants name it and no other input's cell of the same rule. */
function auditCells(
  cells: Record<string, Cell>,
  read: (path: string) => string | null,
  unit: Mutant[] = CATALOGUE,
): string[] {
  const problems: string[] = [];
  const shared = new Map<string, Set<Input>>();
  for (const c of Object.values(cells))
    for (const id of c.mutants ?? [])
      shared.set(id, (shared.get(id) ?? new Set()).add(c.input));
  for (const [id, c] of Object.entries(cells)) {
    problems.push(...pinProblems(`cell ${id}`, [c.test], read));
    if (c.test.file === CELLS_FILE && !c.test.title.startsWith(`${id}:`))
      problems.push(`cell ${id}: its title does not begin with its id`);
    if ((c.mutants?.length ?? 0) === 0 && c.control === undefined)
      problems.push(`cell ${id}: no mutant proves it`);
    if (c.control !== undefined && cells[c.control] === undefined)
      problems.push(`cell ${id}: the control of an unknown cell ${c.control}`);
    for (const mid of c.mutants ?? []) {
      const m = byId(unit, mid);
      if (m === undefined) {
        problems.push(`cell ${id}: ${mid} is not catalogued`);
        continue;
      }
      if (!names(m, c.test))
        problems.push(`cell ${id}: ${mid} does not name its test`);
      if ((shared.get(mid)?.size ?? 0) > 1) continue;
      for (const [other, o] of Object.entries(cells))
        if (
          o.input !== c.input &&
          ruleOf(other) === ruleOf(id) &&
          m.expect?.test(o.test.title)
        )
          problems.push(
            `cell ${id}: ${mid} also names ${other} (another input)`,
          );
    }
  }
  return problems;
}

describe("WEB-12b revisions 2 and 3 (F-R3-1, F-R4-1; I-9′, I-10′, I-11): the household drafts' writers, exits and cells", () => {
  const files = sources(join(ROOT, DIR));

  test("the registry and the source agree: every writer of drafts, bases and tickets is classified and tied to the mutants that change it", () => {
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

  test("the exits: every arm of run, sendAttempt, retry, invite, dropped and completeTicket is tied to its cells or given a reason", () => {
    expect(auditExits(files, EXITS, CELLS)).toEqual([]);
    expect(
      Object.values(EXITS).flatMap((fns) => Object.values(fns).flat()),
    ).toHaveLength(31);
  });

  test("the cells: each names an existing test that its mutants name, and a mutant of one input names no other input's cell of its rule", () => {
    expect(auditCells(CELLS, readRepo)).toEqual([]);
    // Every test of the cells file is a registered cell (no unregistered cell, no cell twice).
    const titles = [...cellsText.matchAll(/test\(\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    const registered = Object.values(CELLS)
      .filter((c) => c.test.file === CELLS_FILE)
      .map((c) => c.test.title);
    expect(titles.sort()).toEqual(registered.sort());
    expect(titles).toHaveLength(40);
  });

  test("the known asymmetries are listed with their decision or observation", () => {
    const known = [
      ...Object.values(SITES)
        .flat()
        .filter((site) => site.known !== undefined)
        .map((site) => `${site.writer} ${site.line}`),
      ...Object.entries(CELLS)
        .filter(([, c]) => c.known !== undefined)
        .map(([id]) => `cell ${id}`),
    ];
    expect(known).toEqual([
      "W8 onDiscard={() => memory.draft(key, null)}",
      "W6 memory.bases.delete(key);",
      "W7 memory.draft(formContext.create(), null);",
      "W7 memory.draft(formContext.rename(target), null);",
      "W7 memory.draft(formContext.invite(target), null);",
      "cell R4.rename.retry-conflict-keeps-stale-base",
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

  test("NEGATIVE: a site's mutant that does not change its line, or names none of its tests, fails", () => {
    const file = `${DIR}/InvitationsDialog.tsx`;
    const at =
      SITES[file]?.findIndex((s) => s.line === "completeTicket(ticket, ok);") ??
      -1;
    const swapped = {
      ...SITES,
      [file]: (SITES[file] ?? []).map((s, i) =>
        i === at ? { ...s, mutants: ["MU-6258"] } : s,
      ),
    };
    expect(audit(files, swapped, readRepo)).toEqual(
      expect.arrayContaining([
        `${file} #${at + 1}: MU-6258 does not change "completeTicket(ticket, ok);"`,
        `${file} #${at + 1}: MU-6258 names none of the site's pinned tests`,
      ]),
    );
    const blind = CATALOGUE.map((m) =>
      m.id === "MU-6263" ? { ...m, expect: /R3 Rename/ } : m,
    );
    expect(audit(files, SITES, readRepo, blind)).toEqual(
      expect.arrayContaining([
        `${file} #${at + 1}: MU-6263 names none of the site's pinned tests`,
      ]),
    );
  });

  test("NEGATIVE: a new arm (an early return in retry), or a cell mutant that also names another input's cell, fails", () => {
    const file = `${DIR}/operations.ts`;
    const added = {
      ...files,
      [file]: (files[file] ?? "").replace(
        "  if (!result?.ok) return null;\n",
        '  if (!result?.ok) return null;\n  if (earlier.surface === "") return null;\n',
      ),
    };
    expect(auditExits(added, EXITS, CELLS)).toEqual(
      expect.arrayContaining([
        `${file} retry() arm #3: "if (earlier.surface === \\"\\") return null;" where "${EXITS[file]?.retry?.[2]?.line}" is registered`.replace(
          '\\"\\"',
          '""',
        ),
      ]),
    );
    const wide = CATALOGUE.map((m) =>
      m.id === "MU-6276" ? { ...m, expect: /R3\.(create|rename)\.closed:/ } : m,
    );
    expect(auditCells(CELLS, readRepo, wide)).toEqual([
      "cell R3.create.closed: MU-6276 also names R3.rename.closed (another input)",
    ]);
  });
});
