import { createHash } from "node:crypto";
import corpus from "../fixtures/ics-parser/ical-0.11.0.json" with {
  type: "json",
};

/**
 * WEB-13b revision 14 (review 15 R12): the `.ics` corpus and what the server's own parser (`ical` 0.11.0, written by
 * `scripts/generate-ics-parser-corpus.mjs`) made of each text. A recipe is expanded as the generator expands it, and the text's hash is
 * checked to be the one the parser read, so a test can never check a different input from the one the parser answered for. No test
 * runner is imported: the jsdom tests and the native specs use it alike.
 */
export type CorpusCase = (typeof corpus.cases)[number];
type Part = string | { repeat: string | string[]; times: number };

export const corpusCases: readonly CorpusCase[] = corpus.cases;
export const corpusSource = corpus.source;

function expand(parts: readonly Part[]): string {
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

/** The case's text; throws when its hash is not the one the parser read (the recipe and the recorded answer have drifted apart). */
export function corpusText(entry: CorpusCase | string): string {
  const found =
    typeof entry === "string"
      ? corpus.cases.find((candidate) => candidate.name === entry)
      : entry;
  if (found === undefined) throw new Error(`no corpus case ${String(entry)}`);
  const text = expand(found.parts as Part[]);
  const hash = createHash("sha256").update(text).digest("hex");
  if (hash !== found.sha256)
    throw new Error(
      `corpus case ${found.name}: ${hash} is not ${found.sha256}`,
    );
  return text;
}

/** The parser's count for a case it accepts (one calendar, no second). */
export function parserEvents(name: string): number {
  const found = corpus.cases.find((candidate) => candidate.name === name);
  if (found?.parser.status !== "ok")
    throw new Error(`the parser refuses ${name}`);
  return (found.parser as { events: number }).events;
}
