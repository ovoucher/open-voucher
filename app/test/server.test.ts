// The HTTP wrapper, exercised over loopback (no external network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Account } from '@stellar/stellar-sdk';
import { seedPath } from '../src/config.js';
import { createApprovalServer } from '../src/sep8/server.js';
import { Onboarding, categoryMask } from '../src/onboarding/apply.js';
import { LicenceRegistry } from '../src/onboarding/licence-registry.js';
import { MemoryOnboardingChain } from '../src/onboarding/memory-chain.js';
import { licenceHash } from '../src/onboarding/licence.js';
import { buildInvokeTx, registryCall } from '../src/chain.js';
import { SIM, simKeypair } from '../src/keys.js';
import { PASSPHRASE, alice, bob, shop, paymentTx, programme, rules, world } from './helpers.js';

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const w = world();
  const chain = new MemoryOnboardingChain(w.registry, () => w.clock.now);
  const onboarding = new Onboarding({
    rules,
    registry: LicenceRegistry.load(seedPath('licence-registry.csv'), seedPath('licence-registry.sig'), SIM.agency().publicKey()),
    chain,
    store: w.store,
    clock: () => w.clock.now,
    networkPassphrase: PASSPHRASE,
    registryContractId: SIM.registryId(),
    tzOffsetSeconds: programme.tzOffsetSeconds,
  });
  const server = createApprovalServer({ approval: w.service, onboarding, rules, rulesText: readFileSync(seedPath('rules.json'), 'utf8'), programmeId: programme.id });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

const post = (url: string, body: unknown, type = 'application/json') =>
  fetch(url, { method: 'POST', headers: { 'content-type': type }, body: type === 'application/json' ? JSON.stringify(body) : String(body) });

test('GET /health and GET /rules expose the rules hash', async () => {
  await withServer(async (base) => {
    const h = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    assert.deepEqual(h, { ok: true, programme: 'KE-PILOT-SIM', rules_sha256: rules.hash });
    const r = (await (await fetch(`${base}/rules`)).json()) as { sha256: string; rules: { version: number } };
    assert.equal(r.sha256, rules.hash);
    assert.equal(r.rules.version, 1);
  });
});

test('POST /tx-approve: 200 revised for an allowed payment, 400 rejected for P2P', async () => {
  await withServer(async (base) => {
    const ok = await post(`${base}/tx-approve`, { tx: paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '2.50' }) });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { status: string; tx: string; message: string };
    assert.equal(body.status, 'revised');
    assert.ok(body.tx.length > 100);
    const p2p = await post(`${base}/tx-approve`, { tx: paymentTx({ from: alice.publicKey(), to: bob.publicKey(), amount: '2.50', seq: '50' }) });
    assert.equal(p2p.status, 400);
    const pb = (await p2p.json()) as { status: string; error: string; code: string };
    assert.equal(pb.status, 'rejected');
    assert.equal(pb.code, 'PEER_TO_PEER');
  });
});

test('POST /tx-approve accepts form encoding and rejects bad bodies', async () => {
  await withServer(async (base) => {
    const form = await post(`${base}/tx-approve`, `tx=${encodeURIComponent(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '1.00', seq: '60' }))}`, 'application/x-www-form-urlencoded');
    assert.equal(form.status, 200);
    assert.equal((await post(`${base}/tx-approve`, {})).status, 400);
    assert.equal((await post(`${base}/tx-approve`, 'not json', 'application/json; charset=utf-8')).status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test('POST /merchants/apply activates a valid self-onboarding merchant and refuses M30', async () => {
  await withServer(async (base) => {
    const merchants = readFileSync(seedPath('merchants.csv'), 'utf8');
    const kp = simKeypair('merchant/M27');
    const line = merchants.split('\n').find((l) => l.startsWith('M27,'))!.split(',');
    const [, businessName, licenceNumber, issuingAuthority] = line;
    const tx = buildInvokeTx(new Account(kp.publicKey(), '1'), registryCall.apply(SIM.registryId(), kp.publicKey(), licenceHash(issuingAuthority, licenceNumber), categoryMask(rules, ['food'])), PASSPHRASE);
    tx.sign(kp);
    const res = await post(`${base}/merchants/apply`, { address: kp.publicKey(), businessName, licenceNumber, issuingAuthority, categories: ['food'], signedApplyTx: tx.toXDR() });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, 'active');

    const m30 = simKeypair('merchant/M30');
    const tx30 = buildInvokeTx(new Account(m30.publicKey(), '1'), registryCall.apply(SIM.registryId(), m30.publicKey(), licenceHash('TCG', 'SBP/TCG/2026/0999'), 1), PASSPHRASE);
    tx30.sign(m30);
    const r30 = await post(`${base}/merchants/apply`, { address: m30.publicKey(), businessName: 'Quick Cash Mini Shop', licenceNumber: 'SBP/TCG/2026/0999', issuingAuthority: 'TCG', categories: ['food'], signedApplyTx: tx30.toXDR() });
    assert.equal(r30.status, 422);
    assert.equal(((await r30.json()) as { reason: string }).reason, 'LICENCE_NOT_FOUND');

    const missing = await post(`${base}/merchants/apply`, { address: m30.publicKey() });
    assert.equal(missing.status, 400);
  });
});
