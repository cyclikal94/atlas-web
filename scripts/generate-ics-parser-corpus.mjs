#!/usr/bin/env node
// Writes tests/fixtures/ics-parser/ical-0.11.0.json (WEB-13b revision 14, review 15 R12): a corpus of `.ics` texts and what the server's
// own parser makes of each. The comparator is the exact dependency of the released backend (`ical = 0.11.0`, backend commit 4396c99,
// `crates/core/src/calendars/ics.rs` `parse`): one calendar, no second, and its `events.len()`. It is built offline from the local Cargo
// registry under a pinned lock, in a fresh temporary directory that is removed afterwards, and the file is laid out by Biome. `--check`
// rebuilds the results and compares them with the recorded file's content, changing nothing.
//
//   node scripts/generate-ics-parser-corpus.mjs [--check]
//
// Each case is a recipe (`parts`: strings, or `{ repeat, times }` where `repeat` is one template or a list used in turn, `{n}` the
// index), so a 257-event file is a line of JSON. The SHA-256 of every expanded text is recorded too: a test that expands a recipe
// differently from the text the parser read fails on the hash, not silently on a different input.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const recorded = join(root, "tests/fixtures/ics-parser/ical-0.11.0.json");
const check = process.argv.includes("--check");

const BACKEND = {
  repository: "atlas (backend)",
  release: "v0.29.0-rc.1",
  commit: "4396c99300d00798fc10e61d459f4d9fce699ee8",
  caller: "crates/core/src/calendars/ics.rs parse",
};

const H =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Atlas//ics corpus//EN\r\n";
const T = "END:VCALENDAR\r\n";
/** An event whose first line is `begin` (the variant under test). */
const ev = (begin) =>
  `${begin}\r\nUID:{n}@corpus.example\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY:Event {n}\r\nEND:VEVENT\r\n`;
const E = ev("BEGIN:VEVENT");
const many = (repeat, times) => ({ repeat, times });
const lf = (parts) =>
  parts.map((part) =>
    typeof part === "string"
      ? part.replaceAll("\r\n", "\n")
      : {
          ...part,
          repeat: [part.repeat]
            .flat()
            .map((template) => template.replaceAll("\r\n", "\n")),
        },
  );

/** Every way a component line can be written that the parser still reads as `BEGIN:VEVENT`. */
const VARIANTS = [
  ev("BEGIN:VEVENT"),
  ev("BEGIN:\r\n VEVENT"),
  ev("BEGIN:VE\r\n\tVENT"),
  ev("B\r\n EGIN:VEV\r\n ENT"),
  ev("BEGIN:\r\n\r\n VEVENT"),
  ev("BEGIN:VEVENT \t"),
  ev("BEGIN: \r\n VEVENT"),
  ev("BEGIN:VEVENT\u0085"),
  ev("BEGIN:VEVENT "),
  ev("BEGIN;X-A=1:VEVENT"),
  ev('BEGIN;X-A="a:b";X-B=c,d:VEVENT'),
  ev("BEGIN::VEVENT"),
  ev("begin:VEVENT"),
];

/**
 * Revision 15 (review 16 R13): the parameter rules the linear scanner keeps, each a component line the parser still reads as
 * `BEGIN:VEVENT` — a list then a quoted value, runs of `,` and `;`, empty values, `:` in a key, `=` in a value, delimiters inside quotes,
 * folded parameters, exactly ten listed values and many parameters.
 */
const PARAMETER_VARIANTS = [
  ev('BEGIN;X-A=a,"b:c":VEVENT'),
  ev("BEGIN;X-A=a,,,b;X-B=c:VEVENT"),
  ev("BEGIN;X-A=;X-B=:VEVENT"),
  ev("BEGIN;;;X-A=1:VEVENT"),
  ev("BEGIN;X:A=1:VEVENT"),
  ev("BEGIN;X-A=b=c:VEVENT"),
  ev('BEGIN;X-A="a,b";X-B="c;d":VEVENT'),
  ev("BEGIN;X-A=\r\n 1;X-\r\n\tB=2:VEV\r\n ENT"),
  ev("BEGIN;X-A=1,2,3,4,5,6,7,8,9,10:VEVENT"),
  ev(`BEGIN${";X=A".repeat(40)}:VEVENT`),
];

/** The review's shape (`;X=A` repeated), at a size the parser answers quickly; a repeat, so the recipe stays one line. */
const PARAMETERS = many(";X=A", 4000);
const EVENT_REST = "UID:p@corpus.example\r\nDTSTART;VALUE=DATE:20261101\r\n";

const OVERRIDES =
  "BEGIN:VEVENT\r\nUID:series@corpus.example\r\nDTSTART:20261101T090000Z\r\nRRULE:FREQ=DAILY;COUNT=5\r\nSUMMARY:Series\r\nEND:VEVENT\r\n" +
  "BEGIN:\r\n VEVENT\r\nUID:series@corpus.example\r\nRECURRENCE-ID:20261102T090000Z\r\nDTSTART:20261102T100000Z\r\nEND:VEVENT\r\n" +
  "BEG\r\n\tIN:VEVENT\r\nUID:series@corpus.example\r\nRECURRENCE-ID:20261103T090000Z\r\nDTSTART:20261103T100000Z\r\nEND:VEVENT\r\n";

const NESTED =
  "BEGIN:VTIMEZONE\r\nTZID:Europe/London\r\nBEGIN:STANDARD\r\nDTSTART:19701025T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0000\r\nEND:STANDARD\r\n" +
  "BEGIN:DAYLIGHT\r\nDTSTART:19700329T010000\r\nTZOFFSETFROM:+0000\r\nTZOFFSETTO:+0100\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n" +
  "BEGIN:VEVENT\r\nUID:alarm@corpus.example\r\nDTSTART:20261101T090000Z\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\n" +
  "BEGIN:VTODO\r\nUID:todo@corpus.example\r\nEND:VTODO\r\n";

const MARKERS_IN_TEXT =
  "BEGIN:VEVENT\r\nUID:text@corpus.example\r\nDTSTART;VALUE=DATE:20261101\r\nDESCRIPTION:Notes\r\n BEGIN:VEVENT\r\n" +
  'COMMENT:BEGIN:VEVENT\r\nX-NOTE;X-P="BEGIN:VEVENT":y\r\nX-MORE:x\r\n\tBEGIN:VCALENDAR\r\nEND:VEVENT\r\n';

/** `why` says what each case is for; `parts` is its text. */
const CASES = [
  { name: "plain-one", why: "control", parts: [H, many(E, 1), T] },
  { name: "plain-one-lf", why: "LF line ends", parts: lf([H, many(E, 1), T]) },
  { name: "plain-256", why: "event bound", parts: [H, many(E, 256), T] },
  { name: "plain-257", why: "one over", parts: [H, many(E, 257), T] },
  {
    name: "header-folded-space",
    why: "R12 header",
    parts: ["BEGIN:\r\n VCALENDAR\r\nVERSION:2.0\r\n", many(E, 1), T],
  },
  {
    name: "header-folded-tab",
    why: "tab continuation",
    parts: ["BEGIN:\r\n\tVCALENDAR\r\nVERSION:2.0\r\n", many(E, 1), T],
  },
  {
    name: "header-folded-in-name",
    why: "split in the name",
    parts: ["BEG\r\n IN:VCALENDAR\r\nVERSION:2.0\r\n", many(E, 1), T],
  },
  {
    name: "header-folded-in-value",
    why: "split in the value",
    parts: ["BEGIN:VCAL\r\n ENDAR\r\nVERSION:2.0\r\n", many(E, 1), T],
  },
  {
    name: "header-folded-many",
    why: "several folds",
    parts: [
      "B\r\n E\r\n\tG\r\n IN:\r\n VCAL\r\n ENDAR\r\nVERSION:2.0\r\n",
      many(E, 1),
      T,
    ],
  },
  {
    name: "header-folded-lf",
    why: "LF fold",
    parts: lf(["BEGIN:\r\n VCALENDAR\r\nVERSION:2.0\r\n", many(E, 1), T]),
  },
  {
    name: "header-trailing-space",
    why: "trailing white space",
    parts: ["BEGIN:VCALENDAR \t\r\nVERSION:2.0\r\n", many(E, 1), T],
  },
  {
    name: "header-after-blank-lines",
    why: "leading empty lines",
    parts: ["\r\n\r\n", H, many(E, 1), T],
  },
  {
    name: "events-folded-256",
    why: "R12 boundary",
    parts: [H, many(ev("BEGIN:\r\n VEVENT"), 256), T],
  },
  {
    name: "events-folded-257",
    why: "R12 bypass",
    parts: [H, many(ev("BEGIN:\r\n VEVENT"), 257), T],
  },
  {
    name: "events-folded-lf-257",
    why: "LF fold",
    parts: lf([H, many(ev("BEGIN:\r\n VEVENT"), 257), T]),
  },
  {
    name: "variants-256",
    why: "every variant, exact count",
    parts: [H, many(VARIANTS, 256), T],
  },
  {
    name: "variants-257",
    why: "every variant, one over",
    parts: [H, many(VARIANTS, 257), T],
  },
  ...VARIANTS.slice(1).map((template, at) => ({
    name: `variant-${at + 1}-257`,
    why: `one variant alone, one over: ${JSON.stringify(template.split("\r\nUID")[0])}`,
    parts: [H, many(template, 257), T],
  })),
  {
    name: "parameters-256",
    why: "R13: every parameter variant, exact count",
    parts: [H, many(PARAMETER_VARIANTS, 256), T],
  },
  {
    name: "parameters-257",
    why: "R13: every parameter variant, one over",
    parts: [H, many(PARAMETER_VARIANTS, 257), T],
  },
  ...PARAMETER_VARIANTS.map((template, at) => ({
    name: `parameter-${at + 1}-257`,
    why: `R13: one parameter variant alone, one over: ${JSON.stringify(template.split("\r\nUID")[0])}`,
    parts: [H, many(template, 257), T],
  })),
  {
    name: "parameters-summary-many",
    why: "R13: an ordinary property with 4,000 parameters",
    parts: [
      H,
      `BEGIN:VEVENT\r\n${EVENT_REST}SUMMARY`,
      PARAMETERS,
      ":Review\r\nEND:VEVENT\r\n",
      T,
    ],
  },
  {
    name: "parameters-begin-many",
    why: "R13: a component line with 4,000 parameters",
    parts: [
      H,
      "BEGIN",
      PARAMETERS,
      `:VEVENT\r\n${EVENT_REST}SUMMARY:Review\r\nEND:VEVENT\r\n`,
      T,
    ],
  },
  {
    name: "end-eleven-values-then-gap",
    why: "R13: the ten-value limit — the calendar's END with eleven listed values still parses and closes it, so the gap ends the reading",
    parts: [
      H,
      many(E, 1),
      "END;X-A=1,2,3,4,5,6,7,8,9,10,11\r\n",
      "\u000b\r\n",
      many(E, 257),
      T,
    ],
  },
  {
    name: "end-parameters-then-gap",
    why: "R13: the calendar's END with quoted and listed parameters closes it",
    parts: [
      H,
      many(E, 1),
      'END;X-A="a:b";X-B=c,d:VCALENDAR\r\n',
      "\u000b\r\n",
      many(E, 257),
      T,
    ],
  },
  {
    name: "overrides-folded",
    why: "overrides are components",
    parts: [H, OVERRIDES, T],
  },
  {
    name: "nested-components",
    why: "only VEVENTs count",
    parts: [H, NESTED, T],
  },
  {
    name: "markers-in-text",
    why: "markers inside property text",
    parts: [H, MARKERS_IN_TEXT, T],
  },
  {
    name: "gap-after-end",
    why: "the parser stops at a gap after the calendar",
    parts: [H, many(E, 1), T, "\u000b\r\n", many(E, 257), T],
  },
  {
    name: "crcrlf-after-end",
    why: "the same gap written \\r\\r\\n",
    parts: [H, many(E, 1), T, "\r\r\n", many(E, 257), T],
  },
  {
    name: "stray-end-then-gap",
    why: "any END closes the calendar",
    parts: [H, many(E, 2), "END:VEVENT\r\n", "\u000b\r\n", many(E, 257), T],
  },
  {
    name: "gap-inside-calendar",
    why: "refused by the parser",
    parts: [H, "\u000b\r\n", many(E, 257), T],
  },
  {
    name: "gap-after-event",
    why: "refused by the parser: only the calendar's END ends the reading",
    parts: [H, many(E, 1), "\u000b\r\n", many(E, 257), T],
  },
  {
    name: "gap-before-header",
    why: "refused by the parser",
    parts: ["\u000b\r\n", H, many(E, 1), T],
  },
  {
    name: "header-continued",
    why: "refused by the parser",
    parts: ["BEGIN:VCALENDAR\r\n X-JUNK\r\nVERSION:2.0\r\n", many(E, 1), T],
  },
  {
    name: "header-leading-space",
    why: "refused by the parser",
    parts: [` ${H}`, many(E, 1), T],
  },
  {
    name: "header-lower-case",
    why: "refused by the parser",
    parts: [H.replace("BEGIN:VCALENDAR", "begin:vcalendar"), many(E, 1), T],
  },
  {
    name: "second-calendar",
    why: "refused by the backend",
    parts: [H, many(E, 1), T, H, many(E, 1), T],
  },
  {
    name: "value-lower-case-257",
    why: "refused by the parser",
    parts: [H, many(ev("BEGIN:vevent"), 257), T],
  },
  {
    name: "event-continued",
    why: "refused by the parser",
    parts: [H, many(ev("BEGIN:VEVENT\r\n X"), 2), T],
  },
  {
    name: "fold-two-spaces",
    why: "refused by the parser",
    parts: [H, many(ev("BEGIN:\r\n  VEVENT"), 2), T],
  },
  {
    name: "trailing-feff",
    why: "refused by the parser",
    parts: [H, many(ev("BEGIN:VEVENT﻿"), 2), T],
  },
  {
    name: "unclosed-quote",
    why: "refused by the parser",
    parts: [H, many(ev('BEGIN;X-A="a:VEVENT'), 2), T],
  },
  { name: "not-calendar", why: "refused by the parser", parts: ["hello\n"] },
  { name: "empty", why: "refused by the parser", parts: [""] },
];

/** The text of a recipe (the test has the same few lines). */
function expand(parts) {
  let text = "";
  for (const part of parts) {
    if (typeof part === "string") text += part;
    else {
      const templates = [part.repeat].flat();
      for (let n = 0; n < part.times; n += 1)
        text += (templates[n % templates.length] ?? "").replaceAll(
          "{n}",
          String(n),
        );
    }
  }
  return text;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const CARGO_TOML =
  '[package]\nname = "atlas-ics-parser-corpus"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nical = "=0.11.0"\n';
// Review 15's preserved comparator lock (`ics-parser-Cargo.lock`), the package renamed: the same seven crates and checksums.
const CARGO_LOCK = `# This file is automatically @generated by Cargo.
# It is not intended for manual editing.
version = 4

[[package]]
name = "atlas-ics-parser-corpus"
version = "0.1.0"
dependencies = [
 "ical",
]

[[package]]
name = "ical"
version = "0.11.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "9b7cab7543a8b7729a19e2c04309f902861293dcdae6558dfbeb634454d279f6"
dependencies = [
 "thiserror",
]

[[package]]
name = "proc-macro2"
version = "1.0.107"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "985e7ec9bb745e6ce6535b544d84d6cd6f7ad8bd711c398938ae983b91a766d9"
dependencies = [
 "unicode-ident",
]

[[package]]
name = "quote"
version = "1.0.47"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "1fbf4db142a473a8d80c26bbf18454ed458bf8d26c8219c331daecfdbd079001"
dependencies = [
 "proc-macro2",
]

[[package]]
name = "syn"
version = "2.0.119"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "872831b642d1a07999a962a351ed35b955ea2cfc8f3862091e2a240a84f17297"
dependencies = [
 "proc-macro2",
 "quote",
 "unicode-ident",
]

[[package]]
name = "thiserror"
version = "1.0.69"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "b6aaf5339b578ea85b50e080feb250a3e8ae8cfcdff9a461c9ec2904bc923f52"
dependencies = [
 "thiserror-impl",
]

[[package]]
name = "thiserror-impl"
version = "1.0.69"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "4fee6c4efc90059e10f81e6d42c60a18f76588c3d74cb83a0b242a2b6c7504c1"
dependencies = [
 "proc-macro2",
 "quote",
 "syn",
]

[[package]]
name = "unicode-ident"
version = "1.0.24"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "e6e4313cd5fcd3dad5cafa179702e2b244f760991f45397d14d4ebf38247da75"
`;
// As `ics.rs` reads it: the first calendar, then whether a second follows.
const MAIN_RS = `use std::{fs, io::BufReader};

fn main() {
    for path in std::env::args().skip(1) {
        let text = fs::read_to_string(&path).unwrap();
        let mut calendars = ical::IcalParser::new(BufReader::new(text.as_bytes()));
        let outcome = match calendars.next() {
            None => "none\\t".to_string(),
            Some(Err(error)) => format!("error\\t{}", error),
            Some(Ok(calendar)) => match calendars.next() {
                None => format!("ok\\t{}", calendar.events.len()),
                Some(_) => format!("second\\t{}", calendar.events.len()),
            },
        };
        println!("{}\\t{}", path, outcome.replace('\\n', " "));
    }
}
`;

function run(command, args, options) {
  const out = spawnSync(command, args, { encoding: "utf8", ...options });
  if (out.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} exited ${out.status}\n${out.stderr}`,
    );
  return out.stdout;
}

const work = mkdtempSync(join(tmpdir(), "atlas-ics-parser-corpus-"));
let corpus;
try {
  mkdirSync(join(work, "src"));
  mkdirSync(join(work, "cases"));
  writeFileSync(join(work, "Cargo.toml"), CARGO_TOML);
  writeFileSync(join(work, "Cargo.lock"), CARGO_LOCK);
  writeFileSync(join(work, "src/main.rs"), MAIN_RS);
  const files = CASES.map(({ name, parts }) => {
    const file = join(work, "cases", `${name}.ics`);
    writeFileSync(file, Buffer.from(expand(parts), "utf8"));
    return file;
  });
  const manifest = join(work, "Cargo.toml");
  const env = { ...process.env, CARGO_TARGET_DIR: join(work, "target") };
  const metadata = JSON.parse(
    run(
      "cargo",
      [
        "metadata",
        "--offline",
        "--locked",
        "--format-version",
        "1",
        "--manifest-path",
        manifest,
      ],
      { env },
    ),
  );
  const ical = metadata.packages.find(
    (p) => p.name === "ical" && p.version === "0.11.0",
  );
  if (ical === undefined) throw new Error("ical 0.11.0 is not resolved");
  const source = dirname(ical.manifest_path);
  const parserFiles = Object.fromEntries(
    [
      "src/line.rs",
      "src/property.rs",
      "src/parser/mod.rs",
      "src/parser/ical/mod.rs",
      "src/parser/ical/component.rs",
    ].map((file) => [file, sha256(readFileSync(join(source, file), "utf8"))]),
  );
  const output = run(
    "cargo",
    [
      "run",
      "--offline",
      "--locked",
      "--quiet",
      "--manifest-path",
      manifest,
      "--",
      ...files,
    ],
    { env },
  );
  const results = new Map();
  for (const line of output.trim().split("\n")) {
    const [file, status, detail] = line.split("\t");
    results.set(file, { status, detail });
  }
  corpus = {
    source: {
      ...BACKEND,
      parser: "ical 0.11.0 (IcalParser: LineReader, PropertyParser)",
      parser_files_sha256: parserFiles,
      cargo_lock_sha256: sha256(CARGO_LOCK),
      generator: "scripts/generate-ics-parser-corpus.mjs",
      note: "status ok: one calendar and no second (events = events.len()); none, error or second: the server refuses the file (invalid_ics). Reference evidence of the parser, not a backend import run.",
    },
    cases: CASES.map(({ name, why, parts }, at) => {
      const result = results.get(files[at]);
      if (result === undefined) throw new Error(`no result for ${name}`);
      const text = expand(parts);
      return {
        name,
        why,
        parts,
        sha256: sha256(text),
        parser:
          result.status === "ok"
            ? { status: "ok", events: Number(result.detail) }
            : { status: result.status, detail: result.detail || undefined },
      };
    }),
  };
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (check) {
  // The recorded file is laid out by the repository's formatter, so its CONTENT is compared, not its bytes.
  const same =
    JSON.stringify(JSON.parse(readFileSync(recorded, "utf8"))) ===
    JSON.stringify(corpus);
  console.log(
    same
      ? `${corpus.cases.length} cases match ${recorded}`
      : `DIFFERS from ${recorded}`,
  );
  process.exit(same ? 0 : 1);
}
mkdirSync(dirname(recorded), { recursive: true });
writeFileSync(recorded, `${JSON.stringify(corpus, null, 2)}\n`);
run(join(root, "node_modules/.bin/biome"), ["format", "--write", recorded], {
  cwd: root,
});
console.log(`wrote ${corpus.cases.length} cases to ${recorded}`);
