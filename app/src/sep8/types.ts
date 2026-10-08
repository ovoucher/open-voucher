// Shared types for the SEP-8 approval pipeline.
import type { AssetRule } from '../config.js';

export const REASON_CODES = [
  'NOT_SINGLE_PAYMENT',
  'WRONG_ASSET',
  'PROGRAMME_NOT_ACTIVE',
  'SOURCE_NOT_BENEFICIARY',
  'BENEFICIARY_SUSPENDED',
  'PEER_TO_PEER',
  'MERCHANT_NOT_REGISTERED',
  'MERCHANT_NOT_ACTIVE',
  'CATEGORY_MISMATCH',
  'AMOUNT_INVALID',
  'DAILY_CAP',
  'WEEKLY_CAP',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type MerchantStatus = 'Pending' | 'Active' | 'Suspended' | 'Revoked';

/** What the approval server needs from a `merchant_registry` record. */
export interface MerchantView {
  status: MerchantStatus;
  categories: number;
  /** unix seconds; `is_active` requires now < licenceExpires */
  licenceExpires: number;
  selfOnboarded?: boolean;
}

export interface RecipientView {
  address: string;
  /** voucher asset codes this recipient is enrolled for */
  assets: string[];
  suspended: boolean;
}

/** One operation of the submitted transaction, reduced to what the rules read. */
export interface OpSummary {
  type: string;
  source?: string;
  destination?: string;
  assetCode?: string;
  assetIssuer?: string;
  amount?: bigint;
}

export interface TxSummary {
  source: string;
  ops: OpSummary[];
}

/** An approved spend (seen on the ledger) or a live reservation (approved, not yet seen). */
export interface SpendEntry {
  key: string;
  source: string;
  destination: string;
  asset: string;
  amount: bigint;
  at: number;
  kind: 'spend' | 'reservation';
  /** reservations only: released when now >= expiresAt and not seen on the ledger */
  expiresAt?: number;
}

export interface RuleState {
  programme: { start: number; expiry: number; tzOffsetSeconds: number };
  issuer: string;
  assets: ReadonlyMap<string, AssetRule>;
  recipient(address: string): RecipientView | undefined;
  merchant(address: string): MerchantView | undefined;
  /** spends + reservations of this source in this asset (the engine filters by time) */
  history: readonly SpendEntry[];
}

export type Decision =
  | {
      ok: true;
      asset: AssetRule;
      source: string;
      destination: string;
      amount: bigint;
      usedToday: bigint;
      usedWeek: bigint;
    }
  | { ok: false; code: ReasonCode; message: string };

export type Sep8Response =
  | { status: 'revised'; tx: string; message: string }
  | { status: 'rejected'; error: string; code?: ReasonCode };
