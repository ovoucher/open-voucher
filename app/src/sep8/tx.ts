// Parsing a submitted transaction into the summary the rule engine reads.
import { FeeBumpTransaction, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { parseAmount } from '../amount.js';
import type { OpSummary, TxSummary } from './types.js';

export function parseTx(xdrB64: string, networkPassphrase: string): Transaction {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(xdrB64, networkPassphrase);
  } catch (e) {
    throw new Error(`not a valid transaction envelope: ${(e as Error).message}`);
  }
  if (parsed instanceof FeeBumpTransaction) {
    throw new Error('submit the inner transaction, not a fee-bump envelope');
  }
  return parsed;
}

export function summarise(tx: Transaction): TxSummary {
  const ops: OpSummary[] = tx.operations.map((op) => {
    const base: OpSummary = { type: op.type, source: op.source };
    if (op.type === 'payment') {
      return {
        ...base,
        destination: op.destination,
        assetCode: op.asset.isNative() ? undefined : op.asset.getCode(),
        assetIssuer: op.asset.isNative() ? undefined : op.asset.getIssuer(),
        amount: parseAmount(op.amount),
      };
    }
    return base;
  });
  return { source: tx.source, ops };
}

/** Hex hash of a transaction for a network (the id Horizon shows). */
export function txHashHex(tx: Transaction | FeeBumpTransaction): string {
  return Buffer.from(tx.hash()).toString('hex');
}
