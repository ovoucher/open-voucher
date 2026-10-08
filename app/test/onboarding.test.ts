import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Account, Keypair } from '@stellar/stellar-sdk';
import { PASSPHRASE, programme, rules } from './helpers.js';
import { seedPath } from '../src/config.js';
import { parseCsv } from '../src/csv.js';
import { SIM, simKeypair } from '../src/keys.js';
import { buildInvokeTx, registryCall } from '../src/chain.js';
import { Onboarding, categoryMask, licenceExpiryUnix } from '../src/onboarding/apply.js';
import { licenceHash, licenceKey, normaliseLicenceNo } from '../src/onboarding/licence.js';
import { LicenceRegistry } from '../src/onboarding/licence-registry.js';
import { MemoryOnboardingChain } from '../src/onboarding/memory-chain.js';
import { MemoryRegistry } from '../src/sep8/registry-reader.js';
import { MemoryStore } from '../src/store.js';
import { tokenSetSimilarity } from '../src/strings.js';

const merchants = parseCsv(readFileSync(seedPath('merchants.csv'), 'utf8')).rows;
const M = (id: string) => merchants.find((m) => m.merchant_id === id)!;
const licReg = LicenceRegistry.load(seedPath('licence-registry.csv'), seedPath('licence-registry.sig'), SIM.agency().publicKey());

function setup() {
  const clock = { now: programme.start + 3 * 86_400 + 10 * 3600 };
  const registry = new MemoryRegistry();
  const chain = new MemoryOnboardingChain(registry, () => clock.now);
  const store = new MemoryStore();
  // M01 is a legacy vendor the agency enrolled before the programme
  const m01 = M('M01');
  chain.enrol(m01.address, licenceHash(m01.issuing_authority, m01.licence_no), 1, programme.start + 120 * 86_400);
  const svc = new Onboarding({
    rules,
    registry: licReg,
    chain,
    store,
    clock: () => clock.now,
    networkPassphrase: PASSPHRASE,
    registryContractId: SIM.registryId(),
    tzOffsetSeconds: programme.tzOffsetSeconds,
  });
  return { clock, registry, chain, store, svc };
}

function signedApply(kp: Keypair, authority: string, licenceNo: string, cats: string[], signer: Keypair = kp, contract = SIM.registryId()): string {
  const tx = buildInvokeTx(new Account(kp.publicKey(), '7'), registryCall.apply(contract, kp.publicKey(), licenceHash(authority, licenceNo), categoryMask(rules, cats)), PASSPHRASE);
  tx.sign(signer);
  return tx.toXDR();
}

function req(kp: Keypair, businessName: string, licenceNo: string, authority: string, cats: string[], signed?: string) {
  return { address: kp.publicKey(), businessName, licenceNumber: licenceNo, issuingAuthority: authority, categories: cats, signedApplyTx: signed ?? signedApply(kp, authority, licenceNo, cats) };
}

test('licence normalisation vectors are shared with the Rust registry tests', () => {
  assert.equal(normaliseLicenceNo('BP/2026/00123'), 'BP202600123');
  assert.equal(normaliseLicenceNo('bp 2026 00123'), 'BP202600123');
  assert.equal(normaliseLicenceNo('BP-2026-00123'), 'BP202600123');
  assert.equal(licenceKey('ncc', 'bp 2026 00123'), 'NCC:BP202600123');
  // the same hex constants appear in contracts/merchant_registry/src/test.rs
  assert.equal(licenceHash('NCC', 'BP/2026/00123'), '160011bc5c862bceab119ecf8471d307ba03716fa1105c27271a6f35f6444874');
  assert.equal(licenceHash('pcpb', 'pcpb-ad-2026-0456'), 'de8ffee03039527ac351a89e53442496754f6c702f3f00172a60e65bf4c7dd01');
  assert.equal(licenceHash(' ksm ', 'SBP 2026 KSM 0071'), '17edbd24b14418700f3067487df78a4c5af4aad6199706a468e9eda6bd46ed5d');
});

test('M25 self-onboards: registry licence found, name matches, apply + approve in one request', async () => {
  const s = setup();
  const m = M('M25');
  const kp = simKeypair('merchant/M25');
  assert.equal(kp.publicKey(), m.address);
  const res = await s.svc.apply(req(kp, m.business_name, m.licence_no, m.issuing_authority, ['food']));
  assert.equal(res.status, 'active', JSON.stringify(res));
  if (res.status !== 'active') return;
  assert.ok(res.similarity >= 0.8);
  const rec = s.registry.getSync(kp.publicKey())!;
  assert.equal(rec.status, 'Active');
  assert.equal(rec.categories, 1);
  assert.equal(rec.licenceExpires, licenceExpiryUnix('2027-01-31', programme.tzOffsetSeconds));
  const log = s.store.onboarding();
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'active');
  assert.equal(log[0].activatedAt, s.clock.now);
});

test('M30 is refused LICENCE_NOT_FOUND and nothing is written on chain', async () => {
  const s = setup();
  const m = M('M30');
  const kp = simKeypair('merchant/M30');
  const res = await s.svc.apply(req(kp, m.business_name, m.licence_no, m.issuing_authority, ['food']));
  assert.equal(res.status === 'rejected' && res.reason, 'LICENCE_NOT_FOUND');
  assert.equal(s.registry.getSync(kp.publicKey()), undefined);
  assert.equal(s.store.onboarding()[0].reason, 'LICENCE_NOT_FOUND');
});

test('expired licences are refused: by status, by date, and with fewer than 30 days left', async () => {
  const s = setup();
  for (const [no, auth] of [['SBP/TCG/2026/1039', 'TCG'], ['SBP/TCG/2026/1052', 'TCG'], ['pcpb ad 2026 1055', 'PCPB']]) {
    const kp = Keypair.random();
    const cats = auth === 'PCPB' ? ['agri'] : ['food'];
    const rec = licReg.lookup(auth, no)!;
    const res = await s.svc.apply(req(kp, rec.businessName, no, auth, cats));
    assert.equal(res.status === 'rejected' && res.reason, 'LICENCE_EXPIRED', no);
  }
});

test('a licence class that does not allow the category is refused', async () => {
  const s = setup();
  const pharmacy = await s.svc.apply(req(Keypair.random(), 'Kakuma Pharmacy', 'SBP/TCG/2026/1000', 'tcg', ['food']));
  assert.equal(pharmacy.status === 'rejected' && pharmacy.reason, 'LICENCE_CLASS_NOT_ALLOWED');
  const retailAsAgri = await s.svc.apply(req(Keypair.random(), 'Warsame Shop', 'SBP/TCG/2026/1130', 'TCG', ['agri']));
  assert.equal(retailAsAgri.status === 'rejected' && retailAsAgri.reason, 'LICENCE_CLASS_NOT_ALLOWED');
});

test('a licence already bound to another address is refused LICENCE_IN_USE', async () => {
  const s = setup();
  const m01 = M('M01');
  // same licence, typed differently, from a new address
  const res = await s.svc.apply(req(Keypair.random(), m01.business_name, 'SBP/TCG/2026/0107', 'tcg', ['food']));
  assert.equal(res.status === 'rejected' && res.reason, 'LICENCE_IN_USE');
});

test('a business name that does not match the registry goes to pending_review', async () => {
  const s = setup();
  const kp = Keypair.random();
  const res = await s.svc.apply(req(kp, 'Baraka Hardware & Electronics', 'SBP/TCG/2026/1130', 'TCG', ['food']));
  assert.equal(res.status, 'pending_review');
  assert.equal(s.registry.getSync(kp.publicKey())!.status, 'Pending', 'left Pending for staff (voucher enrol --approve)');
  // staff approval then activates it
  await s.chain.approve(kp.publicKey(), programme.start + 200 * 86_400);
  assert.equal(s.registry.getSync(kp.publicKey())!.status, 'Active');
});

test('BAD_SIGNATURE: wrong signer, mismatched arguments, or another contract', async () => {
  const s = setup();
  const m = M('M26');
  const kp = simKeypair('merchant/M26');
  const other = Keypair.random();
  const wrongSigner = await s.svc.apply(req(kp, m.business_name, m.licence_no, m.issuing_authority, ['food'], signedApply(kp, m.issuing_authority, m.licence_no, ['food'], other)));
  assert.equal(wrongSigner.status === 'rejected' && wrongSigner.reason, 'BAD_SIGNATURE');
  const wrongArgs = await s.svc.apply(req(kp, m.business_name, m.licence_no, m.issuing_authority, ['food'], signedApply(kp, m.issuing_authority, m.licence_no, ['food', 'agri'])));
  assert.equal(wrongArgs.status === 'rejected' && wrongArgs.reason, 'BAD_SIGNATURE');
  const wrongContract = await s.svc.apply(req(kp, m.business_name, m.licence_no, m.issuing_authority, ['food'], signedApply(kp, m.issuing_authority, m.licence_no, ['food'], kp, SIM.foodPoolId())));
  assert.equal(wrongContract.status === 'rejected' && wrongContract.reason, 'BAD_SIGNATURE');
  const junk = await s.svc.apply(req(kp, m.business_name, m.licence_no, m.issuing_authority, ['food'], 'not-xdr'));
  assert.equal(junk.status === 'rejected' && junk.reason, 'BAD_SIGNATURE');
  // and the real one still works afterwards
  const ok = await s.svc.apply(req(kp, m.business_name, m.licence_no, m.issuing_authority, ['food']));
  assert.equal(ok.status, 'active');
});

test('name similarity is deterministic token-set matching, tolerant of legal forms and one typo', () => {
  assert.equal(tokenSetSimilarity('Neema Fresh Produce Ltd.', 'NEEMA FRESH PRODUCE'), 1);
  assert.equal(tokenSetSimilarity("Aduts Kitchen Supplies", "ADUT'S KITCHEN SUPPLIES"), 1);
  assert.ok(tokenSetSimilarity('Kalobeyei Sunrise Grocey', 'KALOBEYEI SUNRISE GROCERY') >= 0.8);
  assert.ok(tokenSetSimilarity('Baraka Hardware', 'Warsame Shop') < 0.8);
  assert.equal(tokenSetSimilarity('', 'x'), 0);
});
