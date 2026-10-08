// One test per reason code, in evaluation order, through the pure rule engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/sep8/rules.js';
import { REASON_CODES, type RuleState, type TxSummary, type MerchantView } from '../src/sep8/types.js';
import { ACTIVE_FOOD, ISSUER, T, alice, bob, farmer, general, programme, rules, shop, agrovet, amt, spend } from './helpers.js';
import { simAddress } from '../src/keys.js';

function state(over: Partial<RuleState> = {}, merchants: Record<string, MerchantView> = {}): RuleState {
  const recips: Record<string, { assets: string[]; suspended: boolean }> = {
    [alice.publicKey()]: { assets: ['OVFOOD'], suspended: false },
    [bob.publicKey()]: { assets: ['OVFOOD'], suspended: false },
    [farmer.publicKey()]: { assets: ['OVAGRI'], suspended: false },
  };
  const ms: Record<string, MerchantView> = {
    [shop.publicKey()]: ACTIVE_FOOD,
    [agrovet.publicKey()]: { ...ACTIVE_FOOD, categories: 2 },
    [general.publicKey()]: { ...ACTIVE_FOOD, categories: 3 },
    ...merchants,
  };
  return {
    programme: { start: programme.start, expiry: programme.expiry, tzOffsetSeconds: programme.tzOffsetSeconds },
    issuer: ISSUER,
    assets: rules.assets,
    recipient: (a) => (recips[a] ? { address: a, ...recips[a] } : undefined),
    merchant: (a) => ms[a],
    history: [],
    ...over,
  };
}

function pay(from: string, to: string, amount: string, code = 'OVFOOD', issuer = ISSUER): TxSummary {
  return { source: from, ops: [{ type: 'payment', destination: to, assetCode: code, assetIssuer: issuer, amount: amt(amount) }] };
}

function code(s: TxSummary, st = state(), now = T): string {
  const d = evaluate(s, st, now);
  return d.ok ? 'APPROVED' : d.code;
}

test('reason codes are the twelve documented ones, in order', () => {
  assert.deepEqual([...REASON_CODES], [
    'NOT_SINGLE_PAYMENT', 'WRONG_ASSET', 'PROGRAMME_NOT_ACTIVE', 'SOURCE_NOT_BENEFICIARY', 'BENEFICIARY_SUSPENDED', 'PEER_TO_PEER',
    'MERCHANT_NOT_REGISTERED', 'MERCHANT_NOT_ACTIVE', 'CATEGORY_MISMATCH', 'AMOUNT_INVALID', 'DAILY_CAP', 'WEEKLY_CAP',
  ]);
});

test('an enrolled recipient paying an active food merchant within caps is approved', () => {
  const d = evaluate(pay(alice.publicKey(), shop.publicKey(), '4.50'), state(), T);
  assert.ok(d.ok);
  if (d.ok) {
    assert.equal(d.amount, amt('4.50'));
    assert.equal(d.asset.code, 'OVFOOD');
  }
  assert.equal(code(pay(farmer.publicKey(), agrovet.publicKey(), '19.335', 'OVAGRI')), 'APPROVED');
  assert.equal(code(pay(farmer.publicKey(), general.publicKey(), '5.414', 'OVAGRI')), 'APPROVED');
});

test('1 NOT_SINGLE_PAYMENT: two ops, a path payment, or no payment', () => {
  const two: TxSummary = { source: alice.publicKey(), ops: [...pay(alice.publicKey(), shop.publicKey(), '1').ops, ...pay(alice.publicKey(), shop.publicKey(), '1').ops] };
  assert.equal(code(two), 'NOT_SINGLE_PAYMENT');
  assert.equal(code({ source: alice.publicKey(), ops: [{ type: 'pathPaymentStrictSend' }] }), 'NOT_SINGLE_PAYMENT');
  assert.equal(code({ source: alice.publicKey(), ops: [{ type: 'changeTrust' }] }), 'NOT_SINGLE_PAYMENT');
  assert.equal(code({ source: alice.publicKey(), ops: [] }), 'NOT_SINGLE_PAYMENT');
});

test('2 WRONG_ASSET: another code, another issuer, or XLM', () => {
  assert.equal(code(pay(alice.publicKey(), shop.publicKey(), '1', 'USDC')), 'WRONG_ASSET');
  assert.equal(code(pay(alice.publicKey(), shop.publicKey(), '1', 'OVFOOD', simAddress('fake-issuer'))), 'WRONG_ASSET');
  assert.equal(code({ source: alice.publicKey(), ops: [{ type: 'payment', destination: shop.publicKey(), amount: 1n }] }), 'WRONG_ASSET');
});

test('3 PROGRAMME_NOT_ACTIVE: before start and after expiry', () => {
  const p = pay(alice.publicKey(), shop.publicKey(), '1');
  assert.equal(code(p, state(), programme.start - 1), 'PROGRAMME_NOT_ACTIVE');
  assert.equal(code(p, state(), programme.start), 'APPROVED');
  assert.equal(code(p, state(), programme.expiry), 'APPROVED');
  assert.equal(code(p, state(), programme.expiry + 1), 'PROGRAMME_NOT_ACTIVE');
});

test('4 SOURCE_NOT_BENEFICIARY: unknown source, or enrolled for the other asset', () => {
  assert.equal(code(pay(simAddress('stranger'), shop.publicKey(), '1')), 'SOURCE_NOT_BENEFICIARY');
  assert.equal(code(pay(farmer.publicKey(), shop.publicKey(), '1', 'OVFOOD')), 'SOURCE_NOT_BENEFICIARY');
  // a merchant cannot spend vouchers onward either
  assert.equal(code(pay(shop.publicKey(), general.publicKey(), '1')), 'SOURCE_NOT_BENEFICIARY');
});

test('5 BENEFICIARY_SUSPENDED', () => {
  const st = state({ recipient: (a) => (a === alice.publicKey() ? { address: a, assets: ['OVFOOD'], suspended: true } : undefined) });
  assert.equal(code(pay(alice.publicKey(), shop.publicKey(), '1'), st), 'BENEFICIARY_SUSPENDED');
});

test('6 PEER_TO_PEER: a recipient paying another recipient is refused', () => {
  assert.equal(code(pay(alice.publicKey(), bob.publicKey(), '2.00')), 'PEER_TO_PEER');
  assert.equal(code(pay(alice.publicKey(), farmer.publicKey(), '2.00')), 'PEER_TO_PEER');
});

test('7 MERCHANT_NOT_REGISTERED: an unlicensed shop with no registry record is refused', () => {
  assert.equal(code(pay(alice.publicKey(), simAddress('unlicensed-kiosk'), '1.39')), 'MERCHANT_NOT_REGISTERED');
});

test('8 MERCHANT_NOT_ACTIVE: pending, suspended, revoked, or licence expired', () => {
  const m = simAddress('m');
  for (const status of ['Pending', 'Suspended', 'Revoked'] as const) {
    assert.equal(code(pay(alice.publicKey(), m, '1'), state({}, { [m]: { ...ACTIVE_FOOD, status } })), 'MERCHANT_NOT_ACTIVE', status);
  }
  assert.equal(code(pay(alice.publicKey(), m, '1'), state({}, { [m]: { ...ACTIVE_FOOD, licenceExpires: T } })), 'MERCHANT_NOT_ACTIVE');
  assert.equal(code(pay(alice.publicKey(), m, '1'), state({}, { [m]: { ...ACTIVE_FOOD, licenceExpires: T + 1 } })), 'APPROVED');
});

test('9 CATEGORY_MISMATCH: food vouchers at an agro-dealer and the reverse', () => {
  assert.equal(code(pay(alice.publicKey(), agrovet.publicKey(), '1')), 'CATEGORY_MISMATCH');
  assert.equal(code(pay(farmer.publicKey(), shop.publicKey(), '1', 'OVAGRI')), 'CATEGORY_MISMATCH');
});

test('10 AMOUNT_INVALID: zero or negative', () => {
  assert.equal(code(pay(alice.publicKey(), shop.publicKey(), '0')), 'AMOUNT_INVALID');
  assert.equal(code(pay(alice.publicKey(), shop.publicKey(), '-1')), 'AMOUNT_INVALID');
});

test('11 DAILY_CAP: the food category cap of 5.00 per day', () => {
  assert.equal(code(pay(alice.publicKey(), shop.publicKey(), '5.01')), 'DAILY_CAP');
  const st = state({ history: [spend(alice.publicKey(), '3.20', T - 3600)] });
  assert.equal(code(pay(alice.publicKey(), shop.publicKey(), '1.80'), st), 'APPROVED');
  assert.equal(code(pay(alice.publicKey(), shop.publicKey(), '1.81'), st), 'DAILY_CAP');
  // the agri cap is separate and larger
  assert.equal(code(pay(farmer.publicKey(), agrovet.publicKey(), '25.00', 'OVAGRI')), 'APPROVED');
  assert.equal(code(pay(farmer.publicKey(), agrovet.publicKey(), '25.01', 'OVAGRI')), 'DAILY_CAP');
});

test('12 WEEKLY_CAP: 10.00 over a rolling 7 days', () => {
  const st = state({ history: [spend(alice.publicKey(), '4.90', T - 2 * 86_400), spend(alice.publicKey(), '4.60', T - 86_400)] });
  assert.equal(code(pay(alice.publicKey(), shop.publicKey(), '0.50'), st), 'APPROVED');
  assert.equal(code(pay(alice.publicKey(), shop.publicKey(), '0.51'), st), 'WEEKLY_CAP');
});

test('earlier codes win: a P2P transfer over the cap after expiry reports PROGRAMME_NOT_ACTIVE', () => {
  assert.equal(code(pay(alice.publicKey(), bob.publicKey(), '99'), state(), programme.expiry + 10), 'PROGRAMME_NOT_ACTIVE');
  assert.equal(code(pay(alice.publicKey(), bob.publicKey(), '99')), 'PEER_TO_PEER');
});

test('the engine is pure: same inputs, same decision', () => {
  const s = pay(alice.publicKey(), shop.publicKey(), '4.99');
  const st = state();
  assert.deepEqual(evaluate(s, st, T), evaluate(s, st, T));
});
