// Runs `simulate` over the committed seed: the full journey through the real approval
// service, onboarding, disbursement planner, expiry planner and pool model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAmount } from '../src/amount.js';
import { seedPath } from '../src/config.js';
import { simulate, type SimResult } from '../src/sim/simulate.js';
import { generateSeed } from '../src/seed/generate.js';
import { computeFigures } from '../src/report/figures.js';
import { guardDraft } from '../src/report/guard.js';
import { renderTemplate } from '../src/report/template.js';

const expected = JSON.parse(readFileSync(seedPath('expected.json'), 'utf8')) as {
  attempts: number;
  approved: number;
  planted: Record<string, number>;
  refusals_by_code: Record<string, number>;
  disbursed: Record<string, string>;
  spent: Record<string, string>;
  unspent: Record<string, string>;
};
const plan = JSON.parse(readFileSync(seedPath('pool-plan.json'), 'utf8')) as Record<
  string,
  { rounds: Array<{ day: number; redemptions: Array<{ merchant: string; amount: string; expect: string }> }>; fund_day1: { amount: string } }
>;

let cached: SimResult | undefined;
async function sim(): Promise<SimResult> {
  cached ??= await simulate({ weeks: 4 });
  return cached;
}

test('planted counts in expected.json match the specification', () => {
  assert.deepEqual(expected.planted, { p2p: 40, unregistered: 25, m30: 18, daily_cap: 60, weekly_cap: 35, category_mismatch: 15, m07_suspended: 12, after_expiry: 10 });
  assert.ok(expected.attempts >= 3800 && expected.attempts <= 4300, `~4,000 attempts (${expected.attempts})`);
});

test('refusal counts equal expected.json exactly, with zero false refusals', async () => {
  const r = await sim();
  assert.equal(r.attempts, expected.attempts);
  assert.equal(r.approved, expected.approved);
  assert.deepEqual(r.refusalsByCode, Object.fromEntries(Object.entries(expected.refusals_by_code).sort()));
  assert.equal(r.falseRefusals, 0);
  assert.equal(r.failedSubmissions, 0);
  for (const [plant, o] of Object.entries(r.plantedOutcome)) {
    if (plant === 'valid') continue;
    assert.equal(o.refusedAsExpected, o.attempts, `every planted ${plant} attempt refused with its code`);
  }
});

test('disbursed = spent + unspent, per asset', async () => {
  const r = await sim();
  for (const a of ['OVFOOD', 'OVAGRI']) {
    assert.equal(r.disbursed[a], parseAmount(expected.disbursed[a]));
    assert.equal(r.spent[a], parseAmount(expected.spent[a]));
    assert.equal(r.disbursed[a], r.spent[a] + r.unspentDay28[a]);
  }
  assert.equal(r.skippedDuplicates, 12, 'the later row of each `same` pair is not disbursed');
  assert.equal(r.disbursementTxs, 488);
});

test('unspent clawed back at expiry equals the recipient balances on day 28', async () => {
  const r = await sim();
  for (const a of ['OVFOOD', 'OVAGRI']) {
    assert.equal(r.clawedAtExpiry[a], r.unspentDay28[a]);
    assert.equal(r.clawedAtExpiry[a], parseAmount(expected.unspent[a]));
  }
  assert.ok(r.clawbackTxs >= 1);
  // merchant balances are not clawed: M07 still held vouchers after expiry
  assert.ok(r.holdingsDay28.holdings.some((h) => !r.holdingsDay28.recipients.includes(h.address)));
});

test('merchant redemptions paid + queued equal merchant receipts', async () => {
  const r = await sim();
  for (const a of ['OVFOOD', 'OVAGRI']) {
    assert.equal(r.redeemedPaid[a] + r.queuedFinal[a], r.merchantReceipts[a]);
  }
  assert.ok(r.queuedAfterWeek4.OVFOOD > 0n, 'the week-4 food redemptions hit the 85% float and queue');
  assert.equal(r.queuedAfterWeek4.OVAGRI, 0n, 'agri pool fully funded');
  assert.equal(r.queuedFinal.OVFOOD, 0n, 'top-up + settle clear the queue');
  assert.equal(r.surplusWithdrawn.OVFOOD, r.clawedAtExpiry.OVFOOD, 'surplus = the unspent share once the float reached 100%');
  assert.ok(r.invariants);
});

test('redemption rounds match pool-plan.json (mirrored by the Rust scenario)', async () => {
  const r = await sim();
  for (const asset of ['OVFOOD', 'OVAGRI']) {
    for (const round of plan[asset].rounds) {
      const got = r.rounds.find((x) => x.asset === asset && x.day === round.day)!;
      assert.deepEqual(
        got.redemptions.map((x) => [x.merchant, x.amount, x.outcome === 'MerchantNotActive' ? 'MerchantNotActive' : 'ok']),
        round.redemptions.map((x) => [x.merchant, parseAmount(x.amount), x.expect]),
        `${asset} day ${round.day}`,
      );
    }
  }
  const m07 = r.rounds.filter((x) => x.asset === 'OVFOOD').flatMap((x) => x.redemptions.filter((y) => y.merchant === 'M07').map((y) => [x.day, y.outcome]));
  assert.deepEqual(m07.map(([d]) => d), [7, 14, 21, 28, 34]);
  assert.deepEqual(m07.slice(2).map(([, o]) => o), ['MerchantNotActive', 'MerchantNotActive', 'Paid']);
});

test('onboarding: five self-onboarded merchants active, M30 refused LICENCE_NOT_FOUND', async () => {
  const r = await sim();
  assert.deepEqual(
    r.onboarding.map((o) => [o.merchant, o.status, o.reason ?? '']).sort(),
    [['M25', 'active', ''], ['M26', 'active', ''], ['M27', 'active', ''], ['M28', 'active', ''], ['M29', 'active', ''], ['M30', 'rejected', 'LICENCE_NOT_FOUND']],
  );
});

test('donor-report figures from the simulated events pass the numbers guard', async () => {
  const r = await sim();
  const f = computeFigures(r.events, '2026-09-01T00:00:00+03:00', '2026-10-14');
  assert.equal(f.refused_payments, r.refused);
  assert.equal(f.approved_payments, r.approved);
  assert.deepEqual(f.active_merchants, { legacy: 24, self_onboarded: 5, total: 29 });
  assert.equal(guardDraft(renderTemplate(f), f).ok, true);
});

test('the committed seed files are exactly what the generator produces', () => {
  const files = generateSeed();
  for (const [name, text] of Object.entries(files)) {
    assert.equal(readFileSync(seedPath(name), 'utf8'), text, `${name} differs from the generator output; run npm run seed`);
  }
  assert.equal(plan.OVFOOD.fund_day1.amount, '3472.2500000', '85% of 4,085.00');
});
