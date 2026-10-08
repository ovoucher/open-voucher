import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CachedRegistryReader, MemoryRegistry } from '../src/sep8/registry-reader.js';
import { JsonFileStore } from '../src/store.js';
import { ACTIVE_FOOD, T, alice, shop, spend } from './helpers.js';

test('registry cache: a suspension reaches the approval server within 60 s', async () => {
  const reg = new MemoryRegistry();
  reg.set(shop.publicKey(), ACTIVE_FOOD);
  let now = T;
  const cached = new CachedRegistryReader(reg, 60, () => now);
  assert.equal((await cached.getMerchant(shop.publicKey()))!.status, 'Active');
  reg.setStatus(shop.publicKey(), 'Suspended');
  now = T + 59;
  assert.equal((await cached.getMerchant(shop.publicKey()))!.status, 'Active', 'stale for up to 60 s (documented)');
  now = T + 60;
  assert.equal((await cached.getMerchant(shop.publicKey()))!.status, 'Suspended');
});

test('JsonFileStore persists recipients, spends, reservations, refusals and reloads them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ov-store-'));
  try {
    const path = join(dir, 'store.json');
    const a = new JsonFileStore(path);
    a.putRecipient({ address: alice.publicKey(), assets: ['OVFOOD'], suspended: false });
    a.addSpend(spend(alice.publicKey(), '1.391', T));
    a.addReservation(spend(alice.publicKey(), '2.00', T + 10, 'reservation', T + 310));
    a.logRefusal({ at: T, code: 'PEER_TO_PEER', source: alice.publicKey(), destination: 'x', asset: 'OVFOOD', amount: 10n });
    const b = new JsonFileStore(path);
    assert.equal(b.recipients().length, 1);
    const h = b.history(alice.publicKey(), 'OVFOOD');
    assert.deepEqual(h.map((e) => [e.kind, e.amount]), [['spend', 13_910_000n], ['reservation', 20_000_000n]]);
    assert.equal(b.refusals()[0].amount, 10n);
    assert.ok(b.releaseReservation(h[1].key));
    assert.equal(new JsonFileStore(path).history(alice.publicKey(), 'OVFOOD').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
