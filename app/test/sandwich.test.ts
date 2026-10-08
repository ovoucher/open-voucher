import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Asset, Keypair, Operation, StrKey, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { T, ISSUER, PASSPHRASE, alice, shop, approvalSigner, issuerKp, paymentTx, programme, rules, world } from './helpers.js';
import { buildIssuance, SANDWICH_OPS } from '../src/sep8/sandwich.js';
import { canAuthorise, ISSUER_FLAGS, issuerSetupOps, OP_THRESHOLD, policyFrom, stellarToml } from '../src/issuer/ops.js';
import { SIM } from '../src/keys.js';
import { Account } from '@stellar/stellar-sdk';

async function revised(amount = '4.50', seq = '41', fee = '100'): Promise<Transaction> {
  const w = world();
  const out = await w.service.approve(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount, seq, fee }));
  assert.equal(out.response.status, 'revised', JSON.stringify(out.response));
  if (out.response.status !== 'revised') throw new Error('unreachable');
  return TransactionBuilder.fromXDR(out.response.tx, PASSPHRASE) as Transaction;
}

test('the revised transaction is authorise, authorise, pay, de-authorise, de-authorise', async () => {
  const tx = await revised();
  assert.equal(tx.operations.length, SANDWICH_OPS);
  assert.deepEqual(tx.operations.map((o) => o.type), ['setTrustLineFlags', 'setTrustLineFlags', 'payment', 'setTrustLineFlags', 'setTrustLineFlags']);
  const [a1, a2, p, d1, d2] = tx.operations as unknown as Array<Record<string, any>>;
  assert.equal(a1.trustor, alice.publicKey());
  assert.equal(a2.trustor, shop.publicKey());
  assert.equal(d1.trustor, shop.publicKey());
  assert.equal(d2.trustor, alice.publicKey());
  for (const op of [a1, a2, d1, d2]) {
    assert.equal(op.source, ISSUER, 'flag ops are sourced from the issuer');
    assert.ok(op.asset.equals(new Asset('OVFOOD', ISSUER)));
  }
  assert.equal(a1.flags.authorized, true);
  assert.equal(a2.flags.authorized, true);
  for (const op of [d1, d2]) {
    assert.equal(op.flags.authorized, false);
    assert.equal(op.flags.authorizedToMaintainLiabilities, true);
  }
  assert.equal(p.destination, shop.publicKey());
  assert.equal(p.amount, '4.5000000');
  assert.equal(p.source, undefined, 'the payment is from the recipient (tx source), never the issuer');
});

test('sequence and source come from the original; fee covers five operations', async () => {
  const tx = await revised('1.00', '9000', '100');
  assert.equal(tx.source, alice.publicKey());
  assert.equal(tx.sequence, '9001');
  assert.equal(tx.fee, '500');
  const pricey = await revised('1.00', '9000', '250');
  assert.equal(pricey.fee, '1250');
});

test('timebounds are at most 300 s from approval', async () => {
  const tx = await revised();
  assert.equal(Number(tx.timeBounds!.minTime), T);
  assert.ok(Number(tx.timeBounds!.maxTime) - T <= 300);
  assert.equal(Number(tx.timeBounds!.maxTime), T + rules.file.timebound_seconds);
});

test('the memo is MEMO_HASH = sha256(rules.json)', async () => {
  const tx = await revised();
  assert.equal(tx.memo.type, 'hash');
  assert.equal(Buffer.from(tx.memo.value as Uint8Array).toString('hex'), rules.hash);
});

test('the approval signer has signed; the recipient still has to', async () => {
  const tx = await revised();
  assert.equal(tx.signatures.length, 1);
  const sig = tx.signatures[0];
  assert.deepEqual(Buffer.from(sig.hint.toBytes()), Buffer.from(approvalSigner.signatureHint()));
  assert.ok(approvalSigner.verify(tx.hash(), sig.signature.toBytes()));
  assert.ok(!alice.verify(tx.hash(), sig.signature.toBytes()));
  tx.sign(alice);
  assert.equal(tx.signatures.length, 2);
});

test('no issuer payment is ever produced, whatever the request', async () => {
  const w = world();
  const amounts = ['0.01', '1.391', '4.99', '5.00'];
  for (const [i, a] of amounts.entries()) {
    w.clock.now += 86_400;
    const out = await w.service.approve(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: a, seq: String(100 + i) }));
    assert.equal(out.response.status, 'revised');
    if (out.response.status !== 'revised') continue;
    const tx = TransactionBuilder.fromXDR(out.response.tx, PASSPHRASE) as Transaction;
    const issuerOps = tx.operations.filter((o) => o.source === ISSUER);
    assert.ok(issuerOps.every((o) => o.type === 'setTrustLineFlags'));
    assert.ok(tx.operations.filter((o) => o.type === 'payment').every((o) => o.source !== ISSUER));
  }
  // an attempt to make the issuer pay (op source = issuer) is not a recipient payment
  const sneaky = new TransactionBuilder(new Account(alice.publicKey(), '1'), { fee: '100', networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ source: ISSUER, destination: shop.publicKey(), asset: new Asset('OVFOOD', ISSUER), amount: '1' }))
    .setTimeout(0)
    .build();
  const r = await world().service.approve(sneaky.toXDR());
  assert.equal(r.response.status === 'rejected' && r.response.code, 'SOURCE_NOT_BENEFICIARY');
});

test('garbage and fee-bump envelopes are rejected without a reason code', async () => {
  const w = world();
  const bad = await w.service.approve('AAAA-not-xdr');
  assert.equal(bad.response.status, 'rejected');
  const inner = TransactionBuilder.fromXDR(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '1' }), PASSPHRASE) as Transaction;
  inner.sign(alice);
  const fb = TransactionBuilder.buildFeeBumpTransaction(SIM.opsKey(), '200', inner, PASSPHRASE);
  const r = await w.service.approve(fb.toXDR());
  assert.equal(r.response.status, 'rejected');
  assert.match(r.response.status === 'rejected' ? r.response.error : '', /fee-bump/);
});

test('a fee bump by the agency around the co-signed sandwich is supported', async () => {
  const tx = await revised();
  tx.sign(alice);
  const fb = TransactionBuilder.buildFeeBumpTransaction(SIM.opsKey(), '1000', tx, PASSPHRASE);
  fb.sign(SIM.opsKey());
  assert.equal(fb.innerTransaction.operations.length, 5);
  assert.equal(fb.feeSource, SIM.opsKey().publicKey());
});

test('threshold classification (Stellar docs, List of operations): the approval signer can only flip trustline flags', () => {
  const policy = policyFrom(programme);
  assert.deepEqual(policy.thresholds, { low: 1, med: 10, high: 20 });
  assert.equal(OP_THRESHOLD.setTrustLineFlags, 'low');
  assert.equal(OP_THRESHOLD.payment, 'med');
  assert.equal(OP_THRESHOLD.clawback, 'med');
  assert.equal(OP_THRESHOLD.setOptions, 'high');
  // approval signer, weight 1
  assert.equal(canAuthorise(policy, 1, 'setTrustLineFlags'), true);
  assert.equal(canAuthorise(policy, 1, 'payment'), false, 'cannot mint');
  assert.equal(canAuthorise(policy, 1, 'clawback'), false, 'cannot claw back');
  assert.equal(canAuthorise(policy, 1, 'setOptions'), false);
  // agency ops key, weight 10
  assert.equal(canAuthorise(policy, 10, 'payment'), true);
  assert.equal(canAuthorise(policy, 10, 'clawback'), true);
  assert.equal(canAuthorise(policy, 10, 'setOptions'), false, 'cannot change signers');
  // master, weight 20
  assert.equal(canAuthorise(policy, 20, 'setOptions'), true);
  assert.throws(() => canAuthorise(policy, 20, 'inflation'), /no threshold classification/);
});

test('issuer setup ops: flags, home domain, signers and thresholds; AUTH_IMMUTABLE not set', () => {
  const policy = policyFrom(programme);
  const ops = issuerSetupOps({ issuer: ISSUER, opsKey: SIM.opsKey().publicKey(), approvalSigner: approvalSigner.publicKey(), homeDomain: 'voucher.example.org', policy });
  const tx = new TransactionBuilder(new Account(ISSUER, '0'), { fee: '100', networkPassphrase: PASSPHRASE });
  for (const op of ops) tx.addOperation(op);
  const built = tx.setTimeout(0).build();
  const [flags, ops1, ops2, th] = built.operations as unknown as Array<Record<string, any>>;
  assert.equal(flags.setFlags, ISSUER_FLAGS);
  assert.equal(flags.setFlags & 4, 0, 'AUTH_IMMUTABLE (4) is not set');
  assert.equal(flags.setFlags, 1 | 2 | 8);
  assert.equal(flags.homeDomain, 'voucher.example.org');
  assert.equal(ops1.signer.ed25519PublicKey, SIM.opsKey().publicKey());
  assert.equal(ops1.signer.weight, 10);
  assert.equal(ops2.signer.ed25519PublicKey, approvalSigner.publicKey());
  assert.equal(ops2.signer.weight, 1);
  assert.deepEqual([th.masterWeight, th.lowThreshold, th.medThreshold, th.highThreshold], [20, 1, 10, 20]);
});

test('issuance sandwich for disbursement: authorise, issuer payment, maintain-liabilities', () => {
  const tx = buildIssuance({ issuerAccount: new Account(ISSUER, '5'), asset: new Asset('OVFOOD', ISSUER), recipient: alice.publicKey(), amount: 130_000_000n, networkPassphrase: PASSPHRASE, memoText: 'OVFOOD-2026-09-0001' });
  assert.deepEqual(tx.operations.map((o) => o.type), ['setTrustLineFlags', 'payment', 'setTrustLineFlags']);
  assert.equal(tx.source, ISSUER);
  tx.sign(SIM.opsKey());
  assert.ok(Keypair.fromPublicKey(SIM.opsKey().publicKey()).verify(tx.hash(), tx.signatures[0].signature.toBytes()));
  void issuerKp;
});

test('stellar.toml marks both assets regulated with the approval server and the rules hash', () => {
  const toml = stellarToml(programme, rules, ISSUER);
  assert.equal((toml.match(/regulated = true/g) ?? []).length, 2);
  assert.match(toml, /approval_server = "https:\/\/voucher\.example\.org\/tx-approve"/);
  assert.ok(toml.includes(rules.hash));
  assert.ok(StrKey.isValidEd25519PublicKey(ISSUER));
});
