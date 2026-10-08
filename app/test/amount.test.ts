import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAmount, formatUsd, kesToUsd, parseAmount, parsePositiveAmount, toStellarAmount } from '../src/amount.js';

test('parses decimals into stroops exactly', () => {
  assert.equal(parseAmount('4.50'), 45_000_000n);
  assert.equal(parseAmount('212.40'), 2_124_000_000n);
  assert.equal(parseAmount('1.391'), 13_910_000n);
  assert.equal(parseAmount('0.0000001'), 1n);
  assert.equal(parseAmount(' 3000 '), 30_000_000_000n);
  assert.equal(parseAmount('-0.5'), -5_000_000n);
});

test('rejects malformed amounts and more than 7 decimals', () => {
  for (const bad of ['', 'abc', '1.23456789', '1,000.00', '1e3', '.5', '5.']) {
    assert.throws(() => parseAmount(bad), /invalid amount/, bad);
  }
  assert.throws(() => parsePositiveAmount('0'), /greater than zero/);
  assert.throws(() => parsePositiveAmount('-1'), /greater than zero/);
});

test('formats for the SDK and for humans', () => {
  assert.equal(toStellarAmount(45_000_000n), '4.5000000');
  assert.equal(toStellarAmount(1n), '0.0000001');
  assert.equal(toStellarAmount(-5_000_000n), '-0.5000000');
  assert.equal(formatAmount(45_000_000n), '4.50');
  assert.equal(formatAmount(13_910_000n), '1.391');
  assert.equal(formatAmount(30_000_000_000n), '3000.00');
  assert.equal(formatUsd(40_850_000_000n), '4,085.00');
  assert.equal(formatUsd(13_915_000n), '1.39'); // 1.3915 rounds half-up at the cent: 139.15 cents → 139
  assert.equal(formatUsd(13_950_000n), '1.40');
});

test('KES prices convert at the programme rate with 2-3 decimals', () => {
  assert.equal(kesToUsd(180, 129.3), parseAmount('1.392'));
  assert.equal(kesToUsd(180, 129.3, 2), parseAmount('1.39'));
  assert.equal(kesToUsd(2500, 129.3), parseAmount('19.335'));
});
