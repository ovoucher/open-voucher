// `voucher expire`: after programme expiry, claw back unspent recipient balances with
// classic Clawback ops (medium threshold → agency ops key), at most 100 ops per tx.
// Merchant balances are not touched: they stay redeemable until redeem_deadline.
// Idempotent: it reads current balances and claws back only non-zero ones.
import { Account, Asset, BASE_FEE, Operation, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { toStellarAmount } from '../amount.js';

export const MAX_OPS_PER_TX = 100;

export interface Holding {
  address: string;
  asset: string;
  balance: bigint;
}

export interface ExpiryPlan {
  batches: Holding[][];
  totals: Record<string, bigint>;
  skippedMerchants: number;
}

export function planExpiry(holdings: Holding[], isRecipient: (address: string) => boolean): ExpiryPlan {
  const todo: Holding[] = [];
  let skippedMerchants = 0;
  const totals: Record<string, bigint> = {};
  for (const h of holdings) {
    if (!isRecipient(h.address)) {
      if (h.balance > 0n) skippedMerchants++;
      continue;
    }
    if (h.balance <= 0n) continue;
    todo.push(h);
    totals[h.asset] = (totals[h.asset] ?? 0n) + h.balance;
  }
  todo.sort((a, b) => (a.asset === b.asset ? (a.address < b.address ? -1 : 1) : a.asset < b.asset ? -1 : 1));
  const batches: Holding[][] = [];
  for (let i = 0; i < todo.length; i += MAX_OPS_PER_TX) batches.push(todo.slice(i, i + MAX_OPS_PER_TX));
  return { batches, totals, skippedMerchants };
}

export function buildClawbackTxs(plan: ExpiryPlan, issuer: string, startSequence: string, networkPassphrase: string): Transaction[] {
  const acct = new Account(issuer, startSequence);
  return plan.batches.map((batch) => {
    const b = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase });
    for (const h of batch) b.addOperation(Operation.clawback({ asset: new Asset(h.asset, issuer), from: h.address, amount: toStellarAmount(h.balance) }));
    return b.setTimeout(300).build();
  });
}
