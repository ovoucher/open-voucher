import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseAssetCode, parseCategories, parseDate, parseGAddress, parsePositiveInt, UsageError } from '../src/args.js';
import { run } from '../src/cli.js';
import { alice } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} as Record<string, string> }, out, err };
}

test('parses values, inline values and switches', () => {
  const p = parseArgs(['pay', '--from', 'amina', '--merchant', alice.publicKey(), '--asset=OVFOOD', '--amount', '4.50', '--dry-run']);
  assert.equal(p.command, 'pay');
  assert.deepEqual(p.flags, { from: 'amina', merchant: alice.publicKey(), asset: 'OVFOOD', amount: '4.50' });
  assert.ok(p.switches.has('dry-run'));
});

test('rejects unknown commands, unknown options, missing values and missing required flags', () => {
  assert.throws(() => parseArgs(['mint']), /unknown command/);
  assert.throws(() => parseArgs(['fund', '--asset', 'OVFOOD', '--amount', '1', '--to', 'x']), /unknown option --to/);
  assert.throws(() => parseArgs(['fund', '--asset', '--amount', '1']), /--asset needs a value/);
  assert.throws(() => parseArgs(['fund', '--asset', 'OVFOOD']), /--amount is required/);
  assert.throws(() => parseArgs(['fund', '--asset', 'OVFOOD', '--asset', 'OVAGRI', '--amount', '1']), /given twice/);
  assert.throws(() => parseArgs(['simulate', 'extra']), /unexpected argument/);
  assert.throws(() => parseArgs(['simulate', '--json=yes']), /does not take a value/);
});

test('enrol actions are mutually exclusive', () => {
  assert.throws(() => parseArgs(['enrol', '--merchant', alice.publicKey(), '--legacy', '--approve']), /only one of/);
  assert.throws(() => parseArgs(['enrol', '--merchant', alice.publicKey(), '--suspend', '3', '--reinstate']), /only one of/);
  assert.doesNotThrow(() => parseArgs(['enrol', '--merchant', alice.publicKey(), '--suspend', '3']));
});

test('value parsers', () => {
  assert.deepEqual(parseCategories('food, agri,food'), ['food', 'agri']);
  assert.throws(() => parseCategories('shelter'), UsageError);
  assert.equal(parseAssetCode('ovfood', ['OVFOOD', 'OVAGRI']), 'OVFOOD');
  assert.throws(() => parseAssetCode('USDC', ['OVFOOD']), /unknown voucher asset/);
  assert.equal(parseDate('2026-09-01', 'from'), '2026-09-01');
  assert.throws(() => parseDate('01/09/2026', 'from'), /YYYY-MM-DD/);
  assert.equal(parsePositiveInt('50', 'max'), 50);
  assert.throws(() => parsePositiveInt('0', 'max'), UsageError);
  assert.equal(parseGAddress(alice.publicKey(), 'merchant'), alice.publicKey());
  assert.throws(() => parseGAddress('CAAA', 'merchant'), /G… account/);
});

test('cli: usage errors exit 2, help exits 0', async () => {
  const c = capture();
  assert.equal(await run(['frobnicate'], c.io), 2);
  assert.match(c.err.join(''), /unknown command/);
  const h = capture();
  assert.equal(await run([], h.io), 0);
  assert.match(h.out.join(''), /voucher simulate/);
  const bad = capture();
  assert.equal(await run(['fund', '--asset', 'OVFOOD', '--amount', '-3', '--dry-run'], bad.io), 1);
  assert.match(bad.err.join(''), /greater than zero/);
  const weeks = capture();
  assert.equal(await run(['simulate', '--weeks', '6'], weeks.io), 2);
});

test('cli: contract calls build offline with --dry-run', async () => {
  const c = capture();
  assert.equal(await run(['redeem', '--merchant', alice.publicKey(), '--asset', 'OVFOOD', '--amount', '212.40', '--dry-run'], c.io), 0);
  assert.match(c.out.join('\n'), /dry run: redeem on C[A-Z2-7]{55}/);
  const s = capture();
  assert.equal(await run(['settle', '--asset', 'OVFOOD', '--dry-run'], s.io), 0);
  assert.match(s.out.join('\n'), /settle_queue/);
  const e = capture();
  assert.equal(await run(['enrol', '--merchant', alice.publicKey(), '--licence', 'SBP/TCG/2026/0107', '--authority', 'TCG', '--categories', 'food', '--legacy', '--dry-run'], e.io), 0);
  assert.match(e.out.join('\n'), /dry run: enrol/);
});

test('cli: issue --offline prints the issuer policy and stellar.toml', async () => {
  const c = capture();
  assert.equal(await run(['issue', '--programme', 'KE-PILOT-SIM', '--offline'], c.io), 0);
  const text = c.out.join('\n');
  assert.match(text, /AUTH_REQUIRED \| AUTH_REVOCABLE \| AUTH_CLAWBACK_ENABLED/);
  assert.match(text, /payment\s+approval signer: no/);
  assert.match(text, /regulated = true/);
  const wrong = capture();
  assert.equal(await run(['issue', '--programme', 'OTHER', '--offline'], wrong.io), 2);
});

test('cli: network commands without configuration fail with a clear message', async () => {
  const c = capture();
  assert.equal(await run(['fund', '--asset', 'OVFOOD', '--amount', '3000'], c.io), 2);
  assert.match(c.err.join(''), /POOL_OVFOOD_ID is not set/);
});
