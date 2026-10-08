// Deterministic donor-report template. Used when no LLM is configured and whenever an
// LLM draft fails the numbers guard.
import type { Figures } from './figures.js';

export function renderTemplate(f: Figures): string {
  const codes = Object.entries(f.refusals_by_code)
    .map(([c, n]) => `| ${c} | ${n} |`)
    .join('\n');
  return [
    `# Donor report: ${f.programme}`,
    '',
    `Period: ${f.period.from} to ${f.period.to}.`,
    '',
    '## Disbursement and spending',
    '',
    `- Vouchers disbursed: OVFOOD ${f.disbursed.OVFOOD} USD, OVAGRI ${f.disbursed.OVAGRI} USD.`,
    `- Spent at registered merchants: food ${f.spent_by_category.food} USD, farm inputs ${f.spent_by_category.agri} USD, in ${f.approved_payments} approved payments.`,
    `- Unspent recipient balances clawed back at expiry: OVFOOD ${f.clawed_at_expiry.OVFOOD} USD, OVAGRI ${f.clawed_at_expiry.OVAGRI} USD.`,
    '',
    '## Merchant redemption',
    '',
    `- Paid to merchants in USDC: OVFOOD pool ${f.redeemed_paid.OVFOOD} USD, OVAGRI pool ${f.redeemed_paid.OVAGRI} USD.`,
    `- Claims still queued: OVFOOD ${f.redeemed_queued_outstanding.OVFOOD} USD, OVAGRI ${f.redeemed_queued_outstanding.OVAGRI} USD.`,
    `- Shortfall events: ${f.shortfall_events} (total gap ${f.shortfall_total_gap} USD at the time of each claim).`,
    '',
    '## Merchants',
    '',
    `- Active merchants: ${f.active_merchants.total} (${f.active_merchants.legacy} enrolled by the agency, ${f.active_merchants.self_onboarded} self-onboarded).`,
    `- Median time from application to activation for self-onboarded merchants: ${f.median_apply_to_active_minutes ?? 'n/a'} minutes.`,
    `- Share of spending at the top ${f.top_n} merchants: ${f.top5_merchant_share_pct}%.`,
    '',
    '## Refused payment attempts',
    '',
    `${f.refused_payments} attempts were refused by the approval server:`,
    '',
    '| Reason code | Attempts |',
    '|---|---|',
    codes || '| none | 0 |',
    '',
  ].join('\n');
}
