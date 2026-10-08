import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import { seedPath } from '../src/config.js';
import { SIM } from '../src/keys.js';
import { LicenceRegistry, LicenceRegistryError, signRegistry, verifyRegistry } from '../src/onboarding/licence-registry.js';
import { run } from '../src/cli.js';

const csv = readFileSync(seedPath('licence-registry.csv'));
const sig = readFileSync(seedPath('licence-registry.sig'), 'utf8');
const agency = SIM.agency().publicKey();

test('the committed registry verifies against the test agency key and parses 60 licences', () => {
  assert.ok(verifyRegistry(csv, sig, agency));
  const reg = LicenceRegistry.fromBytes(csv, sig, agency);
  assert.equal(reg.records.length, 60);
  assert.equal(reg.records.filter((r) => r.status === 'expired').length, 3);
  assert.ok(reg.lookup('tcg', 'sbp-tcg-2026-0107'), 'lookup is format-insensitive');
});

test('a tampered CSV (one character) does not load', () => {
  const tampered = Buffer.from(csv.toString('utf8').replace('2027-01-31', '2029-01-31'), 'utf8');
  assert.notDeepEqual(tampered, csv);
  assert.throws(() => LicenceRegistry.fromBytes(tampered, sig, agency), LicenceRegistryError);
});

test('a signature by another key, a garbled signature or no key does not load', () => {
  const mallory = Keypair.random();
  assert.throws(() => LicenceRegistry.fromBytes(csv, signRegistry(csv, mallory), agency), LicenceRegistryError);
  assert.throws(() => LicenceRegistry.fromBytes(csv, 'AAAA', agency), LicenceRegistryError);
  assert.throws(() => LicenceRegistry.fromBytes(csv, sig, mallory.publicKey()), LicenceRegistryError);
  assert.throws(() => LicenceRegistry.fromBytes(csv, sig, ''), /AGENCY_PUBKEY/);
  assert.throws(() => LicenceRegistry.fromBytes(csv, sig, 'not-a-key'), LicenceRegistryError);
});

test('`voucher serve` refuses to start when the registry signature does not verify', async () => {
  const errs: string[] = [];
  const code = await run(['serve', '--demo', '--port', '0'], { out: () => undefined, err: (s) => errs.push(s), env: { AGENCY_PUBKEY: Keypair.random().publicKey() } });
  assert.equal(code, 1);
  assert.match(errs.join('\n'), /signature does not verify.*refusing to start/);
});

test('`voucher serve` without AGENCY_PUBKEY (non-demo) refuses to start', async () => {
  const errs: string[] = [];
  const code = await run(['serve'], { out: () => undefined, err: (s) => errs.push(s), env: {} });
  assert.equal(code, 2);
  assert.match(errs.join('\n'), /AGENCY_PUBKEY is not set/);
});
