// Deterministic donor-report figures from pool/registry events and classic payment
// records (the approval-server and simulator logs offline; Horizon/RPC online).
import { formatUsd } from '../amount.js';
import { canonicalJson, sha256Hex } from '../hash.js';

export interface EventLog {
  programme: string;
  disbursements: Array<{ asset: string; recipient: string; amount: string; at: number }>;
  payments: Array<{ asset: string; from: string; to: string; amount: string; at: number; status: 'approved' | 'refused'; code?: string }>;
  pool: Array<{ asset: string; kind: 'fund' | 'redeem_paid' | 'redeem_queued' | 'shortfall' | 'settle' | 'withdraw'; merchant?: string; amount: string; gap?: string; at: number; claimId?: number }>;
  merchants: Array<{ id: string; address: string; onboarding: 'legacy' | 'self'; appliedAt?: number; activatedAt?: number; categories: string[] }>;
  clawbacks: Array<{ asset: string; from: string; amount: string; at: number }>;
}

export interface Figures {
  programme: string;
  period: { from: string; to: string };
  disbursed: Record<string, string>;
  spent_by_category: Record<string, string>;
  redeemed_paid: Record<string, string>;
  redeemed_queued_outstanding: Record<string, string>;
  shortfall_events: number;
  shortfall_total_gap: string;
  clawed_at_expiry: Record<string, string>;
  active_merchants: { legacy: number; self_onboarded: number; total: number };
  median_apply_to_active_minutes: number | null;
  top_n: number;
  top5_merchant_share_pct: string;
  approved_payments: number;
  refused_payments: number;
  refusals_by_code: Record<string, number>;
}

function stroops(s: string): bigint {
  const [w, f = ''] = s.split('.');
  const neg = w.startsWith('-');
  const v = BigInt(w.replace('-', '')) * 10_000_000n + BigInt((f + '0000000').slice(0, 7));
  return neg ? -v : v;
}

function addTo(map: Map<string, bigint>, k: string, v: bigint): void {
  map.set(k, (map.get(k) ?? 0n) + v);
}

function usdMap(m: Map<string, bigint>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = formatUsd(m.get(k) ?? 0n);
  return out;
}

const CATEGORY: Record<string, string> = { OVFOOD: 'food', OVAGRI: 'agri' };

export function computeFigures(log: EventLog, fromIso: string, toIso: string): Figures {
  const from = Math.floor(Date.parse(fromIso) / 1000);
  const to = Math.floor(Date.parse(`${toIso}${toIso.length <= 10 ? 'T23:59:59+03:00' : ''}`) / 1000);
  const inRange = (t: number) => t >= from && t <= to;
  const assets = ['OVFOOD', 'OVAGRI'];

  const disbursed = new Map<string, bigint>();
  for (const d of log.disbursements) if (inRange(d.at)) addTo(disbursed, d.asset, stroops(d.amount));

  const spent = new Map<string, bigint>();
  const byMerchant = new Map<string, bigint>();
  const refusals: Record<string, number> = {};
  let approved = 0;
  let refused = 0;
  let totalSpent = 0n;
  for (const p of log.payments) {
    if (!inRange(p.at)) continue;
    if (p.status === 'approved') {
      approved++;
      const v = stroops(p.amount);
      addTo(spent, CATEGORY[p.asset] ?? p.asset, v);
      addTo(byMerchant, p.to, v);
      totalSpent += v;
    } else {
      refused++;
      const c = p.code ?? 'UNKNOWN';
      refusals[c] = (refusals[c] ?? 0) + 1;
    }
  }

  const paid = new Map<string, bigint>();
  const queued = new Map<string, bigint>();
  let shortfalls = 0;
  let gap = 0n;
  for (const e of log.pool) {
    if (!inRange(e.at)) continue;
    const v = stroops(e.amount);
    if (e.kind === 'redeem_paid' || e.kind === 'settle') addTo(paid, e.asset, v);
    if (e.kind === 'redeem_queued') addTo(queued, e.asset, v);
    if (e.kind === 'settle') addTo(queued, e.asset, -v);
    if (e.kind === 'shortfall') {
      shortfalls++;
      gap += stroops(e.gap ?? '0');
    }
  }

  const clawed = new Map<string, bigint>();
  for (const c of log.clawbacks) if (inRange(c.at)) addTo(clawed, c.asset, stroops(c.amount));

  const active = log.merchants.filter((m) => m.activatedAt !== undefined && m.activatedAt <= to);
  const legacy = active.filter((m) => m.onboarding === 'legacy').length;
  const selfOn = active.filter((m) => m.onboarding === 'self').length;
  const mins = active
    .filter((m) => m.onboarding === 'self' && m.appliedAt !== undefined)
    .map((m) => ((m.activatedAt as number) - (m.appliedAt as number)) / 60)
    .sort((a, b) => a - b);
  let median: number | null = null;
  if (mins.length > 0) {
    const mid = Math.floor(mins.length / 2);
    median = mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2;
    median = Math.round(median * 10) / 10;
  }

  const top = [...byMerchant.values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)).slice(0, 5);
  const topSum = top.reduce((a, b) => a + b, 0n);
  const share = totalSpent > 0n ? Number((topSum * 10_000n) / totalSpent) / 100 : 0;

  return {
    programme: log.programme,
    period: { from: fromIso.slice(0, 10), to: toIso.slice(0, 10) },
    disbursed: usdMap(disbursed, assets),
    spent_by_category: usdMap(spent, ['food', 'agri']),
    redeemed_paid: usdMap(paid, assets),
    redeemed_queued_outstanding: usdMap(queued, assets),
    shortfall_events: shortfalls,
    shortfall_total_gap: formatUsd(gap),
    clawed_at_expiry: usdMap(clawed, assets),
    active_merchants: { legacy, self_onboarded: selfOn, total: legacy + selfOn },
    median_apply_to_active_minutes: median,
    top_n: 5,
    top5_merchant_share_pct: share.toFixed(2),
    approved_payments: approved,
    refused_payments: refused,
    refusals_by_code: Object.fromEntries(Object.entries(refusals).sort()),
  };
}

export function figuresHash(f: Figures): string {
  return sha256Hex(canonicalJson(f));
}
