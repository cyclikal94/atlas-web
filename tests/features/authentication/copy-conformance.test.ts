import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  JOIN_FOOTNOTE,
  JOIN_OFFLINE_REASON,
} from "../../../src/features/authentication/JoinForm";
import {
  LINK_INVALID,
  LOST_RESPONSE,
} from "../../../src/features/authentication/JoinSurface";
import { MESSAGE_TEXT } from "../../../src/features/authentication/outcome-copy";
import { OFFLINE_REASON } from "../../../src/features/authentication/SignInForm";
import {
  NO_PASSWORD_BODY,
  NO_PASSWORD_HEADING,
  PASSWORD_CONSEQUENCE,
  PASSWORD_HEADING,
  PASSWORD_HINT,
  PASSWORD_OFFLINE_REASON,
  WRONG_CURRENT_WARNING,
} from "../../../src/features/settings/signing-in/ChangePasswordForm";
import {
  LINK_HINT,
  LINK_LABEL,
  LINK_OFFLINE_REASON,
  LINKED_HEADING,
  NO_LINKS,
  NO_PASSWORD_REASON,
  REMOVE_CONSEQUENCE,
  REMOVE_OFFLINE_REASON,
  REMOVE_RULE,
  STALE_REASON,
} from "../../../src/features/settings/signing-in/LinkedIdentities";
import { CHECK_OFFLINE_REASON } from "../../../src/features/settings/signing-in/Unconfirmed";

/**
 * A-1 (WEB-08b plan 9.1): copy conformance. Every string that CLAIMS to come from an accepted wireframe [W] or an accepted Claude
 * Design board [D] is compared with the staged source by script, not by eye; every PROVISIONAL string [P] (no accepted text exists)
 * is listed so it can be reviewed; and no "Engineering note" paragraph ships. The comparison is skipped, and reported as skipped,
 * when the staged approval bundle is absent (a checkout without `.agtx/`), so the suite does not depend on it.
 *
 * It proves the words match their source. It does NOT prove Kieran has accepted any provisional wording: that stays open.
 */
const ROOT = resolve(__dirname, "../../..");
const STAGED = join(ROOT, ".agtx/approved");
const FILES = {
  registration: join(
    STAGED,
    "artefacts/WEB-05.5/outputs/wireframes/q21/registration.html",
  ),
  settingsBoard: join(
    STAGED,
    "approval/design_handoff_atlas_web/Atlas Settings Screens.dc.html",
  ),
  syncBoard: join(
    STAGED,
    "approval/design_handoff_atlas_web/Atlas Sync Screens.dc.html",
  ),
  settings03: join(
    STAGED,
    "artefacts/WEB-02/outputs/WEB-02/wireframes/settings/WF-SETTINGS-03-desktop.html",
  ),
};
const staged = Object.values(FILES).every((file) => existsSync(file));

/** The visible text of a staged HTML file, whitespace collapsed (jsdom decodes entities). */
function textOf(file: string): string {
  const html = readFileSync(file, "utf8").replace(
    /<(script|style)\b[\s\S]*?<\/\1>/gi,
    "",
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Placeholders are attribute values, which `textContent` leaves out.
  const placeholders = [...doc.querySelectorAll("[placeholder]")].map(
    (element) => element.getAttribute("placeholder") ?? "",
  );
  return `${doc.body.textContent ?? ""} ${placeholders.join(" ")}`
    .replace(/\s+/g, " ")
    .trim();
}
const squash = (value: string) => value.replace(/\s+/g, " ").trim();

describe.skipIf(!staged)(
  "[W] and [D] strings equal their staged source",
  () => {
    const sources = staged
      ? {
          registration: textOf(FILES.registration),
          settingsBoard: textOf(FILES.settingsBoard),
          syncBoard: textOf(FILES.syncBoard),
          settings03: textOf(FILES.settings03),
        }
      : { registration: "", settingsBoard: "", syncBoard: "", settings03: "" };

    const W_REGISTRATION: Array<[string, string]> = [
      ["the link is no longer valid", LINK_INVALID],
      ["the footnote", JOIN_FOOTNOTE],
      ["the lost-response sentence", LOST_RESPONSE],
      ["the offline reason", JOIN_OFFLINE_REASON],
      ["the username placeholder", "Choose a username"],
      ["the password placeholder", "At least 12 characters"],
      ["the invitation heading stem", "You're invited to join"],
      ["the household line stem", "This invitation joins the"],
      ["the submit stem", "Create account and join"],
      // The wireframe says "Ask kieran for a new one"; the preview carries no inviter (gap G-22), so only the stem is verbatim.
      [
        "the unavailable stem",
        MESSAGE_TEXT.invitation_unavailable.split(" Ask ")[0] as string,
      ],
    ];
    test.each(W_REGISTRATION)("[W] registration.html: %s", (_name, text) => {
      expect(sources.registration).toContain(squash(text));
    });

    const D_SYNC: Array<[string, string]> = [
      ["the single sign-on control", "Use single sign-on instead"],
      ["the offline reason", OFFLINE_REASON],
    ];
    test.each(D_SYNC)(
      "[D] Atlas Sync Screens, SWITCH-02: %s",
      (_name, text) => {
        expect(sources.syncBoard).toContain(squash(text));
      },
    );

    const D_SETTINGS: Array<[string, string]> = [
      ["the password heading", PASSWORD_HEADING],
      ["the current password label", "Current password"],
      ["the new password label", "New password"],
      ["the sign-out-everywhere consequence", PASSWORD_CONSEQUENCE],
      ["the password button", "Change password"],
      ["the linked accounts heading", LINKED_HEADING],
      ["the five-minute rule", REMOVE_RULE],
      [
        "the removal consequence stem",
        REMOVE_CONSEQUENCE.split(".")[0] as string,
      ],
      ["the unconfirmed sentence", MESSAGE_TEXT.unconfirmed],
      ["the no-password heading", NO_PASSWORD_HEADING],
      ["the no-password note", NO_PASSWORD_BODY],
    ];
    test.each(D_SETTINGS)(
      "[D] Atlas Settings Screens, SETTINGS-03: %s",
      (_name, text) => {
        // The board writes the unconfirmed sentence in typographic quotes and as two sentences; compare without them.
        const plain = (value: string) =>
          squash(value)
            .replaceAll("“", "")
            .replaceAll("”", "")
            .replaceAll("’", "'");
        expect(plain(sources.settingsBoard)).toContain(plain(text));
      },
    );

    test("[W] WF-SETTINGS-03: the byte hint", () => {
      expect(sources.settings03).toContain(`New password (${PASSWORD_HINT})`);
    });

    test("[W] WF-SETTINGS-03: the refusal paragraph keeps the wireframe's two rules (a fresh session and a local password)", () => {
      // Adapted (gap G-18): "OIDC link" is "single sign-on link" in the product's words. The two conditions are verbatim.
      for (const clause of [
        "requires a session created within the last five minutes and a local password already on the account",
        "so your last login method is never removed",
        "Log in again if your session isn't fresh enough",
      ])
        expect(sources.settings03).toContain(clause);
      for (const clause of [
        "requires a session created within the last five minutes and a local password already on the account",
        "so your last login method is never removed",
        "Log in again if your session isn't fresh enough",
      ])
        expect(MESSAGE_TEXT.unlink_refused).toContain(clause);
    });
  },
);

describe("no engineering note ships, and every provisional string is listed", () => {
  const SOURCES = [
    "src/features/authentication",
    "src/features/settings/account",
    "src/features/settings/signing-in",
  ].flatMap((dir) =>
    readdirSync(join(ROOT, dir))
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => ({
        file: `${dir}/${name}`,
        text: readFileSync(join(ROOT, dir, name), "utf8"),
      })),
  );

  test("no 'Engineering note' paragraph is in any shipped source", () => {
    for (const { file, text } of SOURCES)
      expect(text, file).not.toMatch(/Engineering note/i);
  });

  // [P]: no accepted source exists (design gaps G-14 to G-24); Kieran's copy acceptance is OPEN for every one.
  const PROVISIONAL: Record<string, string> = {
    ...Object.fromEntries(
      (
        [
          "bad_credentials",
          "rate_limited",
          "check_details",
          "wrong_origin",
          "not_set_up",
          "device_capacity",
          "temporarily_unavailable",
          "unreachable",
          "hidden_tab",
          "busy_window",
          "interrupted",
          "wipe_pending",
          "storage_unavailable",
          "generic",
          "activation_refused",
          "username_taken",
          "sso_not_set_up",
          "sso_unavailable",
          "sso_link_needs_recent_sign_in",
          "sso_landing_invalid",
          "sso_landing_failed",
          "sso_linked",
          "still_unconfirmed",
        ] as const
      ).map((id) => [`message:${id}`, MESSAGE_TEXT[id]]),
    ),
    "sign-in heading": "Sign in to Atlas",
    "reauthenticate heading": "Sign in again",
    "sign-in button": "Sign in",
    "back button": "Back",
    "busy reason": "Signing in…",
    "join submit (standalone)": "Create account",
    "join busy reason": "Creating your account…",
    "lost-response heading": "Check whether your account was created",
    "earlier-registration heading":
      "Check whether your earlier account was created",
    "earlier-registration message":
      "You opened another invitation, so the result of the earlier one isn't shown here. If you already submitted it, don't try again — sign in with the details you chose.",
    "unavailable heading": "This invitation can't be used",
    "preview-error heading": "We couldn't open this invitation",
    "wrong current password warning": WRONG_CURRENT_WARNING,
    "link control": LINK_LABEL,
    "link hint": LINK_HINT,
    "nothing linked": NO_LINKS,
    "stale-session reason": STALE_REASON,
    "no-password reason": NO_PASSWORD_REASON,
    "password offline reason": PASSWORD_OFFLINE_REASON,
    "remove offline reason": REMOVE_OFFLINE_REASON,
    "link offline reason": LINK_OFFLINE_REASON,
    "check-now offline reason": CHECK_OFFLINE_REASON,
    "Signing in registry description": "Your password and single sign-on link.",
  };

  test("every provisional string exists, verbatim, in the source", () => {
    const all =
      SOURCES.map((s) => s.text).join("\n") +
      readFileSync(join(ROOT, "src/features/settings/sections.ts"), "utf8");
    for (const [name, text] of Object.entries(PROVISIONAL))
      expect(all.replaceAll("\\'", "'").replaceAll('\\"', '"'), name).toContain(
        text.replaceAll("’", "'"),
      );
  });

  test("the review list is written for the evidence folder when asked", () => {
    const out = process.env.ATLAS_COPY_EVIDENCE;
    if (!out) return;
    mkdirSync(resolve(out, ".."), { recursive: true });
    writeFileSync(out, `${JSON.stringify(PROVISIONAL, null, 2)}\n`);
    expect(Object.keys(PROVISIONAL).length).toBeGreaterThan(30);
  });
});
