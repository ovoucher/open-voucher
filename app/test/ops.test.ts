// disburse (SDP CSV stand-in) and expire (classic clawback batches).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Transaction } from '@stellar/stellar-sdk';
import { seedPath } from '../src/config.js';
import { parseCsv } from '../src/csv.js';
import { heuristicDedup } from '../src/ai/dedup.js';
import { buildDisbursementTxs, parseDecisions, planDisbursement, UndecidedPairsError } from '../src/ops/disburse.js';
import { buildClawbackTxs, MAX_OPS_PER_TX, planExpiry } from '../src/ops/expire.js';
import { simAddress } from '../src/keys.js';
import { ISSUER, PASSPHRASE } from './helpers.js';

const benRows = parseCsv(readFileSync(seedPath('beneficiaries.csv'), 'utf8')).rows;
const candidates = heuristicDedup(
  benRows.map((r) => ({ rowId: r.row_id, fullName: r.full_name, dob: r.dob, phone: r.phone, nationalId: r.national_id, location: r.location })),
);
const sdp = parseCsv(readFileSync(seedPath('sdp-disbursement.csv'), 'utf8'));
const decisions = parseDecisions(parseCsv(readFileSync(seedPath('dedup-decisions.csv'), 'utf8')).rows);

test('the SDP-style CSV has the documented columns', () => {
  assert.deepEqual(sdp.header, ['phone', 'walletAddress', 'id', 'amount', 'verification', 'paymentID']);
  assert.equal(sdp.rows.length, 500);
  assert.equal(decisions.filter((d) => d.decision === 'same').length, 12);
  assert.equal(decisions.filter((d) => d.decision === 'distinct').length, 3);
});

test('refuses to run while any likely_same pair lacks a staff decision', () => {
  const partial = decisions.filter((d) => d.decision !== 'same' || d.a !== decisions[0].a);
  assert.throws(() => planDisbursement(sdp.rows, candidates, partial), UndecidedPairsError);
  const unsure = decisions.map((d, i) => (i === 0 ? { ...d, decision: 'unsure' as const } : d));
  assert.throws(() => planDisbursement(sdp.rows, candidates, unsure), /no staff decision/);
});

test('skips the later row of each pair decided same, keeps both rows of distinct pairs', () => {
  const plan = planDisbursement(sdp.rows, candidates, decisions);
  assert.equal(plan.skipped.length, 12);
  for (const s of plan.skipped) assert.ok(s.id > s.duplicateOf, 'the later row id is skipped');
  assert.equal(plan.lines.length, 488);
  for (const d of decisions.filter((x) => x.decision === 'distinct')) {
    assert.ok(plan.lines.some((l) => l.id === d.a) && plan.lines.some((l) => l.id === d.b));
  }
});

test('one issuance sandwich per recipient with consecutive sequence numbers', () => {
  const plan = planDisbursement(sdp.rows, candidates, decisions, (id) => id <= 'R0010');
  const txs = buildDisbursementTxs(plan, ISSUER, '100', 'OVFOOD', PASSPHRASE);
  assert.equal(txs.length, plan.lines.length);
  txs.forEach((tx, i) => {
    assert.equal(tx.sequence, String(101 + i));
    assert.deepEqual(tx.operations.map((o) => o.type), ['setTrustLineFlags', 'payment', 'setTrustLineFlags']);
  });
});

test('rejects contract-account wallets (out of scope)', () => {
  const rows = [{ ...sdp.rows[0], walletAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE' }];
  assert.throws(() => planDisbursement(rows, [], []), /not a G-address/);
});

test('expiry claws back recipient balances only, in batches of at most 100 ops', () => {
  const recipients = Array.from({ length: 230 }, (_, i) => simAddress(`r/${i}`));
  const merchant = simAddress('merchant');
  const holdings = [
    ...recipients.map((a, i) => ({ address: a, asset: i % 2 ? 'OVAGRI' : 'OVFOOD', balance: i % 7 === 0 ? 0n : BigInt(1_000_000 + i) })),
    { address: merchant, asset: 'OVFOOD', balance: 50_000_000n },
  ];
  const plan = planExpiry(holdings, (a) => recipients.includes(a));
  const n = plan.batches.flat().length;
  assert.equal(n, recipients.length - Math.ceil(230 / 7));
  assert.ok(plan.batches.every((b) => b.length <= MAX_OPS_PER_TX));
  assert.equal(plan.skippedMerchants, 1);
  assert.ok(!plan.batches.flat().some((h) => h.address === merchant));
  const txs = buildClawbackTxs(plan, ISSUER, '7', PASSPHRASE);
  assert.equal(txs.length, plan.batches.length);
  assert.ok(txs.every((t: Transaction) => t.operations.every((o) => o.type === 'clawback')));
  // idempotent: after clawback, balances are zero and a second run does nothing
  const after = holdings.map((h) => (recipients.includes(h.address) ? { ...h, balance: 0n } : h));
  assert.equal(planExpiry(after, (a) => recipients.includes(a)).batches.length, 0);
});
