/**
 * WCAG 2.x relative luminance and contrast ratio, used by tests and the token-documentation generator. A token value may be
 * written as hex, `rgb()`, `hsl()` or `oklch()` (the formats tweakcn exports); everything is converted to sRGB first.
 */

export function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`Not a six-digit hex colour: ${hex}`);
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp = (value: number) => Math.min(255, Math.max(0, Math.round(value)));
const toHexString = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const gamma = (v: number) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

/** OKLCH (CSS Color 4) to sRGB, clipped to the gamut. */
function oklchToRgb(
  L: number,
  C: number,
  hDeg: number,
): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [gamma(r) * 255, gamma(g) * 255, gamma(bl) * 255];
}

const number = (raw: string, unit: "percent" | "plain" = "plain"): number => {
  const trimmed = raw.trim();
  if (trimmed.endsWith("%"))
    return unit === "percent"
      ? Number.parseFloat(trimmed) / 100
      : Number.parseFloat(trimmed) / 100;
  return Number.parseFloat(trimmed);
};

/** Any supported colour notation as six-digit upper-case hex. Throws on anything else, so a bad token fails loudly. */
export function toHex(colour: string): string {
  const value = colour.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(value))
    return `#${value
      .slice(1)
      .split("")
      .map((c) => c + c)
      .join("")}`.toUpperCase();
  const fn = /^(oklch|hsl|rgb)a?\((.+)\)$/i.exec(value);
  if (!fn?.[1] || !fn[2]) throw new Error(`Unsupported colour: ${colour}`);
  const parts = fn[2]
    .split("/")[0]
    ?.trim()
    .split(/[\s,]+/)
    .filter(Boolean) as string[];
  const [p0 = "0", p1 = "0", p2 = "0"] = parts;
  switch (fn[1].toLowerCase()) {
    case "oklch": {
      const L = p0.endsWith("%") ? number(p0) : Number.parseFloat(p0);
      const C = p1.endsWith("%") ? number(p1) * 0.4 : Number.parseFloat(p1);
      const H = Number.parseFloat(p2) || 0;
      return toHexString(...oklchToRgb(L, C, H));
    }
    case "hsl":
      return toHexString(
        ...hslToRgb(Number.parseFloat(p0) || 0, number(p1), number(p2)),
      );
    default:
      return toHexString(
        p0.endsWith("%") ? number(p0) * 255 : Number.parseFloat(p0),
        p1.endsWith("%") ? number(p1) * 255 : Number.parseFloat(p1),
        p2.endsWith("%") ? number(p2) * 255 : Number.parseFloat(p2),
      );
  }
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(colour: string): number {
  const [r, g, b] = parseHex(toHex(colour));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
