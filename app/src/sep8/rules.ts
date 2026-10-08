// The SEP-8 rule engine: a pure function from (transaction summary, state, time) to a
// decision. No I/O, no clock, no randomness; every refusal has one reason code and the
// codes are evaluated in the fixed order documented in docs/SEP8-RULES.md.
import { formatAmount } from '../amount.js';
import type { Decision, ReasonCode, RuleState, TxSummary } from './types.js';
import { usedToday, usedWeek } from './velocity.js';

function refuse(code: ReasonCode, message: string): Decision {
  return { ok: false, code, message };
}

export function evaluate(summary: TxSummary, state: RuleState, now: number): Decision {
  // 1. exactly one Payment operation
  if (summary.ops.length !== 1 || summary.ops[0].type !== 'payment') {
    const kinds = summary.ops.map((o) => o.type).join(', ') || 'none';
    return refuse('NOT_SINGLE_PAYMENT', `only a single payment operation is accepted (got: ${kinds})`);
  }
  const op = summary.ops[0];
  const source = op.source ?? summary.source;
  const destination = op.destination ?? '';

  // 2. one of this programme's voucher assets
  const asset = op.assetCode ? state.assets.get(op.assetCode) : undefined;
  if (!asset || op.assetIssuer !== state.issuer) {
    return refuse('WRONG_ASSET', `asset ${op.assetCode ?? 'native'}:${op.assetIssuer ?? ''} is not a voucher asset of this programme`);
  }

  // 3. programme window
  if (now < state.programme.start || now > state.programme.expiry) {
    return refuse('PROGRAMME_NOT_ACTIVE', 'the programme is not active at this time (before start or after expiry)');
  }

  // 4-5. source is an enrolled, unsuspended recipient of this asset
  const recipient = state.recipient(source);
  if (!recipient || !recipient.assets.includes(asset.code)) {
    return refuse('SOURCE_NOT_BENEFICIARY', `source is not an enrolled ${asset.code} recipient`);
  }
  if (recipient.suspended) {
    return refuse('BENEFICIARY_SUSPENDED', 'recipient is suspended pending staff review');
  }

  // 6. no transfers between recipients
  if (state.recipient(destination)) {
    return refuse('PEER_TO_PEER', 'vouchers cannot be sent to another recipient');
  }

  // 7-9. destination is an active merchant registered for this category
  const merchant = state.merchant(destination);
  if (!merchant) {
    return refuse('MERCHANT_NOT_REGISTERED', 'destination is not a registered merchant');
  }
  if (merchant.status !== 'Active' || now >= merchant.licenceExpires) {
    const why = merchant.status !== 'Active' ? merchant.status.toLowerCase() : 'licence expired';
    return refuse('MERCHANT_NOT_ACTIVE', `merchant is not active (${why})`);
  }
  if ((merchant.categories & asset.categoryBit) === 0) {
    return refuse('CATEGORY_MISMATCH', `merchant is not registered for ${asset.category}`);
  }

  // 10. amount
  const amount = op.amount ?? 0n;
  if (amount <= 0n) return refuse('AMOUNT_INVALID', 'amount must be greater than zero');

  // 11-12. velocity: approved spends plus live reservations
  const today = usedToday(state.history, now, state.programme.tzOffsetSeconds);
  if (today + amount > asset.dailyCap) {
    return refuse(
      'DAILY_CAP',
      `daily cap ${formatAmount(asset.dailyCap)} ${asset.code}: ${formatAmount(today)} already used today, ${formatAmount(amount)} requested`,
    );
  }
  const week = usedWeek(state.history, now);
  if (week + amount > asset.weeklyCap) {
    return refuse(
      'WEEKLY_CAP',
      `weekly cap ${formatAmount(asset.weeklyCap)} ${asset.code}: ${formatAmount(week)} used in the last 7 days, ${formatAmount(amount)} requested`,
    );
  }
  return { ok: true, asset, source, destination, amount, usedToday: today, usedWeek: week };
}
