// Building the SEP-8 "sandwich": authorise → pay → back to maintain-liabilities.
//
// Recipient and merchant trustlines rest in AUTHORIZED_TO_MAINTAIN_LIABILITIES, so no
// voucher moves unless the issuer authorises both ends inside the same transaction.
// The approval signer (weight 1 on the issuer) can sign these SetTrustLineFlags ops
// (low threshold) but not a Payment or Clawback from the issuer (medium threshold).
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
  BASE_FEE,
  type xdr,
} from '@stellar/stellar-sdk';
import { toStellarAmount } from '../amount.js';

export const SANDWICH_OPS = 5;
export const MAX_TIMEBOUND_SECONDS = 300;

export function authorizeOp(issuer: string, trustor: string, asset: Asset): xdr.Operation {
  return Operation.setTrustLineFlags({ source: issuer, trustor, asset, flags: { authorized: true } });
}

export function restToMaintainLiabilitiesOp(issuer: string, trustor: string, asset: Asset): xdr.Operation {
  return Operation.setTrustLineFlags({
    source: issuer,
    trustor,
    asset,
    flags: { authorized: false, authorizedToMaintainLiabilities: true },
  });
}

export interface SandwichInput {
  original: Transaction;
  issuer: string;
  asset: Asset;
  destination: string;
  amount: bigint;
  rulesHashHex: string;
  now: number;
  timeboundSeconds: number;
  networkPassphrase: string;
}

/**
 * Wraps the single payment of `original` in the five-op sandwich. Sequence number and
 * source come from the original; the per-op fee is the original's total fee (so the new
 * total covers five ops); timebounds are [now, now + min(timebound, 300)]; the memo is
 * MEMO_HASH = sha256(rules.json).
 */
export function buildSandwich(input: SandwichInput): Transaction {
  const { original, issuer, asset } = input;
  const source = original.source;
  const payer = new Account(source, (BigInt(original.sequence) - 1n).toString());
  const origOps = Math.max(1, original.operations.length);
  const perOp = BigInt(original.fee) / BigInt(origOps);
  const fee = (perOp > BigInt(BASE_FEE) ? perOp : BigInt(BASE_FEE)).toString();
  const window = Math.min(input.timeboundSeconds, MAX_TIMEBOUND_SECONDS);
  const tx = new TransactionBuilder(payer, {
    fee,
    networkPassphrase: input.networkPassphrase,
    timebounds: { minTime: input.now, maxTime: input.now + window },
    memo: Memo.hash(input.rulesHashHex),
  })
    .addOperation(authorizeOp(issuer, source, asset))
    .addOperation(authorizeOp(issuer, input.destination, asset))
    .addOperation(Operation.payment({ destination: input.destination, asset, amount: toStellarAmount(input.amount) }))
    .addOperation(restToMaintainLiabilitiesOp(issuer, input.destination, asset))
    .addOperation(restToMaintainLiabilitiesOp(issuer, source, asset))
    .build();
  return tx;
}

/**
 * Issuance sandwich used by `voucher disburse` (stand-in for SDP): authorise the
 * recipient, issuer payment, back to maintain-liabilities. Signed by the agency ops key
 * (weight 10, medium threshold), never by the approval signer.
 */
export function buildIssuance(opts: {
  issuerAccount: Account;
  asset: Asset;
  recipient: string;
  amount: bigint;
  networkPassphrase: string;
  timeoutSeconds?: number;
  memoText?: string;
}): Transaction {
  const b = new TransactionBuilder(opts.issuerAccount, {
    fee: BASE_FEE,
    networkPassphrase: opts.networkPassphrase,
    memo: opts.memoText ? Memo.text(opts.memoText.slice(0, 28)) : Memo.none(),
  })
    .addOperation(Operation.setTrustLineFlags({ trustor: opts.recipient, asset: opts.asset, flags: { authorized: true } }))
    .addOperation(Operation.payment({ destination: opts.recipient, asset: opts.asset, amount: toStellarAmount(opts.amount) }))
    .addOperation(
      Operation.setTrustLineFlags({
        trustor: opts.recipient,
        asset: opts.asset,
        flags: { authorized: false, authorizedToMaintainLiabilities: true },
      }),
    )
    .setTimeout(opts.timeoutSeconds ?? 300);
  return b.build();
}

export function signWith(tx: Transaction, kp: Keypair): Transaction {
  tx.sign(kp);
  return tx;
}
