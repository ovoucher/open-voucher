// Fixed-point amounts. Every voucher and USDC amount is an integer number of stroops
// (7 decimals), held as bigint so sums over thousands of payments never drift.

export const DECIMALS = 7;
export const STROOPS_PER_UNIT = 10_000_000n;
/** Largest amount a classic Stellar payment can carry (int64 stroops). */
export const MAX_AMOUNT = 9_223_372_036_854_775_807n;

const AMOUNT_RE = /^(-)?(\d{1,13})(?:\.(\d{1,7}))?$/;

/**
 * Parses a decimal string ("4.50", "212.4", "1.391", "-0.5") into stroops.
 * Accepts at most 7 decimals, as the network does; anything else throws.
 */
export function parseAmount(input: string): bigint {
  const s = String(input).trim().replace(/_/g, '');
  const m = AMOUNT_RE.exec(s);
  if (!m) throw new Error(`invalid amount "${input}" (use digits with at most ${DECIMALS} decimals)`);
  const whole = BigInt(m[2]);
  const frac = BigInt((m[3] ?? '').padEnd(DECIMALS, '0'));
  const v = whole * STROOPS_PER_UNIT + frac;
  return m[1] ? -v : v;
}

/** Parses a strictly positive amount (CLI input). */
export function parsePositiveAmount(input: string): bigint {
  const v = parseAmount(input);
  if (v <= 0n) throw new Error(`amount must be greater than zero, got "${input}"`);
  return v;
}

/** Formats stroops with all 7 decimals, the form the Stellar SDK expects ("4.5000000"). */
export function toStellarAmount(stroops: bigint): string {
  const neg = stroops < 0n;
  const a = neg ? -stroops : stroops;
  const whole = a / STROOPS_PER_UNIT;
  const frac = (a % STROOPS_PER_UNIT).toString().padStart(DECIMALS, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Human format: at least 2 decimals, trailing zeros beyond that trimmed ("4.50", "1.391"). */
export function formatAmount(stroops: bigint): string {
  const full = toStellarAmount(stroops);
  const [w, f] = full.split('.');
  let frac = f.replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${w}.${frac}`;
}

/** USD value rounded half-up to cents, as a display string with thousands separators. */
export function formatUsd(stroops: bigint): string {
  const cents = (stroops * 100n + (stroops >= 0n ? STROOPS_PER_UNIT / 2n : -STROOPS_PER_UNIT / 2n)) / STROOPS_PER_UNIT;
  const neg = cents < 0n;
  const c = neg ? -cents : cents;
  const whole = (c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}.${(c % 100n).toString().padStart(2, '0')}`;
}

/** Converts a KES price to USD at `rate` KES per USD, rounded half-up to `dp` decimals. */
export function kesToUsd(kes: number, rate: number, dp = 3): bigint {
  const scale = 10 ** dp;
  const usd = Math.round((kes / rate) * scale + 1e-9) / scale;
  return parseAmount(usd.toFixed(dp));
}

export function sum(values: Iterable<bigint>): bigint {
  let t = 0n;
  for (const v of values) t += v;
  return t;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
