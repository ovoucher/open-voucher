import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { computeFigures, figuresHash, type EventLog } from '../src/report/figures.js';
import { guardDraft } from '../src/report/guard.js';
import { renderTemplate } from '../src/report/template.js';
import { approveReport, draftReport, DRAFT_BANNER } from '../src/report/report.js';
import { HeuristicProvider } from '../src/ai/provider.js';
import { LlmProvider } from '../src/ai/llm.js';
import { FIXTURES } from './helpers.js';

const log = JSON.parse(readFileSync(resolve(FIXTURES, 'events-small.json'), 'utf8')) as EventLog;
const fx = JSON.parse(readFileSync(resolve(FIXTURES, 'llm-report.json'), 'utf8')) as Record<string, unknown>;
const figures = computeFigures(log, '2026-09-01T00:00:00+03:00', '2026-10-14');

function client(...responses: unknown[]) {
  let i = 0;
  return { messages: { create: async (_p: Anthropic.MessageCreateParamsNonStreaming) => responses[i++] as Anthropic.Message } };
}

test('figures are computed deterministically from the event fixture', () => {
  assert.deepEqual(figures.disbursed, { OVFOOD: '19.00', OVAGRI: '40.00' });
  assert.deepEqual(figures.spent_by_category, { food: '8.89', agri: '19.34' });
  assert.deepEqual(figures.redeemed_paid, { OVFOOD: '8.89', OVAGRI: '19.34' });
  assert.deepEqual(figures.redeemed_queued_outstanding, { OVFOOD: '0.00', OVAGRI: '0.00' });
  assert.equal(figures.shortfall_events, 1);
  assert.equal(figures.shortfall_total_gap, '0.89');
  assert.deepEqual(figures.clawed_at_expiry, { OVFOOD: '10.11', OVAGRI: '20.67' });
  assert.deepEqual(figures.active_merchants, { legacy: 3, self_onboarded: 2, total: 5 });
  assert.equal(figures.median_apply_to_active_minutes, 7);
  assert.equal(figures.top5_merchant_share_pct, '100.00');
  assert.equal(figures.approved_payments, 4);
  assert.deepEqual(figures.refusals_by_code, { DAILY_CAP: 1, MERCHANT_NOT_REGISTERED: 1, PEER_TO_PEER: 1 });
  assert.equal(figuresHash(figures), figuresHash(computeFigures(log, '2026-09-01T00:00:00+03:00', '2026-10-14')));
});

test('the date range filters events', () => {
  const early = computeFigures(log, '2026-09-01T00:00:00+03:00', '2026-09-01');
  assert.equal(early.clawed_at_expiry.OVFOOD, '0.00');
  assert.equal(early.approved_payments, 1);
});

test('the template passes its own numbers guard', () => {
  const md = renderTemplate(figures);
  assert.deepEqual(guardDraft(md, figures), { ok: true, unknown: [] });
});

test('the guard rejects a draft containing an unlisted number', () => {
  const g = guardDraft('Disbursed 19.00 USD and reached 12,500 households; 18% saving.', figures);
  assert.equal(g.ok, false);
  assert.deepEqual(g.unknown, ['12,500', '18']);
  assert.equal(guardDraft('Disbursed 19.00 USD to KE-PILOT-SIM recipients via M01.', figures).ok, true, 'ids with digits are not numbers');
});

test('an LLM draft whose numbers all match the figures is kept (as DRAFT)', async () => {
  // figures from the simulator contain these values; use a figures object that does
  const f2 = { ...figures, disbursed: { OVFOOD: '4,085.00', OVAGRI: '40.00' }, redeemed_paid: { OVFOOD: '3,732.71', OVAGRI: '19.34' }, refused_payments: 215, period: { from: '2026-09-01', to: '2026-10-14' } };
  const d = await draftReport(f2, new LlmProvider({ client: client(fx.valid) }));
  assert.equal(d.source, 'provider');
  assert.ok(d.markdown.startsWith(DRAFT_BANNER));
  assert.match(d.markdown, /3,732\.71/);
});

test('a hallucinated number discards the LLM draft and falls back to the template', async () => {
  const d = await draftReport(figures, new LlmProvider({ client: client(fx.hallucinated) }));
  assert.equal(d.source, 'template');
  assert.deepEqual(d.rejectedNumbers, ['12,500', '18']);
  assert.ok(d.markdown.includes(renderTemplate(figures).trim()));
});

test('an LLM failure (no JSON twice) falls back to the template', async () => {
  const d = await draftReport(figures, new LlmProvider({ client: client(fx.not_json, fx.not_json) }));
  assert.equal(d.source, 'template');
});

test('the heuristic provider produces the template, marked DRAFT', async () => {
  const d = await draftReport(figures, new HeuristicProvider());
  assert.equal(d.provider, 'heuristic');
  assert.ok(d.markdown.startsWith(DRAFT_BANNER));
  assert.equal(d.figuresSha256, figuresHash(figures));
});

test('approve stamps the staff name, date and figures hash, once', async () => {
  const d = await draftReport(figures, new HeuristicProvider());
  const stamped = approveReport(d.markdown, figures, 'J. Achieng (programme officer)', '2026-10-15');
  assert.ok(stamped.startsWith('> APPROVED by J. Achieng (programme officer) on 2026-10-15. Figures sha256: ' + figuresHash(figures)));
  assert.ok(!stamped.includes('DRAFT'));
  assert.throws(() => approveReport(stamped, figures, 'someone', '2026-10-16'), /not a draft/);
  assert.throws(() => approveReport(d.markdown, figures, '  ', '2026-10-16'), /staff name/);
});
