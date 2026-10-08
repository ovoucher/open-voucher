import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { seedPath } from '../src/config.js';
import { parseCsv } from '../src/csv.js';
import { e164, heuristicDedup, nameSimilarity, nameTokens, normaliseId, parseDob, pseudonymise, type DedupRow } from '../src/ai/dedup.js';
import { LlmProvider, mergeJudgements, validateJudgements, type MessagesClient } from '../src/ai/llm.js';
import { dedupLlmAllowed, HeuristicProvider } from '../src/ai/provider.js';
import { run } from '../src/cli.js';
import { FIXTURES, programme } from './helpers.js';
import { jaroWinkler, osaDistance, soundex } from '../src/strings.js';

const rows: DedupRow[] = parseCsv(readFileSync(seedPath('beneficiaries.csv'), 'utf8')).rows.map((r) => ({
  rowId: r.row_id,
  fullName: r.full_name,
  dob: r.dob,
  phone: r.phone,
  nationalId: r.national_id,
  householdSize: Number(r.household_size),
  location: r.location,
}));
const expected = JSON.parse(readFileSync(seedPath('expected.json'), 'utf8')) as {
  planted_duplicate_pairs: Array<{ a: string; b: string; kind: string }>;
  hard_negative_pairs: Array<{ a: string; b: string; kind: string }>;
};
const pairs = heuristicDedup(rows);
const key = (a: string, b: string) => `${a}|${b}`;
const find = (a: string, b: string) => pairs.find((p) => p.a === a && p.b === b);

test('the seed has 500 rows with the planted messiness', () => {
  assert.equal(rows.length, 500);
  assert.equal(rows.filter((r) => !r.dob).length, 23);
  assert.equal(rows.filter((r) => !normaliseId(r.nationalId)).length, 6);
  assert.ok(rows.some((r) => r.fullName !== r.fullName.trim()), 'stray whitespace');
  assert.ok(rows.some((r) => r.fullName === r.fullName.toUpperCase()), 'mixed case');
  assert.equal(expected.planted_duplicate_pairs.length, 12);
  assert.equal(expected.hard_negative_pairs.length, 3);
});

test('all 12 planted duplicate pairs are found at >= 0.85 (likely_same)', () => {
  for (const p of expected.planted_duplicate_pairs) {
    const f = find(p.a, p.b);
    assert.ok(f, `missing planted pair ${p.a}/${p.b} (${p.kind})`);
    assert.ok(f.score >= 0.85, `${p.kind}: ${f.score}`);
    assert.equal(f.band, 'likely_same');
  }
});

test('the 3 hard negatives (twins, household members sharing a phone) land in review, not likely_same', () => {
  for (const p of expected.hard_negative_pairs) {
    const f = find(p.a, p.b);
    assert.ok(f, `hard negative ${p.a}/${p.b} not surfaced`);
    assert.equal(f.band, 'review', `${p.kind}: ${f.score}`);
  }
});

test('at most 10 other pairs in review and no other likely_same (acceptance threshold on simulated data)', () => {
  const known = new Set([...expected.planted_duplicate_pairs, ...expected.hard_negative_pairs].map((p) => key(p.a, p.b)));
  const other = pairs.filter((p) => !known.has(key(p.a, p.b)));
  assert.ok(other.filter((p) => p.band === 'review').length <= 10);
  assert.equal(other.filter((p) => p.band === 'likely_same').length, 0);
});

test('ordering is deterministic: score desc, then row ids', () => {
  const again = heuristicDedup([...rows].reverse());
  assert.deepEqual(again, pairs);
  for (let i = 1; i < pairs.length; i++) {
    const [x, y] = [pairs[i - 1], pairs[i]];
    assert.ok(x.score > y.score || (x.score === y.score && key(x.a, x.b) <= key(y.a, y.b)));
  }
});

test('normalisation helpers: phones, dates, IDs, transliteration, soundex, distances', () => {
  assert.equal(e164('0712 345 678'), '+254712345678');
  assert.equal(e164('254712345678'), '+254712345678');
  assert.equal(e164('+254712345678'), '+254712345678');
  assert.equal(e164('12345'), undefined);
  assert.deepEqual(parseDob('07/04/1990'), { y: 1990, m: 4, d: 7 });
  assert.deepEqual(parseDob('1990-04-07'), { y: 1990, m: 4, d: 7 });
  assert.equal(normaliseId('rf 1234-5678'), 'RF12345678');
  assert.equal(normaliseId('RF1234567O'), undefined);
  assert.deepEqual(nameTokens('  MOHAMMED  abdi ').tokens, ['muhammad', 'abdi']);
  assert.equal(nameSimilarity(['abdi', 'muhammad'], ['abdi', 'muhammad']), 1);
  assert.equal(soundex('Robert'), 'R163');
  assert.equal(soundex('Rupert'), 'R163');
  assert.equal(osaDistance('RF12345678', 'RF12354678'), 1, 'adjacent transposition is one edit');
  assert.ok(jaroWinkler('martha', 'marhta') > 0.96);
});

// ------------------------------------------------------------------ LLM provider (fixtures only)

function fakeClient(responses: unknown[]): MessagesClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const r = responses[calls.length - 1];
        if (!r) throw new Error('no more fixtures');
        return r as Anthropic.Message;
      },
    },
  };
}

const llmFixture = JSON.parse(readFileSync(resolve(FIXTURES, 'llm-dedup.json'), 'utf8')) as { responses: unknown[] };

test('LLM re-judging: a schema-invalid reply is rejected, the retry carries the errors, the valid reply is merged', async () => {
  const client = fakeClient(llmFixture.responses);
  const provider = new LlmProvider({ client, model: 'claude-sonnet-5' });
  const pseudo = new Map(rows.map((r) => [r.rowId, pseudonymise(r)]));
  const out = await provider.rejudgeReview(pairs, pseudo);
  assert.equal(client.calls.length, 2, 'one retry');
  const retryText = String(client.calls[1].messages[0].content);
  assert.match(retryText, /failed validation/);
  assert.match(retryText, /band must be likely_same or review/);
  assert.match(retryText, /pair that was not sent/);
  // never removes a pair; only review pairs can move; reasons are appended
  assert.equal(out.length, pairs.length);
  const moved = out.find((p) => p.a === 'R0439' && p.b === 'R0464')!;
  assert.equal(moved.band, 'likely_same');
  assert.ok(moved.reasons.some((r) => r.startsWith('llm: ')));
  for (const p of expected.planted_duplicate_pairs) assert.equal(out.find((x) => x.a === p.a && x.b === p.b)!.band, 'likely_same');
});

test('LLM sees pseudonymised fields only: name tokens, birth year, location code, last 4 phone digits', async () => {
  const client = fakeClient(llmFixture.responses.slice(1));
  await new LlmProvider({ client }).rejudgeReview(pairs, new Map(rows.map((r) => [r.rowId, pseudonymise(r)])));
  const sent = String(client.calls[0].messages[0].content);
  for (const r of rows.filter((x) => ['R0017', 'R0235'].includes(x.rowId))) {
    assert.ok(!sent.includes(r.phone!.replace(/\D/g, '').slice(-9)), 'no full phone number');
    if (r.nationalId) assert.ok(!sent.includes(r.nationalId), 'no national ID');
    if (r.dob) assert.ok(!sent.includes(r.dob), 'no full date of birth');
  }
  assert.equal(client.calls[0].model, 'claude-sonnet-5');
});

test('LLM provider gives up after two invalid replies', async () => {
  const bad = llmFixture.responses[0];
  const provider = new LlmProvider({ client: fakeClient([bad, bad]) });
  await assert.rejects(provider.rejudgeReview(pairs, new Map()), /failed schema validation after 2 attempts/);
});

test('schema validation and merge rules', () => {
  const allowed = new Set(['A|B']);
  assert.equal(validateJudgements({ judgements: [{ a: 'A', b: 'B', band: 'review', reason: 'x' }] }, allowed).ok, true);
  assert.equal(validateJudgements({ judgements: [{ a: 'A', b: 'B', band: 'drop', reason: 'x' }] }, allowed).ok, false);
  assert.equal(validateJudgements([], allowed).ok, false);
  const merged = mergeJudgements(
    [
      { a: 'A', b: 'B', score: 0.7, band: 'review', reasons: [] },
      { a: 'C', b: 'D', score: 0.9, band: 'likely_same', reasons: [] },
    ],
    [
      { a: 'A', b: 'B', band: 'likely_same', reason: 'r' },
      { a: 'C', b: 'D', band: 'review', reason: 'cannot touch likely_same' },
    ],
  );
  assert.equal(merged[0].band, 'likely_same');
  assert.equal(merged[1].band, 'likely_same');
});

test('the LLM path is disabled when llm_dedup_allowed=false, even with a key', async () => {
  assert.equal(programme.file.llm_dedup_allowed, false);
  assert.equal(dedupLlmAllowed({ LLM_API_KEY: 'k' }, false), false);
  assert.equal(dedupLlmAllowed({}, true), false);
  assert.equal(dedupLlmAllowed({ LLM_API_KEY: 'k' }, true), true);
  const errs: string[] = [];
  const outs: string[] = [];
  const out = resolve(process.env.TMPDIR ?? '/tmp', `ov-dedup-${process.pid}.csv`);
  const code = await run(['dedup', '--csv', seedPath('beneficiaries.csv'), '--out', out, '--provider', 'llm'], { out: (s) => outs.push(s), err: (s) => errs.push(s), env: { LLM_API_KEY: 'sk-test-not-used' } });
  assert.equal(code, 0);
  assert.match(errs.join('\n'), /LLM dedup is disabled/);
  assert.match(outs.join('\n'), /via heuristic/);
  const csv = parseCsv(readFileSync(out, 'utf8'));
  assert.deepEqual(csv.header, ['row_a', 'row_b', 'score', 'band', 'reasons', 'decision']);
  assert.ok(csv.rows.every((r) => r.decision === ''), 'decision column left empty for staff');
  assert.equal(csv.rows.length, pairs.length);
});

test('the heuristic provider leaves pairs unchanged', async () => {
  assert.deepEqual(await new HeuristicProvider().rejudgeReview(pairs), pairs);
});
