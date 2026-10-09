// Deterministic string similarity used by onboarding (name match) and dedup.

export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function jaro(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 1 : 1;
  if (a.length === 0 || b.length === 0) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  t /= 2;
  return (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
}

export function jaroWinkler(a: string, b: string, p = 0.1): number {
  const j = jaro(a, b);
  let l = 0;
  while (l < 4 && l < a.length && l < b.length && a[l] === b[l]) l++;
  return j + l * p * (1 - j);
}

/** Optimal string alignment distance: insert, delete, substitute, adjacent transposition. */
export function osaDistance(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d.push([i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** American Soundex (e.g. Robert → R163). */
export function soundex(word: string): string {
  const s = stripDiacritics(word).toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  const codes: Record<string, string> = {
    B: '1', F: '1', P: '1', V: '1',
    C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
    D: '3', T: '3', L: '4', M: '5', N: '5', R: '6',
  };
  let out = s[0];
  let last = codes[s[0]] ?? '';
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const ch = s[i];
    const c = codes[ch] ?? '';
    if (c && c !== last) out += c;
    if (ch !== 'H' && ch !== 'W') last = c;
  }
  return out.padEnd(4, '0');
}

/**
 * Token-set similarity of two business names in [0, 1]: lowercase, strip diacritics and
 * punctuation, drop legal-form words, then 2·matched / (|A| + |B|) where a token matches
 * if some token of the other name has Jaro-Winkler ≥ 0.92 (tolerates one typo).
 */
const NAME_STOPWORDS = new Set(['ltd', 'limited', 'co', 'company', 'the', 'and', 'enterprises', 'enterprise', 'ventures', 'plc', 'k']);

export function nameTokens(name: string): string[] {
  const s = stripDiacritics(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/'s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const toks = s.split(/\s+/).filter((t) => t && !NAME_STOPWORDS.has(t));
  return [...new Set(toks)].sort();
}

export function tokenSetSimilarity(a: string, b: string): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const used = new Set<number>();
  let matched = 0;
  for (const x of ta) {
    let best = -1;
    let bestScore = 0;
    tb.forEach((y, j) => {
      if (used.has(j)) return;
      const s = x === y ? 1 : jaroWinkler(x, y);
      if (s > bestScore) {
        bestScore = s;
        best = j;
      }
    });
    if (best >= 0 && bestScore >= 0.92) {
      used.add(best);
      matched++;
    }
  }
  return (2 * matched) / (ta.length + tb.length);
}

/** Standard Levenshtein distance: insert, delete, substitute. */
export function levenshtein(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d.push([i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[a.length][b.length];
}

