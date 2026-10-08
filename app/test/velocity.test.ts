import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usedToday, usedWeek, WEEK_SECONDS } from '../src/sep8/velocity.js';
import { LedgerWatcher, MemoryLedgerSource } from '../src/sep8/ledger-watch.js';
import { programme } from './helpers.js';
import { T, alice, shop, world, paymentTx, spend, amt } from './helpers.js';

const tz = programme.tzOffsetSeconds;

test('a spend exactly at the daily cap passes and one stroop over is refused', async () => {
  const w = world();
  const ok = await w.service.approve(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '5.0000000', seq: '10' }));
  assert.equal(ok.response.status, 'revised');
  const w2 = world();
  const over = await w2.service.approve(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '5.0000001', seq: '10' }));
  assert.equal(over.response.status, 'rejected');
  assert.equal(over.response.status === 'rejected' && over.response.code, 'DAILY_CAP');
});

test('the daily window is the programme-local calendar day (+03:00), not UTC', () => {
  const localMidnight = programme.start + 10 * 86_400; // 00:00 +03:00 = 21:00 UTC the day before
  const e = [spend(alice.publicKey(), '4.00', localMidnight - 1)]; // 23:59:59 local
  assert.equal(usedToday(e, localMidnight - 1, tz), amt('4.00'));
  assert.equal(usedToday(e, localMidnight, tz), 0n, 'rolls over at local midnight');
  // 22:00 UTC is already the next local day; a UTC-day window would still count it
  assert.equal(usedToday(e, localMidnight + 3600, tz), 0n);
  assert.equal(usedToday(e, localMidnight + 3600, 0), amt('4.00'), 'contrast: UTC would still count it');
});

test('the rolling week boundary is 168 h: counted at 168 h - 1 s, gone at 168 h + 1 s', () => {
  const e = [spend(alice.publicKey(), '6.00', T)];
  assert.equal(usedWeek(e, T + WEEK_SECONDS - 1), amt('6.00'));
  assert.equal(usedWeek(e, T + WEEK_SECONDS), 0n);
  assert.equal(usedWeek(e, T + WEEK_SECONDS + 1), 0n);
  assert.equal(usedWeek(e, T - 1), 0n, 'future entries never count');
});

test('live reservations count against the caps; expired ones do not', () => {
  const e = [spend(alice.publicKey(), '3.00', T, 'reservation', T + 300)];
  assert.equal(usedToday(e, T + 299, tz), amt('3.00'));
  assert.equal(usedToday(e, T + 300, tz), 0n);
  assert.equal(usedWeek(e, T + 100), amt('3.00'));
});

test('an approved-but-unsubmitted payment reserves the cap until its timebound passes', async () => {
  const w = world();
  const first = await w.service.approve(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '4.00', seq: '10' }));
  assert.equal(first.response.status, 'revised');
  w.clock.now += 60;
  const second = await w.service.approve(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '1.50', seq: '11' }));
  assert.equal(second.response.status === 'rejected' && second.response.code, 'DAILY_CAP', 'reservation counts');

  // the watcher never sees the first transaction: it is released after its timebound
  const src = new MemoryLedgerSource();
  const watcher = new LedgerWatcher(w.store, src, () => w.clock.now);
  w.clock.now = T + 299;
  assert.deepEqual(await watcher.poll(), { confirmed: 0, released: 0 });
  w.clock.now = T + 300;
  assert.deepEqual(await watcher.poll(), { confirmed: 0, released: 1 });
  const third = await w.service.approve(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '1.50', seq: '12' }));
  assert.equal(third.response.status, 'revised');
});

test('a reservation seen on the ledger becomes a spend and keeps counting', async () => {
  const w = world();
  const r = await w.service.approve(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '4.00', seq: '10' }));
  const src = new MemoryLedgerSource();
  src.seen.set(r.revisedHash!, T + 6);
  const watcher = new LedgerWatcher(w.store, src, () => w.clock.now);
  w.clock.now = T + 10;
  assert.deepEqual(await watcher.poll(), { confirmed: 1, released: 0 });
  w.clock.now = T + 3600; // long after the timebound
  const e = w.store.history(alice.publicKey(), 'OVFOOD');
  assert.equal(e.length, 1);
  assert.equal(e[0].kind, 'spend');
  const next = await w.service.approve(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '1.01', seq: '11' }));
  assert.equal(next.response.status === 'rejected' && next.response.code, 'DAILY_CAP');
});

test('the same transaction submitted twice returns the same result without double counting', async () => {
  const w = world();
  const xdr = paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '3.00', seq: '10' });
  const a = await w.service.approve(xdr);
  w.clock.now += 30;
  const b = await w.service.approve(xdr);
  assert.equal(b.cached, true);
  assert.deepEqual(b.response, a.response);
  assert.equal(w.store.history(alice.publicKey(), 'OVFOOD').length, 1);
  // 3.00 reserved once: another 2.00 still fits under 5.00
  const c = await w.service.approve(paymentTx({ from: alice.publicKey(), to: shop.publicKey(), amount: '2.00', seq: '11' }));
  assert.equal(c.response.status, 'revised');
});
