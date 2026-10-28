// WEB-08d entries preserved during the accepted WEB-10a integration. IDs, selections and patch bodies are unchanged.
// Like the existing catalogue modules, this keeps each file within the existing 1 MiB lint limit.
import { sub } from "./data-catalogue.mjs";

export const UNIT_LABELS = [
  {
    id: "MU-1600",
    title:
      "WEB-08d: a later MINOR enum value is kept raw instead of decoding to `unknown`",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: ["tests/features/settings/session-labels.test.ts"],
    expect: /a later MINOR value decodes to `unknown` itself/,
    patch: (t) =>
      sub(
        t,
        'typeof value === "string" && own(known, value) ? (value as T) : "unknown"',
        'typeof value === "string" ? (value as T) : "unknown"',
      ),
  },
  {
    id: "MU-1601",
    title: "WEB-08d: the `native` channel is rendered as a browser",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: [
      "tests/features/settings/session-labels.test.ts",
      "tests/features/settings/labels-contract.test.ts",
    ],
    expect: /reads Atlas app on iOS/,
    patch: (t) =>
      sub(
        t,
        'if (label.channel === "native") return platform ? appOn(platform) : APP;',
        "void APP;",
      ),
  },
  {
    id: "MU-1602",
    title:
      "WEB-08d: the legacy fallback title is lost (an unlabelled session has an empty title)",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: ["tests/features/settings/session-labels.test.ts"],
    expect: /a null, absent or unusable label falls back/,
    patch: (t) =>
      sub(
        t,
        "  return row.current ? THIS_BROWSER : ANOTHER_SIGN_IN;\n}",
        '  return row.current ? "" : "";\n}',
      ),
  },
  {
    id: "MU-1603",
    title: "WEB-08d: checkDeviceName accepts U+202E (a right-to-left override)",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: [
      "tests/features/settings/session-labels.test.ts",
      "tests/features/settings/labels-contract.test.ts",
    ],
    expect: /U\+8238 forbidden: true/,
    patch: (t) =>
      sub(
        t,
        "(cp >= 0x202a && cp <= 0x202e) ||",
        "(cp >= 0x202a && cp <= 0x202d) ||",
      ),
  },
  {
    id: "MU-1604",
    title:
      "WEB-08d: the name's length is counted in UTF-16 units, so 64 emoji are refused",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: ["tests/features/settings/session-labels.test.ts"],
    expect: /64 emoji \(128 UTF-16 units\) are accepted/,
    patch: (t) =>
      sub(
        t,
        'if (points.length > NAME_MAX_SCALARS) return "too_long";',
        'if (value.length > NAME_MAX_SCALARS) return "too_long";',
      ),
  },
  {
    id: "MU-1605",
    title: "WEB-08d: white space at the edge of a name is accepted",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: ["tests/features/settings/session-labels.test.ts"],
    expect: /problems are reported in order/,
    patch: (t) => sub(t, '    return "edge_space";', "    void 0;"),
  },
  {
    id: "MU-1606",
    title: "WEB-08d: a name the server could never send (invalid) is displayed",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: ["tests/features/settings/session-labels.test.ts"],
    expect: /a name a correct server never sends is treated as absent/,
    patch: (t) =>
      sub(
        t,
        'return typeof raw === "string" && checkDeviceName(raw) === null ? raw : null;',
        'return typeof raw === "string" ? raw : null;',
      ),
  },
  {
    id: "MU-1607",
    title: "WEB-08d: `limit: null` is read as a limited capacity",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: ["tests/features/settings/session-labels.test.ts"],
    expect: /"kind":"unlimited"/,
    patch: (t) =>
      sub(
        t,
        'if (limit === null && remaining === null) return { kind: "unlimited", used };',
        'if (limit === null && remaining === null)\n    return { kind: "limited", limit: 0, used, remaining: 0 };',
      ),
  },
  {
    id: "MU-1608",
    title: "WEB-08d: an absent capacity (an older server) is read as 0 of 0",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: ["tests/features/settings/session-labels.test.ts"],
    expect: /undefined is \{"kind":"unavailable"\}/,
    patch: (t) =>
      sub(
        t,
        '  if (typeof raw !== "object" || raw === null || Array.isArray(raw))\n    return { kind: "unavailable" };\n  const { limit, used, remaining }',
        '  if (typeof raw !== "object" || raw === null || Array.isArray(raw))\n    return { kind: "limited", limit: 0, used: 0, remaining: 0 };\n  const { limit, used, remaining }',
      ),
  },
  {
    id: "MU-1609",
    title: "WEB-08d: an inconsistent `remaining` is accepted",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: ["tests/features/settings/session-labels.test.ts"],
    expect: /"remaining":3\} is \{"kind":"unavailable"\}/,
    patch: (t) =>
      sub(
        t,
        "    remaining === Math.max(limit - used, 0)\n",
        "    remaining >= 0\n",
      ),
  },
  {
    id: "MU-1610",
    title:
      "WEB-08d: the devices line counts the listed devices instead of sync_capacity",
    file: "src/features/settings/sessions-devices/DevicesSection.tsx",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /both lines come from their own answers/,
    patch: (t) =>
      sub(
        t,
        '<CapacityLine kind="devices" raw={load.value.sync_capacity} />',
        '<CapacityLine kind="devices" raw={{ limit: (load.value.sync_capacity as { limit: number }).limit, used: load.value.devices.length, remaining: Math.max((load.value.sync_capacity as { limit: number }).limit - load.value.devices.length, 0) }} />',
      ),
  },
  {
    id: "MU-1611",
    title: "WEB-08d: the kernel drops sync_capacity from the devices read",
    file: "src/session/kernel/operations.ts",
    tests: ["tests/session/public-decode.test.ts"],
    expect: /BE-Q25 readDevices \+ sync_capacity no transition/,
    patch: (t) =>
      sub(
        t,
        'return Object.hasOwn(value as object, "sync_capacity")',
        'return false && Object.hasOwn(value as object, "sync_capacity")',
      ),
  },
  {
    id: "MU-1612",
    title:
      "WEB-08d: the kernel turns an absent session_capacity into null (unavailable can no longer be told from a value)",
    file: "src/session/kernel/operations.ts",
    tests: ["tests/session/operations-device-name.test.ts"],
    expect: /absent stays absent/,
    patch: (t) =>
      sub(
        t,
        ": { sessions: sessions as SessionSummary[] };",
        ": { sessions: sessions as SessionSummary[], session_capacity: null };",
      ),
  },
  {
    id: "MU-1613",
    title: "WEB-08d: nameDevice trims the name before sending it",
    file: "src/session/kernel/operations.ts",
    tests: ["tests/session/operations-device-name.test.ts"],
    expect: /never trimmed by the client/,
    patch: (t) =>
      sub(
        t,
        // Review R3 (revision 2) adaptation: the body now sits beside the caller's `withdraw`; same mutation, same intent.
        ": { body: { name }, withdraw: send.withdraw },",
        ": { body: { name: name.trim() }, withdraw: send.withdraw },",
      ),
  },
  {
    id: "MU-1614",
    title: "WEB-08d: a 404 not_found is reported as `named`",
    file: "src/session/kernel/operations.ts",
    tests: ["tests/session/operations-device-name.test.ts"],
    expect: /404 not_found is `gone`/,
    patch: (t) =>
      sub(
        t,
        '          return { ok: true, value: "gone" };\n        // Any other answer',
        '          return { ok: true, value: "named" };\n        // Any other answer',
      ),
  },
  {
    id: "MU-1615",
    title:
      "WEB-08d: a `closed` naming answer (another identity is settled) is treated as a success",
    file: "src/features/settings/sessions-devices/NameDeviceDialog.tsx",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /closed: the session moved on/,
    patch: (t) =>
      sub(
        t,
        "    if (result?.ok) {",
        '    if (result?.ok || (result && !result.ok && result.error === "closed")) {',
      ),
  },
  {
    id: "MU-1616",
    title:
      "WEB-08d: an unconfirmed outcome (a 5xx or a lost answer) is reported as 'not saved'",
    file: "src/features/settings/sessions-devices/NameDeviceDialog.tsx",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /the outcome is unknown, it says so/,
    patch: (t) =>
      sub(t, "          : NAME_UNCONFIRMED;", '          : "Name not saved.";'),
  },
  {
    id: "MU-1617",
    title:
      "WEB-08d: naming is offered by a server that does not support it (no sync_capacity)",
    file: "src/features/settings/sessions-devices/DevicesSection.tsx",
    tests: [
      "tests/features/settings/name-device.test.tsx",
      "tests/features/settings/sessions-devices.test.tsx",
    ],
    expect: /naming is offered only when the server supports it/,
    patch: (t) =>
      sub(
        t,
        'load.status === "ready" && Object.hasOwn(load.value, "sync_capacity");',
        'load.status === "ready";',
      ),
  },
  {
    id: "MU-1618",
    title: "WEB-08d: the naming control is enabled offline",
    file: "src/features/settings/sessions-devices/DevicesSection.tsx",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /offline: Name and Rename are disabled/,
    patch: (t) =>
      sub(
        t,
        "                      {canName ? (\n                        online ? (",
        "                      {canName ? (\n                        online || true ? (",
      ),
  },
  {
    id: "MU-1619",
    title:
      "WEB-08d: a reload keeps the previous answer, so a stale capacity stands while the list is read again",
    file: "src/features/settings/sessions-devices/useLoad.ts",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /no capacity line while a list reloads or after it fails/,
    patch: (t) => sub(t, '    setState({ status: "loading" });', "    void 0;"),
  },
  {
    id: "MU-1620",
    title: "WEB-08d: the retire-other confirmation does not name the device",
    file: "src/features/settings/sessions-devices/RetireOtherDialog.tsx",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /retiring another device: the title names it/,
    patch: (t) =>
      sub(
        t,
        "title={retireOtherDialogTitle(device)}",
        'title={"Retire this other device?"}',
      ),
  },
  {
    id: "MU-1621",
    title: "WEB-08d: the current-row indicator is on every session row",
    file: "src/features/settings/sessions-devices/SessionsSection.tsx",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /each current row has exactly one indicator/,
    patch: (t) =>
      sub(
        t,
        '                      {row.current ? (\n                        <span\n                          data-current-tag=""',
        '                      {true ? (\n                        <span\n                          data-current-tag=""',
      ),
  },
  {
    id: "MU-1622",
    title: "WEB-08d: the hint for devices that look the same is missing",
    file: "src/features/settings/sessions-devices/DevicesSection.tsx",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /two devices that look the same get one hint/,
    patch: (t) =>
      sub(
        t,
        "{canName && hasDuplicateTitles(load.value.devices) ? (",
        "{canName && false ? (",
      ),
  },
  {
    id: "MU-1623",
    title:
      "WEB-08d: the retirement envelope carries the device's name (persisted in atlas-auth)",
    file: "src/session/kernel/operations.ts",
    tests: ["tests/session/operations-retirement.test.ts"],
    expect: /a device.s name and label are never persisted/,
    patch: (t) =>
      sub(
        t,
        "summary: input.device.summary,",
        "summary: { ...input.device.summary, name: input.device.name } as never,",
      ),
  },
  {
    id: "MU-1624",
    title:
      "WEB-08d: a device name is not bidi-isolated where it stands in a composed string (accessible names, titles)",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: [
      "tests/features/settings/session-labels.test.ts",
      "tests/features/settings/name-device.test.tsx",
    ],
    expect: /an action.s phrase is the title and the row.s own timestamp/,
    patch: (t) =>
      sub(
        t,
        "  if (d.named) return isolate(d.title);",
        "  if (d.named) return d.title;",
      ),
  },
  {
    id: "MU-1625",
    title: "WEB-08d: a name the rules refuse is sent anyway",
    file: "src/features/settings/sessions-devices/NameDeviceDialog.tsx",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /is refused before sending/,
    patch: (t) => sub(t, "    if (problem) {", "    if (problem && false) {"),
  },
  {
    id: "MU-1626",
    title:
      "WEB-08d: the naming handler does not re-check the browser's connectivity",
    file: "src/features/settings/sessions-devices/NameDeviceDialog.tsx",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /the handler re-checks the browser/,
    patch: (t) =>
      sub(
        t,
        // Review R3 (revision 2) adaptation: the guard now also asks whether the interaction is current; same mutation, same intent.
        "if (inflight.current || !isOnlineNow() || !interaction.current()) return;",
        "if (inflight.current || !interaction.current()) return;",
      ),
  },
  {
    id: "MU-1627",
    title:
      "WEB-08d: a naming result that arrives after the dialog was closed is still acted on",
    file: "src/features/settings/sessions-devices/NameDeviceDialog.tsx",
    // Review R1/R3 (revision 2) adaptation: the dialog's `live` flag became its interaction. The mutant removes the presentation guard
    // that replaced it (the lists are still read again, which is now required); the test still requires that nothing is said.
    tests: [
      "tests/features/settings/name-device.test.tsx",
      "tests/features/settings/interaction-ownership.test.tsx",
    ],
    expect: /arrives after the dialog was closed/,
    patch: (t) =>
      sub(
        t,
        "    if (!interaction.current()) return;\n    if (result?.ok) {",
        "    if (result?.ok) {",
      ),
  },
  {
    id: "MU-1628",
    title: "WEB-08d: the logout warning does not name this browser",
    file: "src/features/settings/sessions-devices/WipeConfirmDialog.tsx",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /logging out: the warning names this browser/,
    patch: (t) =>
      sub(
        t,
        "return label ? { line: thisBrowserLine(clientLabelText(label)) } : null;",
        "return label ? null : null;",
      ),
  },
  {
    id: "MU-1629",
    title:
      "WEB-08d: a naming change does not read the sessions list again (its device_name goes stale)",
    file: "src/features/settings/sessions-devices/SessionsSection.tsx",
    // Review R1 adaptation (revision 1): naming reported through the section's shared `changed`. Revision 2 adaptation: a change is
    // reported to every list on the page (`ownership.ts`); the mutant keeps its intent by leaving the sessions list unsubscribed.
    tests: [
      "tests/features/settings/name-device.test.tsx",
      "tests/features/settings/cross-list.test.tsx",
    ],
    expect: /BOTH lists are read again/,
    patch: (t) => sub(t, "  useListChanges(reload);", "  void useListChanges;"),
  },
  {
    id: "MU-1630",
    title: "WEB-08d: clearing a name sends PUT instead of DELETE",
    file: "src/session/kernel/operations.ts",
    tests: ["tests/session/operations-device-name.test.ts"],
    expect: /null is DELETE with no body/,
    patch: (t) => sub(t, 'name === null ? "DELETE" : "PUT",', '"PUT",'),
  },
  {
    id: "MU-1631",
    title:
      "WEB-08d: the announcement of another session's sign-out does not name it",
    file: "src/features/settings/sessions-devices/SessionsSection.tsx",
    tests: ["tests/features/settings/name-device.test.tsx"],
    expect: /names it in the announcement/,
    patch: (t) =>
      sub(
        t,
        "named ? signedOut(sessionInSentence(row)) : SIGN_IN_ENDED,",
        "SIGN_IN_ENDED,",
      ),
  },
  {
    id: "MU-1632",
    title: "WEB-08d: the capacity reading accepts a non-integer used count",
    file: "src/features/settings/sessions-devices/labels.ts",
    tests: ["tests/features/settings/session-labels.test.ts"],
    expect: /"limit":4\.5,"used":1,"remaining":3\.5\} is/,
    patch: (t) =>
      sub(
        t,
        'typeof value === "number" && Number.isSafeInteger(value) && value >= 0;',
        'typeof value === "number" && value >= 0;',
      ),
  },
  {
    id: "MU-1633",
    title:
      "WEB-08d R1: retiring another device reads only the devices list (its ended sessions and the sign-in capacity stay on screen)",
    file: "src/features/settings/sessions-devices/RetireOtherDialog.tsx",
    // Review R3 (revision 2) adaptation: a retirement reports to every list through `reconcileLists`, not to the devices section; the
    // mutant reports nothing, so its ended sessions and the sign-in capacity stay on screen as before.
    tests: ["tests/features/settings/cross-list.test.tsx"],
    expect: /retiring another device ends its sessions/,
    patch: (t) =>
      sub(
        t,
        "      reconcileLists(session, interaction.scope);\n    if (!interaction.current()) return;",
        "      void reconcileLists;\n    if (!interaction.current()) return;",
      ),
  },
  {
    id: "MU-1634",
    title:
      "WEB-08d R1: signing out another session reads only the sessions list (a removed device keeps its row and controls)",
    file: "src/features/settings/sessions-devices/DevicesSection.tsx",
    // Review R1/R3 (revision 2) adaptation: the devices list is told through its subscription; the mutant leaves it unsubscribed.
    tests: ["tests/features/settings/cross-list.test.tsx"],
    expect: /last session removes the device and its controls/,
    patch: (t) => sub(t, "  useListChanges(reload);", "  void useListChanges;"),
  },
  {
    id: "MU-1635",
    title:
      "WEB-08d R1: the composed screen does not pass the change signal to the devices list",
    file: "src/features/settings/sessions-devices/ownership.ts",
    // Review R1/R3 (revision 2) adaptation: the composed screen no longer relays the signal; the page's reconciler does. The mutant
    // tells only the first list subscribed (the sessions list), so the devices list misses the change, as before.
    tests: ["tests/features/settings/cross-list.test.tsx"],
    expect: /last session removes the device and its controls/,
    patch: (t) =>
      sub(
        t,
        "  for (const reload of [...(readers.get(session) ?? [])]) reload();",
        "  for (const reload of [...(readers.get(session) ?? [])].slice(0, 1)) reload();",
      ),
  },
  {
    id: "MU-1636",
    title:
      "WEB-08d R1: the composed screen does not pass the change signal to the sessions list",
    file: "src/features/settings/sessions-devices/ownership.ts",
    // Review R1/R3 (revision 2) adaptation: as MU-1635, telling only the last list subscribed (the devices list).
    tests: ["tests/features/settings/cross-list.test.tsx"],
    expect: /retiring another device ends its sessions/,
    patch: (t) =>
      sub(
        t,
        "  for (const reload of [...(readers.get(session) ?? [])]) reload();",
        "  for (const reload of [...(readers.get(session) ?? [])].slice(-1)) reload();",
      ),
  },
  {
    id: "MU-1637",
    title:
      "WEB-08d R1: a sign-out whose outcome is unknown (a lost answer, a 5xx) reads nothing again",
    file: "src/features/settings/sessions-devices/SessionsSection.tsx",
    tests: ["tests/features/settings/cross-list.test.tsx"],
    expect: /sign-out, a 503 for a session that is still there/,
    patch: (t) =>
      // Review R1/R3 (revision 2) adaptation: the rule is now `mayHaveChanged`; the mutant reads again only after a confirmed answer.
      sub(
        t,
        "    if (mayHaveChanged(result)) reconcileLists(session, interaction.scope);",
        "    if (result?.ok) reconcileLists(session, interaction.scope);",
      ),
  },
  {
    id: "MU-1638",
    title:
      "WEB-08d R1: a retirement whose outcome is unknown (a lost answer, a 5xx) reads nothing again",
    file: "src/features/settings/sessions-devices/RetireOtherDialog.tsx",
    tests: ["tests/features/settings/cross-list.test.tsx"],
    expect: /retirement, a 503/,
    patch: (t) =>
      // Review R3 (revision 2) adaptation: the rule now precedes the presentation guard; same intent.
      sub(
        t,
        '"rejected_stale" : outcomeUnknown(result))',
        '"rejected_stale" : false)',
      ),
  },
  {
    id: "MU-1639",
    title:
      "WEB-08d R1: a definite 4xx refusal is treated as an unknown outcome (the lists are read again for nothing)",
    file: "src/features/settings/sessions-devices/outcome.ts",
    tests: ["tests/features/settings/cross-list.test.tsx"],
    expect: /sign-out, a 403 refusal/,
    patch: (t) =>
      sub(
        t,
        "          result.status < 400 ||",
        "          result.status < 500 ||",
      ),
  },
  {
    id: "MU-1640",
    title:
      "WEB-08d R1: a connection lost after sending is treated as a definite answer (the lists are not read again)",
    file: "src/features/settings/sessions-devices/outcome.ts",
    tests: ["tests/features/settings/cross-list.test.tsx"],
    expect: /offline after sending/,
    patch: (t) => sub(t, '    (result.error === "offline" ||', "    (false ||"),
  },
  {
    id: "MU-1641",
    title:
      "WEB-08d R1 (revision 2): a naming change reaches the lists only while its dialog is open (the dismissed-dialog defect)",
    file: "src/features/settings/sessions-devices/NameDeviceDialog.tsx",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /save, then Cancel\/Keep, then the success/,
    patch: (t) =>
      sub(
        t,
        "    if (mayHaveChanged(result)) reconcileLists(session, interaction.scope);",
        "    if (mayHaveChanged(result) && interaction.current())\n      reconcileLists(session, interaction.scope);",
      ),
  },
  {
    id: "MU-1642",
    title:
      "WEB-08d R1 (revision 2): an outcome nobody can confirm is not reported to the lists",
    file: "src/features/settings/sessions-devices/outcome.ts",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /dismissed, then a 503: both lists are read again/,
    patch: (t) =>
      sub(
        t,
        "  result?.ok === true || outcomeUnknown(result);",
        "  result?.ok === true;",
      ),
  },
  {
    id: "MU-1643",
    title:
      "WEB-08d R3 (revision 2): a retirement refused before sending is tried again after its dialog was dismissed",
    file: "src/features/settings/sessions-devices/RetireOtherDialog.tsx",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /not_sent held, Cancel\/Keep, then released/,
    patch: (t) =>
      sub(t, "      { isCurrent: interaction.current },", "      {},"),
  },
  {
    id: "MU-1644",
    title:
      "WEB-08d R3 (revision 2): untilSent makes its first call for an owner that has already gone",
    file: "src/features/settings/sessions-devices/until-sent.ts",
    tests: ["tests/features/settings/until-sent.test.ts"],
    expect: /already superseded makes no call/,
    patch: (t) =>
      sub(
        t,
        "    if (!isCurrent()) return last;\n    last = await call();",
        "    last = await call();",
      ),
  },
  {
    id: "MU-1645",
    title:
      "WEB-08d R3 (revision 2): untilSent waits out a retry delay for an owner that ended during the call",
    file: "src/features/settings/sessions-devices/until-sent.ts",
    tests: [
      "tests/features/settings/until-sent.test.ts",
      "tests/features/settings/interaction-ownership.test.tsx",
    ],
    expect: /no wait and no further call|no retry is even scheduled/,
    patch: (t) =>
      sub(
        t,
        "    if (delay === undefined || !isCurrent()) return last;",
        "    if (delay === undefined) return last;",
      ),
  },
  {
    id: "MU-1646",
    title:
      "WEB-08d R3 (revision 2): closing a retirement warning closes whichever one is open (a late start of an older one closes the newer)",
    file: "src/features/settings/sessions-devices/DevicesSection.tsx",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /this device's retirement: confirmed, Stay, opened again/,
    patch: (t) =>
      sub(
        t,
        "    setRetiring((open) => (open?.interaction === interaction ? null : open));",
        "    setRetiring(null);",
      ),
  },
  {
    id: "MU-1647",
    title:
      "WEB-08d R3 (revision 2): closing the logout warning closes whichever one is open",
    file: "src/features/settings/sessions-devices/SessionsDevices.tsx",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /logging out: confirmed, Stay, opened again/,
    patch: (t) =>
      sub(
        t,
        "    setLoggingOut((open) => (open?.interaction === interaction ? null : open));",
        "    setLoggingOut(null);",
      ),
  },
  {
    id: "MU-1648",
    title:
      "WEB-08d A2 (revision 2): one row's confirmed sign-out clears every row's state (another pending row is released)",
    file: "src/features/settings/sessions-devices/SessionsSection.tsx",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /two rows pending/,
    patch: (t) =>
      sub(t, "      setRow(id, null);", "      setRows(new Map());"),
  },
  {
    id: "MU-1649",
    title:
      "WEB-08d Q7 (revision 2): an interaction stays current after the identity moved on",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect:
      /settles while a naming answer is held|a retry of the old identity is never made/,
    patch: (t) =>
      sub(
        t,
        "      scope !== null &&\n      scopeOf(session.identity.get()) === scope,",
        "      scope !== null,",
      ),
  },
  {
    id: "MU-1650",
    title:
      "WEB-08d Q7 (revision 2): a change of an identity no longer settled makes the new identity's lists read again",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /settles while a naming answer is held/,
    patch: (t) =>
      sub(
        t,
        "  if (scope === null || scopeOf(session.identity.get()) !== scope) return;",
        "  if (scope === null) return;",
      ),
  },
  {
    id: "MU-1651",
    title:
      "WEB-08d R3 (revision 2): the kernel's ordinary call does not pass the caller's withdraw signal to the send loop",
    file: "src/session/kernel/operations.ts",
    tests: ["tests/session/operations-withdraw.test.ts"],
    expect: /a signal already aborted sends nothing/,
    patch: (t) => sub(t, "    withdraw: options.withdraw,\n", ""),
  },
  {
    id: "MU-1652",
    title:
      "WEB-08d R3 (revision 2): the send loop's guards do not see a withdrawn intent (only its abort event cancels)",
    file: "src/session/kernel/send.ts",
    tests: ["tests/session/operations-withdraw.test.ts"],
    expect: /a signal already aborted sends nothing/,
    patch: (t) =>
      sub(
        t,
        "    spec.callerSignal?.aborted === true || spec.withdraw?.aborted === true;",
        "    spec.callerSignal?.aborted === true;",
      ),
  },
  {
    id: "MU-1653",
    title:
      "WEB-08d R3 (revision 2): withdrawing aborts a request already issued (its answer is lost although the server applied it)",
    file: "src/session/kernel/send.ts",
    tests: ["tests/session/operations-withdraw.test.ts"],
    expect: /withdrawn while its answer is held/,
    patch: (t) =>
      sub(
        t,
        "      k.ports.clock.abortAfter(k.config.stampedRequestTimeoutMs),\n      spec.callerSignal,\n    ),",
        "      k.ports.clock.abortAfter(k.config.stampedRequestTimeoutMs),\n      combineSignals(\n        spec.withdraw ?? new AbortController().signal,\n        spec.callerSignal,\n      ),\n    ),",
      ),
  },
  {
    id: "MU-1654",
    title:
      "WEB-08d R1/R3 (revision 2): a naming request refused before sending is tried again after its dialog was dismissed",
    file: "src/features/settings/sessions-devices/NameDeviceDialog.tsx",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect:
      /refused before sending, then dismissed: the name is not tried again/,
    patch: (t) =>
      sub(t, "      { isCurrent: interaction.current },", "      {},"),
  },
  {
    id: "MU-1655",
    title:
      "WEB-08d R3 (revision 2): the retirement does not carry its interaction's withdraw signal (a dismissal cannot stop one waiting to be issued)",
    file: "src/features/settings/sessions-devices/RetireOtherDialog.tsx",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /not_sent held, Cancel\/Keep, then released/,
    patch: (t) =>
      sub(
        t,
        "        session.operations.retireOtherDevice(device, {\n          withdraw: interaction.withdraw,\n        }),",
        "        session.operations.retireOtherDevice(device),",
      ),
  },
  {
    id: "MU-1656",
    title:
      "WEB-08d A3 (revision 2): leaving the screen does not end its interactions (a sign-out refused before sending is tried again) (re-anchored r17: the unmount's end is interactionLifetime's endAll)",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /then the screen left: not tried again/,
    patch: (t) =>
      sub(
        t,
        "  const endAll = () => {\n    for (const interaction of [...open]) interaction.end();",
        "  const endAll = () => {\n    void open;",
      ),
  },
  {
    id: "MU-1657",
    title:
      "WEB-08d Q9 (revision 2): a password change refused before sending is tried again after its dialog was closed",
    file: "src/features/settings/signing-in/ChangePasswordForm.tsx",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /a password change refused before sending, its dialog closed/,
    patch: (t) =>
      sub(t, "      { isCurrent: interaction.current },", "      {},"),
  },
  {
    id: "MU-1658",
    title:
      "WEB-08d Q9 (revision 2): an identity removal refused before sending is tried again after the screen was left",
    file: "src/features/settings/signing-in/LinkedIdentities.tsx",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /an identity removal refused before sending, the screen unmounted/,
    patch: (t) =>
      sub(t, "      { isCurrent: interaction.current },", "      {},"),
  },
  {
    id: "MU-1659",
    title:
      "WEB-08d Q9 (revision 2): the account card's logout warning closes whichever one is open",
    file: "src/features/settings/account/AccountCard.tsx",
    tests: ["tests/features/settings/interaction-ownership.test.tsx"],
    expect: /the account card's logout warning/,
    patch: (t) =>
      sub(
        t,
        "            setLoggingOut((open) => (open === loggingOut ? null : open));",
        "            setLoggingOut(null);",
      ),
  },
  {
    id: "MU-1660",
    title:
      "WEB-08d R4 (revision 3): a password form's completion shows its outcome without asking whether it still owns it (a dismissed form announces)",
    file: "src/features/settings/signing-in/ChangePasswordForm.tsx",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect: /Close, then a refusal \(422\): no announcement/,
    patch: (t) =>
      sub(t, '    if (!owned) return setPhase({ kind: "idle" });\n', ""),
  },
  {
    id: "MU-1661",
    title:
      "WEB-08d R4 (revision 3): the password completion asks for ownership AFTER ending its interaction (a form still open never shows its outcome)",
    file: "src/features/settings/signing-in/ChangePasswordForm.tsx",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect: /control: left open, a refusal is shown and announced at once/,
    patch: (t) =>
      sub(
        t,
        "    const owned = interaction.current();\n    interaction.end();\n",
        "    interaction.end();\n    const owned = interaction.current();\n",
      ),
  },
  {
    id: "MU-1662",
    title:
      "WEB-08d R4 (revision 3): an interaction is owned by the account only (a new sign-in of the same account inherits an old answer)",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect:
      /password answer for an identity that moved on is not shown a new sign-in of the same account \(epoch\)/,
    patch: (t) =>
      sub(
        t,
        /identity \? `\$\{identity\.account_id\}:\$\{identity\.epoch\}` : null;/,
        "identity ? identity.account_id : null;",
      ),
  },
  {
    id: "MU-1663",
    title:
      "WEB-08d A4 (revision 3): Check now shows its answer without asking whether it still owns it (a dismissed check announces)",
    file: "src/features/settings/signing-in/Unconfirmed.tsx",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect:
      /dismissed \(Close\) while checking, a working session: nothing is said/,
    patch: (t) => sub(t, '    if (!owned) return setState("idle");\n', ""),
  },
  {
    id: "MU-1664",
    title:
      "WEB-08d R4 (revision 3): dismissing Signing in does not end its forms' interactions until they unmount (an answer in between is shown)",
    file: "src/features/settings/signing-in/SigningInDialog.tsx",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect:
      /arrives after Close is pressed, before the route has changed, is not shown/,
    patch: (t) => sub(t, "        scope.dismiss();\n", ""),
  },
  {
    id: "MU-1665",
    title:
      "WEB-08d R4 (revision 3): an interaction begun inside a dismissal scope is not tracked by it (the dismissal ends nothing)",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect:
      /arrives after Close is pressed, before the route has changed, is not shown/,
    patch: (t) => sub(t, "        dismissal?.track(interaction);\n", ""),
  },
  {
    id: "MU-1666",
    title:
      "WEB-08d A5 (revision 3): a linked-identity action that ends releases every action's progress",
    file: "src/features/settings/signing-in/LinkedIdentities.tsx",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect:
      /two removals in progress, X first answered: the other stays in progress/,
    patch: (t) =>
      sub(
        t,
        "      setPending((now) => without(now, key));",
        "      setPending(new Set());",
      ),
  },
  {
    id: "MU-1667",
    title:
      "WEB-08d A5 (revision 3): starting a linked-identity action clears every action's failure",
    file: "src/features/settings/signing-in/LinkedIdentities.tsx",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect: /starting a removal clears only its own earlier failure/,
    patch: (t) =>
      sub(
        t,
        "    setProblems((now) => {\n      const next = new Map(now);\n      next.delete(key);\n      return next;\n    });",
        "    setProblems(new Map());",
      ),
  },
  {
    id: "MU-1668",
    title:
      "WEB-08d A5 (revision 3): a removal shows its outcome after its identity moved on (no ownership check)",
    file: "src/features/settings/signing-in/LinkedIdentities.tsx",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect: /the identity moved on during a removal: another account/,
    patch: (t) =>
      sub(
        t,
        "    if (!finish(key, interaction)) return;",
        "    finish(key, interaction);",
      ),
  },
  {
    id: "MU-1669",
    title:
      "WEB-08d A5 (revision 3): a link shows its outcome after its identity moved on (no ownership check)",
    file: "src/features/settings/signing-in/LinkedIdentities.tsx",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect: /the identity moved on during a link: another account/,
    patch: (t) =>
      sub(
        t,
        '    if (!finish("link", interaction)) return;',
        '    finish("link", interaction);',
      ),
  },
  {
    id: "MU-1670",
    title:
      "WEB-08d A5 (revision 3): no synchronous per-action guard (a double press of Remove sends twice)",
    file: "src/features/settings/signing-in/LinkedIdentities.tsx",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect: /a double press of one Remove sends one request/,
    patch: (t) =>
      sub(t, "    if (actions.current.has(key)) return null;\n", ""),
  },
  {
    id: "MU-1671",
    title:
      "WEB-08d A4 (revision 3): no synchronous guard on Check now (a double press asks twice)",
    file: "src/features/settings/signing-in/Unconfirmed.tsx",
    tests: ["tests/features/settings/completion-ownership.test.tsx"],
    expect: /a double press of Check now, before Checking… renders, asks once/,
    patch: (t) =>
      sub(
        t,
        "    if (checking.current || !online || !isOnlineNow()) return;",
        "    if (!online || !isOnlineNow()) return;",
      ),
  },
  {
    id: "MU-1672",
    title:
      "WEB-08d Q8 (revision 4, WEB08D-NAVIGATION-FRESHNESS-20261011): a quiet refresh is not refused while one is outstanding (one return reads twice)",
    file: "src/features/settings/sessions-devices/useLoad.ts",
    tests: ["tests/features/settings/return-refresh.test.tsx"],
    expect:
      /overlapping notifications while the read is outstanding make no second read/,
    patch: (t) =>
      sub(
        t,
        '      shown.current.status !== "ready" ||\n      refreshing.current === generation.current\n',
        '      shown.current.status !== "ready"\n',
      ),
  },
  {
    id: "MU-1673",
    title:
      "WEB-08d Q8 (revision 4, WEB08D-NAVIGATION-FRESHNESS-20261011): a quiet refresh runs from an error too (a return reads in place of the error's Retry)",
    file: "src/features/settings/sessions-devices/useLoad.ts",
    tests: ["tests/features/settings/return-refresh.test.tsx"],
    expect: /a failed refresh shows the usual error and its Retry/,
    patch: (t) =>
      sub(
        t,
        '      shown.current.status !== "ready" ||\n      refreshing.current === generation.current\n',
        "      refreshing.current === generation.current\n",
      ),
  },
  {
    id: "MU-1674",
    title:
      "WEB-08d Q8 (revision 4, WEB08D-NAVIGATION-FRESHNESS-20261011): the return refresh shows the loading state (rows and the focused control are replaced)",
    file: "src/features/settings/sessions-devices/useLoad.ts",
    tests: ["tests/features/settings/return-refresh.test.tsx"],
    expect:
      /nothing is replaced by a loading state|keyboard focus on a row's control stays/,
    patch: (t) =>
      sub(
        t,
        "    refreshing.current = mine;\n",
        '    refreshing.current = mine;\n    setState({ status: "loading" });\n',
      ),
  },
  {
    id: "MU-1675",
    title:
      "WEB-08d Q8 (revision 4, WEB08D-NAVIGATION-FRESHNESS-20261011): a return-triggered answer is shown after the identity moved on",
    file: "src/features/settings/sessions-devices/useLoad.ts",
    tests: ["tests/features/settings/return-refresh.test.tsx"],
    expect: /arrives after the identity moved on is dropped/,
    patch: (t) =>
      sub(
        t,
        "    const current = () => mine === generation.current && isCurrent();\n",
        "    const current = () => mine === generation.current;\n",
      ),
  },
  {
    id: "MU-1676",
    title:
      "WEB-08d Q8 (revision 4, WEB08D-NAVIGATION-FRESHNESS-20261011): an older return-triggered answer replaces a newer read (no generation check)",
    file: "src/features/settings/sessions-devices/useLoad.ts",
    tests: ["tests/features/settings/return-refresh.test.tsx"],
    expect: /older return-triggered answer never replaces a newer read/,
    patch: (t) =>
      sub(
        t,
        "    const current = () => mine === generation.current && isCurrent();\n",
        "    const current = () => isCurrent();\n",
      ),
  },
  {
    id: "MU-1677",
    title:
      "WEB-08d Q8 (revision 4, WEB08D-NAVIGATION-FRESHNESS-20261011): every focus or visible notification reads (no departure is required: one return is several reads)",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/return-refresh.test.tsx"],
    expect: /a focus with no departure reads nothing/,
    patch: (t) =>
      sub(
        t,
        '      if (!away || document.visibilityState !== "visible") return;\n',
        '      if (document.visibilityState !== "visible") return;\n',
      ),
  },
  {
    id: "MU-1678",
    title:
      "WEB-08d Q8 (revision 4, WEB08D-NAVIGATION-FRESHNESS-20261011): a focus while the tab is hidden reads",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/return-refresh.test.tsx"],
    expect: /a focus while the tab is hidden reads nothing/,
    patch: (t) =>
      sub(
        t,
        '      if (!away || document.visibilityState !== "visible") return;\n',
        "      if (!away) return;\n",
      ),
  },
  {
    id: "MU-1679",
    title:
      "WEB-08d Q8 (revision 4, WEB08D-NAVIGATION-FRESHNESS-20261011): a return reads while the browser says it is offline",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/return-refresh.test.tsx"],
    expect: /while the browser says it is offline a return reads nothing/,
    patch: (t) =>
      sub(
        t,
        "      if (scope === null || !navigator.onLine) return;\n",
        "      if (scope === null) return;\n",
      ),
  },
  {
    id: "MU-1680",
    title:
      "WEB-08d Q8 (revision 4, WEB08D-NAVIGATION-FRESHNESS-20261011): the return listeners outlive the screen",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/return-refresh.test.tsx"],
    expect: /after the screen is left a return reads nothing/,
    patch: (t) =>
      sub(
        t,
        '      document.removeEventListener("visibilitychange", visibility);\n      window.removeEventListener("blur", leave);\n      window.removeEventListener("focus", back);\n',
        "",
      ),
  },
  {
    id: "MU-1681",
    title:
      "WEB-08d Q8 (revision 4, WEB08D-NAVIGATION-FRESHNESS-20261011): the devices list does not refresh on return",
    file: "src/features/settings/sessions-devices/DevicesSection.tsx",
    tests: ["tests/features/settings/return-refresh.test.tsx"],
    expect: /a change made elsewhere appears after the tab is visible again/,
    patch: (t) => sub(t, "  useReturnRefresh(refresh);\n", ""),
  },
  {
    id: "MU-1682",
    title:
      "WEB-08d Q8 (revision 4, WEB08D-NAVIGATION-FRESHNESS-20261011): the sessions list does not refresh on return",
    file: "src/features/settings/sessions-devices/SessionsSection.tsx",
    tests: ["tests/features/settings/return-refresh.test.tsx"],
    expect: /a change made elsewhere appears after the tab is visible again/,
    patch: (t) => sub(t, "  useReturnRefresh(refresh);\n", ""),
  },
  {
    id: "MU-1683",
    title:
      "WEB-08d review R6 (revision 8): a completed naming request closes the dialog whatever was typed since it was submitted",
    file: "src/features/settings/sessions-devices/NameDeviceDialog.tsx",
    tests: ["tests/features/settings/name-draft-ownership.test.tsx"],
    expect:
      /completes after a later edit keeps the dialog|an edit away and back is still a later draft|a not_sent retry keeps the submitted payload/,
    patch: (t) =>
      sub(t, "      if (revision.current === submitted) {\n", "      {\n"),
  },
  {
    id: "MU-1684",
    title:
      "WEB-08d review R6 (revision 8): an accepted edit does not move the draft's revision on",
    file: "src/features/settings/sessions-devices/NameDeviceDialog.tsx",
    tests: ["tests/features/settings/name-draft-ownership.test.tsx"],
    expect:
      /completes after a later edit keeps the dialog|an edit away and back is still a later draft|a not_sent retry keeps the submitted payload/,
    patch: (t) => sub(t, "            revision.current += 1;\n", ""),
  },
  {
    id: "MU-1685",
    title:
      "WEB-08d revision 17: every cleanup ends the interactions at once again (StrictMode's simulated unmount ends a press made before the effects ran)",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/interaction-lifetime.test.tsx"],
    expect:
      /a press before the component's effects ran keeps its interaction|StrictMode's simulated unmount/,
    patch: (t) =>
      sub(
        t,
        "        if (!development || !first || !sameTurn) return endAll();\n",
        "        return endAll();\n",
      ),
  },
  {
    id: "MU-1686",
    title:
      "WEB-08d revision 17: a genuine unmount in the turn of the first setup never ends its interactions",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/interaction-lifetime.test.tsx"],
    expect: /a genuine unmount in the turn of the first setup/,
    patch: (t) =>
      sub(
        t,
        "          if (detached) endAll();\n",
        "          if (false) endAll();\n",
      ),
  },
  {
    id: "MU-1687",
    title:
      "WEB-08d revision 17: a detached interaction is still current (an old answer could be shown or retried until the end of the turn)",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/interaction-lifetime.test.tsx"],
    expect: /a genuine unmount in the turn of the first setup/,
    patch: (t) =>
      sub(
        t,
        "        current: () => !detached && inner.current(),\n",
        "        current: () => inner.current(),\n",
      ),
  },
  {
    id: "MU-1688",
    title:
      "WEB-08d revision 17: production defers the end of a cleanup in its setup's turn as development does",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/interaction-lifetime.test.tsx"],
    expect: /production \(no simulated unmount\)/,
    patch: (t) =>
      sub(
        t,
        "        if (!development || !first || !sameTurn) return endAll();\n",
        "        if (!first || !sameTurn) return endAll();\n",
      ),
  },
  {
    id: "MU-1689",
    title:
      "WEB-08d revision 17: every cleanup in a setup's turn is taken for StrictMode's simulated one (a genuine same-turn unmount after its pass is deferred)",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/interaction-lifetime.test.tsx"],
    expect:
      /after StrictMode's pass, a genuine unmount in the same turn ends them at once|a genuine unmount ends the interaction at once/,
    patch: (t) =>
      sub(
        t,
        "        if (!development || !first || !sameTurn) return endAll();\n",
        "        if (!development || !sameTurn) return endAll();\n",
      ),
  },
  {
    id: "MU-1690",
    title:
      "WEB-08d revision 17: a genuine unmount in a later turn is deferred too (its interactions are not ended at once)",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/interaction-lifetime.test.tsx"],
    expect:
      /a cleanup in a later turn than its setup|a genuine unmount ends the interaction at once/,
    patch: (t) =>
      sub(
        t,
        "        if (!development || !first || !sameTurn) return endAll();\n",
        "        if (!development || !first) return endAll();\n",
      ),
  },
  {
    id: "MU-1691",
    title:
      "WEB-08d revision 17: a reconnect does not attach the interactions again (StrictMode's pass leaves them detached and they end)",
    file: "src/features/settings/sessions-devices/ownership.ts",
    tests: ["tests/features/settings/interaction-lifetime.test.tsx"],
    expect:
      /StrictMode's simulated unmount|a press before the component's effects ran keeps its interaction/,
    patch: (t) =>
      sub(
        t,
        "      detached = false;\n      setups += 1;\n",
        "      setups += 1;\n",
      ),
  },
  {
    id: "MU-1695",
    title:
      "WEB-08d review r25 R25-N2: the other-device confirmation never hears of connectivity (its subscription is a constant online)",
    file: "src/features/settings/sessions-devices/RetireOtherDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /other device RC4 /,
    patch: (t) =>
      sub(t, "  const online = useOnline();\n", "  const online = true;\n"),
  },
  {
    id: "MU-1696",
    title:
      "WEB-08d review r25 R25-N2: the other-device confirmation has no offline disabled state",
    file: "src/features/settings/sessions-devices/RetireOtherDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /other device RC4 /,
    patch: (t) =>
      sub(t, "          ) : !online ? (\n", "          ) : false ? (\n"),
  },
  {
    id: "MU-1697",
    title:
      "WEB-08d review r25 R25-N2: the other-device confirmation does not ask the browser at the moment of use",
    file: "src/features/settings/sessions-devices/RetireOtherDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /other device RC3 /,
    patch: (t) =>
      sub(
        t,
        "    if (inflight.current || !isOnlineNow() || !interaction.current()) return;\n",
        "    if (inflight.current || !interaction.current()) return;\n",
      ),
  },
  {
    id: "MU-1698",
    title:
      "WEB-08d review r25 R25-N2: this device's confirmation never hears of connectivity (its subscription is a constant online)",
    file: "src/features/settings/sessions-devices/WipeConfirmDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /current device RC4 |RC9 /,
    patch: (t) =>
      sub(t, "  const online = useOnline();\n", "  const online = true;\n"),
  },
  {
    id: "MU-1699",
    title:
      "WEB-08d review r25 R25-N2: this device's confirmation has no offline disabled state",
    file: "src/features/settings/sessions-devices/WipeConfirmDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /current device RC4 |RC9 |RC11 /,
    patch: (t) =>
      sub(
        t,
        "          {known && !busy && !offline ? (\n",
        "          {known && !busy ? (\n",
      ),
  },
  {
    id: "MU-1700",
    title:
      "WEB-08d review r25 R25-N2: this device's confirmation does not ask the browser at the moment of use",
    file: "src/features/settings/sessions-devices/WipeConfirmDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /current device RC3 /,
    patch: (t) =>
      sub(t, "    if (needsConnection && !isOnlineNow()) return;\n", ""),
  },
  {
    id: "MU-1701",
    title:
      "WEB-08d review r25 R25-N2: the online rule is not scoped to retirement: logging out is blocked offline too",
    file: "src/features/settings/sessions-devices/WipeConfirmDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /RC12 |RC13 /,
    patch: (t) =>
      sub(
        t,
        '  const needsConnection = kind === "retire";\n',
        "  const needsConnection = true;\n",
      ),
  },
  {
    id: "MU-1702",
    title:
      "WEB-08d review r25 R25-N2: the online rule is scoped to the wrong kind: logging out needs a connection and retiring this device does not",
    file: "src/features/settings/sessions-devices/WipeConfirmDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /current device RC[34] |RC12 |RC13 /,
    patch: (t) =>
      sub(
        t,
        '  const needsConnection = kind === "retire";\n',
        '  const needsConnection = kind === "logout";\n',
      ),
  },
  {
    id: "MU-1703",
    title:
      "WEB-08d review r25 R25-N2: the Retire opener does not ask the browser at the moment of use",
    file: "src/features/settings/sessions-devices/DevicesSection.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /RC2 /,
    patch: (t) =>
      sub(
        t,
        "                            if (navigator.onLine) openRetiring(row);\n",
        "                            openRetiring(row);\n",
      ),
  },
  {
    id: "MU-1704",
    title:
      "WEB-08d review r25 R25-N2: this device's confirmation can be begun twice while the first is being started",
    file: "src/features/settings/sessions-devices/WipeConfirmDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /current device RC6 /,
    patch: (t) =>
      sub(
        t,
        "    if (!known || inflight.current) return;\n",
        "    if (!known) return;\n",
      ),
  },
  {
    id: "MU-1705",
    title:
      "WEB-08d review r25 R25-N2: reconnecting confirms the other-device retirement by itself",
    file: "src/features/settings/sessions-devices/RetireOtherDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /other device RC5 /,
    patch: (t) =>
      sub(
        sub(
          t,
          'import { useRef, useState } from "react";',
          'import { useEffect, useRef, useState } from "react";',
        ),
        "  const inflight = useRef(false);\n",
        "  const inflight = useRef(false);\n  const sawOffline = useRef(false);\n  useEffect(() => {\n    if (!online) sawOffline.current = true;\n    else if (sawOffline.current) void confirm();\n  });\n",
      ),
  },
  {
    id: "MU-1706",
    title:
      "WEB-08d review r25 R25-N2: reconnecting confirms this device's retirement by itself",
    file: "src/features/settings/sessions-devices/WipeConfirmDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /current device RC5 /,
    patch: (t) =>
      sub(
        t,
        "  const offline = needsConnection && !online;\n",
        "  const offline = needsConnection && !online;\n  const sawOffline = useRef(false);\n  useEffect(() => {\n    if (offline) sawOffline.current = true;\n    else if (sawOffline.current && known && !busy) void confirm();\n  });\n",
      ),
  },
  {
    id: "MU-1707",
    title:
      "WEB-08d review r25 R25-N2: an applied answer of an other-device retirement no longer reads the lists again (the issued effect's reconciliation dropped)",
    file: "src/features/settings/sessions-devices/RetireOtherDialog.tsx",
    tests: ["tests/features/settings/retirement-connectivity.test.tsx"],
    expect: /other device RC6 |RC7 /,
    patch: (t) =>
      sub(
        t,
        "      reconcileLists(session, interaction.scope);\n",
        "      void 0;\n",
      ),
  },
];

export const ENGINE_LABELS = [
  {
    id: "MU-1692",
    title:
      "WEB-08d review r18 M1: (REAL ENGINE) the fixture entry marks every page ready as it starts, before an on-demand diagnostic page's code has even arrived",
    file: "src/fixture/main.tsx",
    spec: "tests/e2e/fixture.diagnostic-pages.spec.ts",
    grep: "diagnostic pages load on demand",
    expect: /not ready while its code is held/,
    patch: (t) =>
      sub(
        t,
        "document.documentElement.dataset.atlasFixture = ATLAS_FIXTURE_ONLY;\n",
        'document.documentElement.dataset.atlasFixture = ATLAS_FIXTURE_ONLY;\ndocument.documentElement.dataset.fixturePage = "ready";\n',
      ),
  },
  {
    id: "MU-1693",
    title:
      "WEB-08d review r18 M1: (REAL ENGINE) a diagnostic page marks itself ready in a layout effect, before its children's effects (the heading's focus) have run",
    file: "src/fixture/page-ready.tsx",
    spec: "tests/e2e/fixture.diagnostic-pages.spec.ts",
    grep: "diagnostic pages load on demand",
    expect:
      /(a neutral state|the sign-in-again form): not ready while its code is held/,
    patch: (t) =>
      sub(
        sub(
          t,
          'import { type ReactNode, useEffect } from "react";',
          'import { type ReactNode, useLayoutEffect } from "react";',
        ),
        "  useEffect(markFixturePageReady, []);",
        "  useLayoutEffect(markFixturePageReady, []);",
      ),
  },
  {
    id: "MU-1694",
    title:
      "WEB-08d review r18 M1: (REAL ENGINE) a gallery is marked ready once its code has arrived, before the boot screen is cleared and the gallery is mounted",
    file: "src/fixture/main.tsx",
    spec: "tests/e2e/fixture.diagnostic-pages.spec.ts",
    grep: "diagnostic pages load on demand",
    expect: /gallery: not ready while its code is held/,
    patch: (t) =>
      sub(
        sub(
          t,
          'import { FixturePageReady } from "./page-ready";',
          'import { FixturePageReady, markFixturePageReady } from "./page-ready";',
        ),
        "  void page.then((gallery) => {\n",
        "  void page.then((gallery) => {\n    markFixturePageReady();\n",
      ),
  },
  {
    id: "MU-1708",
    title:
      "WEB-08d review r25 R25-N2: (REAL ENGINE) the other-device confirmation has no offline disabled state",
    file: "src/features/settings/sessions-devices/RetireOtherDialog.tsx",
    spec: "tests/e2e/fixture.session-labels.spec.ts",
    grep: "L-5b real offline",
    expect: /L-5b real offline/,
    patch: (t) =>
      sub(t, "          ) : !online ? (\n", "          ) : false ? (\n"),
  },
  {
    id: "MU-1709",
    title:
      "WEB-08d review r25 R25-N2: (REAL ENGINE) this device's confirmation has no offline disabled state",
    file: "src/features/settings/sessions-devices/WipeConfirmDialog.tsx",
    spec: "tests/e2e/fixture.session-labels.spec.ts",
    grep: "L-5b real offline",
    expect: /L-5b real offline/,
    patch: (t) =>
      sub(
        t,
        "          {known && !busy && !offline ? (\n",
        "          {known && !busy ? (\n",
      ),
  },
];
