// Within-programme duplicate detection (heuristic, deterministic).
//
// Normalise → block → score → band. Blocking keys: (location, surname Soundex),
// last 7 phone digits, and national-ID deletion neighbourhoods (catches IDs within one
// edit, including an adjacent transposition). Score = weighted Jaro-Winkler name (0.45)
// + phone exact after E.164 (0.25) + DOB exact or day/month swap (0.15) + ID within one
// edit (0.15), renormalised over the fields present on both rows.
import { jaroWinkler, osaDistance, soundex, stripDiacritics } from '../strings.js';

export interface DedupRow {
  rowId: string;
  fullName: string;
  dob?: string;
  phone?: string;
  nationalId?: string;
  householdSize?: number;
  location: string;
}

export type Band = 'likely_same' | 'review';

export interface DedupPair {
  a: string;
  b: string;
  score: number;
  band: Band;
  reasons: string[];
}

export const WEIGHTS = { name: 0.45, phone: 0.25, dob: 0.15, id: 0.15 } as const;
export const LIKELY_SAME = 0.85;
export const REVIEW = 0.55;

/** Spelling / transliteration variants mapped to one canonical token. */
export const TRANSLITERATION: Record<string, string> = {
  mohamed: 'muhammad', mohammed: 'muhammad', mohamad: 'muhammad', mohammad: 'muhammad',
  muhamed: 'muhammad', muhammed: 'muhammad', mahamed: 'muhammad',
  husein: 'hussein', hussain: 'hussein', husain: 'hussein', hussien: 'hussein',
  ahmad: 'ahmed', ahmet: 'ahmed',
  abdulahi: 'abdullahi', abdillahi: 'abdullahi',
  fatima: 'fatuma', fatouma: 'fatuma',
  kadija: 'khadija', khadijah: 'khadija', hadija: 'khadija',
  yussuf: 'yusuf', yousuf: 'yusuf', yousef: 'yusuf', yosef: 'yusuf',
  ibraahim: 'ibrahim', ebrahim: 'ibrahim',
  abdurahman: 'abdirahman', abdirahmaan: 'abdirahman', abdulrahman: 'abdirahman',
  maryam: 'mariam', mariama: 'mariam',
  nyakwoth: 'nyakuoth',
};

export interface NormalisedRow {
  rowId: string;
  tokens: string[];
  surname: string;
  dob?: { y: number; m: number; d: number };
  phone?: string;
  nationalId?: string;
  location: string;
  translit: string[];
}

export function nameTokens(fullName: string): { tokens: string[]; translit: string[] } {
  const raw = stripDiacritics(fullName)
    .toLowerCase()
    .replace(/['’`.]/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const translit: string[] = [];
  const tokens = raw.map((t) => {
    const c = TRANSLITERATION[t];
    if (c && c !== t) translit.push(`${t}→${c}`);
    return c ?? t;
  });
  return { tokens, translit };
}

export function parseDob(s: string | undefined): { y: number; m: number; d: number } | undefined {
  if (!s) return undefined;
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  return undefined;
}

/** Kenyan numbers to E.164: 07…/01…, 2547…, +2547…, with or without spaces. */
export function e164(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/[^\d]/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `+254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return `+${digits}`;
  if (/^[17]\d{8}$/.test(digits)) return `+254${digits}`;
  return undefined;
}

/** Kenyan national ID (7-8 digits) or refugee id (RF + 8 digits); anything else is malformed. */
export function normaliseId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const t = id.trim().toUpperCase().replace(/[\s-]/g, '');
  if (/^\d{7,8}$/.test(t) || /^RF\d{8}$/.test(t)) return t;
  return undefined;
}

export function normaliseRow(r: DedupRow): NormalisedRow {
  const { tokens, translit } = nameTokens(r.fullName);
  return {
    rowId: r.rowId.trim(),
    tokens: [...tokens].sort(),
    surname: tokens[tokens.length - 1] ?? '',
    dob: parseDob(r.dob),
    phone: e164(r.phone),
    nationalId: normaliseId(r.nationalId),
    location: r.location.trim().toUpperCase(),
    translit,
  };
}

/** Token-level Jaro-Winkler: mean best match of the shorter name, scaled by token-count overlap. */
export function nameSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.join(' ') === b.join(' ')) return 1;
  const directed = (s: string[], l: string[]): number => {
    let total = 0;
    for (const x of s) {
      let best = 0;
      for (const y of l) best = Math.max(best, x === y ? 1 : jaroWinkler(x, y));
      total += best;
    }
    return (total / s.length) * Math.sqrt((2 * s.length) / (s.length + l.length));
  };
  // symmetric: the shorter name is matched into the longer; equal lengths take the better direction
  if (a.length < b.length) return directed(a, b);
  if (b.length < a.length) return directed(b, a);
  return Math.max(directed(a, b), directed(b, a));
}

function idKeys(id: string): string[] {
  const keys = new Set<string>([id]);
  for (let i = 0; i < id.length; i++) keys.add(id.slice(0, i) + id.slice(i + 1));
  return [...keys];
}

export function candidatePairs(rows: NormalisedRow[]): Array<[number, number]> {
  const blocks = new Map<string, number[]>();
  const add = (k: string, i: number) => {
    const list = blocks.get(k);
    if (list) list.push(i);
    else blocks.set(k, [i]);
  };
  rows.forEach((r, i) => {
    add(`L|${r.location}|${soundex(r.surname)}`, i);
    if (r.phone) add(`P|${r.phone.slice(-7)}`, i);
    if (r.nationalId) for (const k of idKeys(r.nationalId)) add(`I|${k}`, i);
  });
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const list of blocks.values()) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const i = Math.min(list[x], list[y]);
        const j = Math.max(list[x], list[y]);
        if (i === j) continue;
        const k = `${i},${j}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push([i, j]);
      }
    }
  }
  return out;
}

export function scorePair(a: NormalisedRow, b: NormalisedRow): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let num = 0;
  let den = 0;
  const ns = nameSimilarity(a.tokens, b.tokens);
  num += WEIGHTS.name * ns;
  den += WEIGHTS.name;
  const tl = [...new Set([...a.translit, ...b.translit])].sort();
  reasons.push(`name ${ns.toFixed(2)}${tl.length ? ` (transliteration ${tl.join(', ')})` : ''}`);

  if (a.phone && b.phone) {
    den += WEIGHTS.phone;
    if (a.phone === b.phone) {
      num += WEIGHTS.phone;
      reasons.push('phone equal after E.164 normalisation');
    }
  } else reasons.push('phone missing or unparseable on a row');

  if (a.dob && b.dob) {
    den += WEIGHTS.dob;
    const same = a.dob.y === b.dob.y && a.dob.m === b.dob.m && a.dob.d === b.dob.d;
    const swapped = a.dob.y === b.dob.y && a.dob.m === b.dob.d && a.dob.d === b.dob.m;
    if (same) {
      num += WEIGHTS.dob;
      reasons.push('date of birth equal');
    } else if (swapped) {
      num += WEIGHTS.dob;
      reasons.push('date of birth equal with day/month swapped');
    }
  } else reasons.push('date of birth missing on a row');

  if (a.nationalId && b.nationalId) {
    den += WEIGHTS.id;
    const d = osaDistance(a.nationalId, b.nationalId);
    if (d === 0) {
      num += WEIGHTS.id;
      reasons.push('national ID equal');
    } else if (d === 1) {
      num += WEIGHTS.id;
      reasons.push('national ID within one edit (typo or transposed digits)');
    }
  } else reasons.push('national ID missing or malformed on a row');

  return { score: Math.round((num / den) * 1000) / 1000, reasons };
}

export function band(score: number): Band | undefined {
  if (score >= LIKELY_SAME) return 'likely_same';
  if (score >= REVIEW) return 'review';
  return undefined;
}

export function comparePairs(x: DedupPair, y: DedupPair): number {
  if (y.score !== x.score) return y.score - x.score;
  if (x.a !== y.a) return x.a < y.a ? -1 : 1;
  return x.b < y.b ? -1 : x.b > y.b ? 1 : 0;
}

export function heuristicDedup(rows: DedupRow[]): DedupPair[] {
  const norm = rows.map(normaliseRow);
  const out: DedupPair[] = [];
  for (const [i, j] of candidatePairs(norm)) {
    // score in row-id order so the result does not depend on input order
    const [x, y] = norm[i].rowId < norm[j].rowId ? [norm[i], norm[j]] : [norm[j], norm[i]];
    const { score, reasons } = scorePair(x, y);
    const b = band(score);
    if (!b) continue;
    out.push({ a: x.rowId, b: y.rowId, score, band: b, reasons });
  }
  return out.sort(comparePairs);
}

/** Pseudonymised view sent to an LLM: name tokens, birth year, location code, last 4 phone digits. */
export interface PseudoRow {
  rowId: string;
  nameTokens: string[];
  birthYear?: number;
  location: string;
  phoneLast4?: string;
}

export function pseudonymise(r: DedupRow): PseudoRow {
  const n = normaliseRow(r);
  return {
    rowId: n.rowId,
    nameTokens: n.tokens,
    birthYear: n.dob?.y,
    location: n.location,
    phoneLast4: n.phone?.slice(-4),
  };
}
