/**
 * `TaskDecimal` (the pinned contract): an exact decimal with at most six fractional digits, 0 to 1,000,000,000,000. Arithmetic is in
 * integer micro-units with `BigInt`, never floating point, exactly as the server does it (`crates/core/src/tasks/mod.rs`, `Decimal`).
 */
const PATTERN =
  /^(?:(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?|1000000000000(?:\.0{1,6})?)$/;
const SCALE = 1_000_000n;
/** The largest value the server accepts, in micro-units (also the bound of a running total). */
export const MAX_UNITS = 1_000_000_000_000n * SCALE;

export const isDecimal = (text: unknown): text is string =>
  typeof text === "string" && PATTERN.test(text);

/** Micro-units of a valid decimal, or null. */
export function toUnits(text: string): bigint | null {
  if (!isDecimal(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0") || "0");
}

/** The canonical text of a number of micro-units: no trailing fractional zeros, as the server writes it. */
export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / SCALE;
  const fraction = (magnitude % SCALE)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/**
 * What a person typed, made a contract decimal: surrounding spaces are dropped and a leading zero before a point is allowed ("0.5"),
 * nothing else is guessed (no commas, no exponents, no signs). `null`: not a value the contract accepts.
 */
export function parseDecimalInput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const units = toUnits(trimmed);
  return units === null ? null : fromUnits(units);
}
