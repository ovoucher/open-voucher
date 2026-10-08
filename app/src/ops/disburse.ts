// `voucher disburse`: SDP-CSV-compatible issuance that stands in for SDP until it can
// submit SEP-8 sandwiches. Refuses to run while any `likely_same` pair lacks a staff
// decision; skips the later row of each pair decided `same`.
import { Account, Asset, type Transaction } from '@stellar/stellar-sdk';
import { parseAmount } from '../amount.js';
import type { CsvRow } from '../csv.js';
import type { DedupPair } from '../ai/dedup.js';
import { buildIssuance } from '../sep8/sandwich.js';

export type StaffDecision = 'same' | 'distinct' | 'unsure';

export interface DecisionRow {
  a: string;
  b: string;
  decision: StaffDecision | '';
}

export function parseDecisions(rows: CsvRow[]): DecisionRow[] {
  return rows.map((r) => {
    const a = (r.row_a ?? r.a ?? '').trim();
    const b = (r.row_b ?? r.b ?? '').trim();
    const d = (r.decision ?? '').trim().toLowerCase();
    if (d && d !== 'same' && d !== 'distinct' && d !== 'unsure') throw new Error(`invalid decision "${r.decision}" for ${a}/${b}`);
    const [x, y] = a < b ? [a, b] : [b, a];
    return { a: x, b: y, decision: d as DecisionRow['decision'] };
  });
}

export interface DisbursementLine {
  id: string;
  walletAddress: string;
  amount: bigint;
  paymentId: string;
}

export interface DisbursementPlan {
  lines: DisbursementLine[];
  skipped: Array<{ id: string; duplicateOf: string }>;
  total: bigint;
}

export class UndecidedPairsError extends Error {
  constructor(readonly pairs: DedupPair[]) {
    super(`${pairs.length} likely_same pair(s) have no staff decision (same|distinct): ${pairs.map((p) => `${p.a}/${p.b}`).join(', ')}`);
  }
}

export function planDisbursement(sdpRows: CsvRow[], candidates: DedupPair[], decisions: DecisionRow[], idFilter?: (id: string) => boolean): DisbursementPlan {
  const byPair = new Map(decisions.map((d) => [`${d.a}|${d.b}`, d.decision]));
  const undecided = candidates.filter((p) => p.band === 'likely_same' && !['same', 'distinct'].includes(byPair.get(`${p.a}|${p.b}`) ?? ''));
  if (undecided.length > 0) throw new UndecidedPairsError(undecided);

  const skip = new Map<string, string>();
  for (const d of decisions) if (d.decision === 'same') skip.set(d.b, d.a); // b is the later row id
  const lines: DisbursementLine[] = [];
  const skipped: DisbursementPlan['skipped'] = [];
  let total = 0n;
  for (const r of sdpRows) {
    const id = r.id.trim();
    if (idFilter && !idFilter(id)) continue;
    if (skip.has(id)) {
      skipped.push({ id, duplicateOf: skip.get(id)! });
      continue;
    }
    const wallet = (r.walletAddress ?? '').trim();
    if (!/^G[A-Z2-7]{55}$/.test(wallet)) throw new Error(`row ${id}: walletAddress "${wallet}" is not a G-address (contract-account wallets are out of scope)`);
    const amount = parseAmount(r.amount);
    lines.push({ id, walletAddress: wallet, amount, paymentId: (r.paymentID ?? '').trim() });
    total += amount;
  }
  return { lines, skipped, total };
}

/** One issuance sandwich per recipient, from the issuer, sequence numbers consecutive. */
export function buildDisbursementTxs(plan: DisbursementPlan, issuer: string, startSequence: string, assetCode: string, networkPassphrase: string): Transaction[] {
  const acct = new Account(issuer, startSequence);
  const asset = new Asset(assetCode, issuer);
  return plan.lines.map((l) =>
    buildIssuance({ issuerAccount: acct, asset, recipient: l.walletAddress, amount: l.amount, networkPassphrase, memoText: l.paymentId }),
  );
}
