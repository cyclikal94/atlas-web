/**
 * A greedy pairwise (2-way) covering-array generator. The default suite runs a pairwise selection of each scenario
 * matrix: every PAIR of parameter values appears in at least one scenario. The full run enumerates everything.
 */
export function allCombinations<T extends Record<string, readonly unknown[]>>(
  factors: T,
): Array<{ [K in keyof T]: T[K][number] }> {
  const keys = Object.keys(factors);
  let out: Array<Record<string, unknown>> = [{}];
  for (const key of keys) {
    const next: Array<Record<string, unknown>> = [];
    for (const partial of out)
      for (const value of factors[key] as readonly unknown[])
        next.push({ ...partial, [key]: value });
    out = next;
  }
  return out as Array<{ [K in keyof T]: T[K][number] }>;
}

export function pairwise<T extends Record<string, readonly unknown[]>>(
  factors: T,
  seed = 1,
): Array<{ [K in keyof T]: T[K][number] }> {
  const keys = Object.keys(factors);
  const values = keys.map((key) => factors[key] as readonly unknown[]);
  // All pairs that must be covered: (factor i, value a, factor j, value b) for i < j.
  const uncovered = new Set<string>();
  for (let i = 0; i < keys.length; i += 1)
    for (let j = i + 1; j < keys.length; j += 1)
      for (let a = 0; a < (values[i] as readonly unknown[]).length; a += 1)
        for (let b = 0; b < (values[j] as readonly unknown[]).length; b += 1)
          uncovered.add(`${i}:${a}|${j}:${b}`);
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rows: number[][] = [];
  while (uncovered.size > 0) {
    // Build a row greedily: seed with one uncovered pair, then pick each remaining factor to cover the most pairs.
    const [first] = uncovered;
    const [left, right] = (first as string).split("|");
    const [i, a] = (left as string).split(":").map(Number) as [number, number];
    const [j, b] = (right as string).split(":").map(Number) as [number, number];
    const row: number[] = new Array(keys.length).fill(-1);
    row[i] = a;
    row[j] = b;
    const order = keys
      .map((_, index) => index)
      .filter((index) => row[index] === -1);
    for (let n = order.length - 1; n > 0; n -= 1) {
      const m = Math.floor(random() * (n + 1));
      [order[n], order[m]] = [order[m] as number, order[n] as number];
    }
    for (const factor of order) {
      let best = 0;
      let bestScore = -1;
      for (
        let candidate = 0;
        candidate < (values[factor] as readonly unknown[]).length;
        candidate += 1
      ) {
        let score = 0;
        for (let other = 0; other < keys.length; other += 1) {
          if (other === factor || row[other] === -1) continue;
          const [lo, hi] = other < factor ? [other, factor] : [factor, other];
          const key =
            other < factor
              ? `${lo}:${row[other]}|${hi}:${candidate}`
              : `${lo}:${candidate}|${hi}:${row[other]}`;
          if (uncovered.has(key)) score += 1;
        }
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      row[factor] = best;
    }
    for (let x = 0; x < keys.length; x += 1)
      for (let y = x + 1; y < keys.length; y += 1)
        uncovered.delete(`${x}:${row[x]}|${y}:${row[y]}`);
    rows.push(row);
  }
  return rows.map((row) =>
    Object.fromEntries(
      keys.map((key, index) => [
        key,
        (values[index] as readonly unknown[])[row[index] as number],
      ]),
    ),
  ) as Array<{
    [K in keyof T]: T[K][number];
  }>;
}
