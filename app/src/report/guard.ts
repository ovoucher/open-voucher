// Numbers guard: every number in a draft must equal a figure (after format
// normalisation), otherwise the draft is discarded and the template is used.
import type { Figures } from './figures.js';

const NUM_RE = /-?\d[\d,]*(?:\.\d+)?/g;

function norm(s: string): string {
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) return s;
  return String(Math.round(n * 1e6) / 1e6);
}

function collect(v: unknown, out: Set<string>): void {
  if (v === null || v === undefined) return;
  if (typeof v === 'number') {
    out.add(norm(String(v)));
    return;
  }
  if (typeof v === 'string') {
    for (const m of v.match(NUM_RE) ?? []) out.add(norm(m));
    return;
  }
  if (Array.isArray(v)) v.forEach((x) => collect(x, out));
  else if (typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => collect(x, out));
}

export function allowedNumbers(f: Figures): Set<string> {
  const s = new Set<string>();
  collect(f, s);
  return s;
}

export interface GuardResult {
  ok: boolean;
  unknown: string[];
}

export function guardDraft(markdown: string, f: Figures): GuardResult {
  const allowed = allowedNumbers(f);
  // Reason codes and the programme id contain no digits except the id's own; strip
  // identifiers made of letters, digits and dashes so "KE-PILOT-SIM" or "M07" do not
  // count as numbers.
  const text = markdown.replace(/\b[A-Z][A-Z0-9_-]*\d[A-Z0-9_-]*\b/g, ' ');
  const unknown: string[] = [];
  for (const m of text.match(NUM_RE) ?? []) {
    if (!allowed.has(norm(m))) unknown.push(m);
  }
  return { ok: unknown.length === 0, unknown };
}
