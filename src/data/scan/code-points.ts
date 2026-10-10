/**
 * The number of code points in `text`, as JSON Schema `minLength` and `maxLength` count them (R38, revision 21). One definition for the
 * two decoders that bound a string by code points (a projection's `label` in `validate.ts`, the `/sync` cursor in `scan.ts`), so they
 * cannot disagree.
 *
 * A surrogate PAIR (a high surrogate immediately followed by a low one) is ONE code point. A surrogate that is not half of a pair, a high
 * one followed by anything else or a low one on its own, is a code point by itself, exactly as the string iterator (`[...text]`) counts it:
 * JSON escapes such a unit through `JSON.parse` unchanged, and treating "any high surrogate" as the start of a pair let `"\ud800a"`
 * repeated count as 151 code points when it holds 302.
 */
export function codePointCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}
