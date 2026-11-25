// Small numeric helpers shared by the browser SDK and the API. Kept dependency-free
// and mirrored 1:1 in model/stringbow_model/features.py (a parity test checks both).

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Population standard deviation (ddof = 0), matching numpy's default. */
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

/** Linear-interpolated quantile, same definition as numpy.quantile(..., method="linear"). */
export function quantile(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (!n) return 0;
  if (n === 1) return sortedAsc[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const f = pos - lo;
  return sortedAsc[lo] * (1 - f) + sortedAsc[hi] * f;
}

export function quantiles(xs: number[], qs: readonly number[]): number[] {
  const s = [...xs].sort((a, b) => a - b);
  return qs.map((q) => quantile(s, q));
}

export function median(xs: number[]): number {
  return quantiles(xs, [0.5])[0];
}

export function cv(xs: number[]): number {
  const m = mean(xs);
  return m > 0 ? sd(xs) / m : 0;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function round(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
