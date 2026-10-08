// The approval service: parse → summarise → evaluate (pure rules) → build and co-sign
// the sandwich → reserve the amount against the caps. Network-free; the HTTP wrapper
// (server.ts) and the simulator both call `approve`.
import { Asset, Keypair } from '@stellar/stellar-sdk';
import type { Programme, Rules } from '../config.js';
import { formatAmount } from '../amount.js';
import type { Store } from '../store.js';
import type { Clock, RegistryReader } from './registry-reader.js';
import { evaluate } from './rules.js';
import { buildSandwich } from './sandwich.js';
import { parseTx, summarise, txHashHex } from './tx.js';
import type { Decision, MerchantView, RuleState, Sep8Response, TxSummary } from './types.js';

export interface ApprovalConfig {
  programme: Programme;
  rules: Rules;
  issuer: string;
  approvalSigner: Keypair;
  networkPassphrase: string;
  store: Store;
  registry: RegistryReader;
  clock: Clock;
}

export interface ApprovalOutcome {
  response: Sep8Response;
  decision?: Decision;
  /** hash of the revised transaction, when revised */
  revisedHash?: string;
  /** true when served from the idempotency cache */
  cached: boolean;
}

export function ruleState(
  cfg: Pick<ApprovalConfig, 'programme' | 'rules' | 'issuer' | 'store'>,
  summary: TxSummary,
  merchant: MerchantView | undefined,
): RuleState {
  const op = summary.ops[0];
  const source = op?.source ?? summary.source;
  const dest = op?.destination ?? '';
  const asset = op?.assetCode ?? '';
  return {
    programme: {
      start: cfg.programme.start,
      expiry: cfg.programme.expiry,
      tzOffsetSeconds: cfg.programme.tzOffsetSeconds,
    },
    issuer: cfg.issuer,
    assets: cfg.rules.assets,
    recipient: (a) => cfg.store.getRecipient(a),
    merchant: (a) => (a === dest ? merchant : undefined),
    history: cfg.store.history(source, asset),
  };
}

export class ApprovalService {
  constructor(readonly cfg: ApprovalConfig) {}

  async approve(xdrB64: string): Promise<ApprovalOutcome> {
    const { cfg } = this;
    const now = cfg.clock();
    let tx;
    try {
      tx = parseTx(xdrB64, cfg.networkPassphrase);
    } catch (e) {
      return { response: { status: 'rejected', error: (e as Error).message }, cached: false };
    }
    const key = txHashHex(tx);
    const cached = cfg.store.getResult(key, now);
    if (cached) return { response: cached, cached: true };

    const summary = summarise(tx);
    const dest = summary.ops[0]?.destination;
    const merchant = dest ? await cfg.registry.getMerchant(dest) : undefined;
    const decision = evaluate(summary, ruleState(cfg, summary, merchant), now);
    if (!decision.ok) {
      const op = summary.ops[0];
      cfg.store.logRefusal({
        at: now,
        code: decision.code,
        source: op?.source ?? summary.source,
        destination: op?.destination ?? '',
        asset: op?.assetCode ?? '',
        amount: op?.amount ?? 0n,
      });
      return {
        response: { status: 'rejected', error: `${decision.code}: ${decision.message}`, code: decision.code },
        decision,
        cached: false,
      };
    }

    const revised = buildSandwich({
      original: tx,
      issuer: cfg.issuer,
      asset: new Asset(decision.asset.code, cfg.issuer),
      destination: decision.destination,
      amount: decision.amount,
      rulesHashHex: cfg.rules.hash,
      now,
      timeboundSeconds: cfg.rules.file.timebound_seconds,
      networkPassphrase: cfg.networkPassphrase,
    });
    revised.sign(cfg.approvalSigner);
    const expiresAt = Number(revised.timeBounds?.maxTime ?? now + 300);
    const revisedHash = txHashHex(revised);
    cfg.store.addReservation({
      key: revisedHash,
      source: decision.source,
      destination: decision.destination,
      asset: decision.asset.code,
      amount: decision.amount,
      at: now,
      kind: 'reservation',
      expiresAt,
    });
    const response: Sep8Response = {
      status: 'revised',
      tx: revised.toXDR(),
      message: `Approved ${formatAmount(decision.amount)} ${decision.asset.code} under rules ${cfg.rules.hash.slice(0, 12)}; sign and submit before ${new Date(expiresAt * 1000).toISOString()}.`,
    };
    cfg.store.putResult(key, { response, expiresAt });
    return { response, decision, revisedHash, cached: false };
  }
}
