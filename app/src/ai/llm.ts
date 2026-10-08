// LlmProvider: Anthropic Messages API with a JSON schema on the output, local schema
// validation, and one retry that feeds the validation errors back. Tests inject a fake
// client replaying recorded fixtures; no test touches the network.
import Anthropic from '@anthropic-ai/sdk';
import { canonicalJson } from '../hash.js';
import type { Figures } from '../report/figures.js';
import type { AiProvider } from './provider.js';
import type { Band, DedupPair, PseudoRow } from './dedup.js';

export const DEFAULT_LLM_MODEL = 'claude-sonnet-5';

export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export const REJUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['judgements'],
  properties: {
    judgements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['a', 'b', 'band', 'reason'],
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
          band: { type: 'string', enum: ['likely_same', 'review'] },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['markdown'],
  properties: { markdown: { type: 'string' } },
} as const;

export interface Judgement {
  a: string;
  b: string;
  band: Band;
  reason: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function validateJudgements(v: unknown, allowed: ReadonlySet<string>): Validation<Judgement[]> {
  const errors: string[] = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, errors: ['top level must be an object'] };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'judgements');
  if (extra.length) errors.push(`unexpected keys: ${extra.join(', ')}`);
  if (!Array.isArray(o.judgements)) return { ok: false, errors: [...errors, 'judgements must be an array'] };
  const out: Judgement[] = [];
  o.judgements.forEach((j, i) => {
    if (!j || typeof j !== 'object') {
      errors.push(`judgements[${i}] must be an object`);
      return;
    }
    const x = j as Record<string, unknown>;
    if (typeof x.a !== 'string' || typeof x.b !== 'string') errors.push(`judgements[${i}].a/b must be strings`);
    else if (!allowed.has(`${x.a}|${x.b}`)) errors.push(`judgements[${i}] refers to a pair that was not sent (${x.a}/${x.b})`);
    if (x.band !== 'likely_same' && x.band !== 'review') errors.push(`judgements[${i}].band must be likely_same or review`);
    if (typeof x.reason !== 'string' || x.reason.length === 0) errors.push(`judgements[${i}].reason must be a non-empty string`);
    const keys = Object.keys(x).filter((k) => !['a', 'b', 'band', 'reason'].includes(k));
    if (keys.length) errors.push(`judgements[${i}] has unexpected keys: ${keys.join(', ')}`);
    if (errors.length === 0) out.push({ a: x.a as string, b: x.b as string, band: x.band as Band, reason: x.reason as string });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

export function validateReport(v: unknown): Validation<string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, errors: ['top level must be an object'] };
  const o = v as Record<string, unknown>;
  if (typeof o.markdown !== 'string' || o.markdown.trim().length === 0) return { ok: false, errors: ['markdown must be a non-empty string'] };
  const extra = Object.keys(o).filter((k) => k !== 'markdown');
  if (extra.length) return { ok: false, errors: [`unexpected keys: ${extra.join(', ')}`] };
  return { ok: true, value: o.markdown };
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found in model output');
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

const DEDUP_SYSTEM = `You help humanitarian programme staff review possible duplicate registrations within ONE programme's recipient list. You see pseudonymised rows only: normalised name tokens, birth year, a location code and the last 4 phone digits. For each pair you are given, decide whether it should be in the "likely_same" band (very probably one person registered twice) or stay in "review" (unclear, e.g. twins or relatives sharing a phone). Staff make the final decision on every pair; you only sort the queue. Give a short, specific reason. Return one JSON object matching the schema and nothing else.`;

const REPORT_SYSTEM = `You draft a short donor report for a restricted-voucher programme from a JSON object of figures. Use ONLY numbers that appear in the figures, written exactly as they appear there (do not round, add, subtract or compute percentages). Do not number headings or list items. Plain, factual tone; no claims beyond the figures. Programme staff review and sign the draft. Return one JSON object {"markdown": "..."} and nothing else.`;

export interface LlmProviderOptions {
  apiKey?: string;
  model?: string;
  client?: MessagesClient;
  maxAttempts?: number;
}

export class LlmProvider implements AiProvider {
  readonly name = 'llm' as const;
  readonly model: string;
  private readonly client: MessagesClient;
  private readonly maxAttempts: number;

  constructor(opts: LlmProviderOptions = {}) {
    this.model = opts.model ?? process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL;
    this.maxAttempts = opts.maxAttempts ?? 2;
    if (opts.client) this.client = opts.client;
    else {
      const apiKey = opts.apiKey ?? process.env.LLM_API_KEY;
      if (!apiKey) throw new Error('LlmProvider needs LLM_API_KEY (or an injected client)');
      this.client = new Anthropic({ apiKey });
    }
  }

  private async ask<T>(system: string, user: string, schema: object, validate: (v: unknown) => Validation<T>): Promise<T> {
    let errors: string[] = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const content = errors.length
        ? `${user}\n\nYour previous answer failed validation with these errors; return a corrected JSON object:\n${errors.map((e) => `- ${e}`).join('\n')}`
        : user;
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
      });
      if (res.stop_reason === 'refusal') throw new Error('the model declined the request');
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      let parsed: unknown;
      try {
        parsed = extractJson(text);
      } catch (e) {
        errors = [`output was not valid JSON: ${(e as Error).message}`];
        continue;
      }
      const v = validate(parsed);
      if (v.ok) return v.value;
      errors = v.errors;
    }
    throw new Error(`LLM output failed schema validation after ${this.maxAttempts} attempts: ${errors.slice(0, 5).join('; ')}`);
  }

  async rejudgeReview(pairs: DedupPair[], rows: ReadonlyMap<string, PseudoRow>): Promise<DedupPair[]> {
    const review = pairs.filter((p) => p.band === 'review');
    if (review.length === 0) return pairs;
    const allowed = new Set(review.map((p) => `${p.a}|${p.b}`));
    const payload = review.map((p) => ({ a: rows.get(p.a), b: rows.get(p.b), heuristic_score: p.score, heuristic_reasons: p.reasons }));
    const user = `Pairs to re-judge (JSON):\n${canonicalJson(payload)}\n\nOutput JSON schema:\n${canonicalJson(REJUDGE_SCHEMA)}`;
    const judgements = await this.ask(DEDUP_SYSTEM, user, REJUDGE_SCHEMA, (v) => validateJudgements(v, allowed));
    return mergeJudgements(pairs, judgements);
  }

  async draftReport(figures: Figures): Promise<string> {
    const user = `Figures (JSON):\n${canonicalJson(figures)}\n\nOutput JSON schema:\n${canonicalJson(REPORT_SCHEMA)}`;
    return this.ask(REPORT_SYSTEM, user, REPORT_SCHEMA, validateReport);
  }
}

/** Applies judgements to review-band pairs. Pairs are never removed. */
export function mergeJudgements(pairs: DedupPair[], judgements: Judgement[]): DedupPair[] {
  const byKey = new Map(judgements.map((j) => [`${j.a}|${j.b}`, j]));
  return pairs.map((p) => {
    const j = p.band === 'review' ? byKey.get(`${p.a}|${p.b}`) : undefined;
    if (!j) return p;
    return { ...p, band: j.band, reasons: [...p.reasons, `llm: ${j.reason}`] };
  });
}
