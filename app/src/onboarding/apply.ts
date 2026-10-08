// Merchant self-onboarding: licence lookup against the agency-signed registry, then the
// on-chain apply (merchant-signed) and approve (verifier-signed) in one request.
import { Keypair, type Transaction } from '@stellar/stellar-sdk';
import type { Rules } from '../config.js';
import { decodeInvocation } from '../chain.js';
import type { Store } from '../store.js';
import { tokenSetSimilarity } from '../strings.js';
import type { Clock } from '../sep8/registry-reader.js';
import { parseTx } from '../sep8/tx.js';
import { licenceHash } from './licence.js';
import type { LicenceRecord, LicenceRegistry } from './licence-registry.js';

export type RejectReason = 'LICENCE_NOT_FOUND' | 'LICENCE_EXPIRED' | 'LICENCE_CLASS_NOT_ALLOWED' | 'LICENCE_IN_USE' | 'BAD_SIGNATURE';

export interface ApplyRequest {
  address: string;
  businessName: string;
  licenceNumber: string;
  issuingAuthority: string;
  categories: string[];
  /** base64 XDR of a transaction invoking merchant_registry.apply, signed by `address` */
  signedApplyTx: string;
}

export type ApplyResult =
  | { status: 'active'; licenceHash: string; similarity: number; licenceExpires: number }
  | { status: 'pending_review'; licenceHash: string; similarity: number }
  | { status: 'rejected'; reason: RejectReason; detail: string };

/** The chain operations onboarding needs; RPC-backed in production, in-memory in tests. */
export interface OnboardingChain {
  licenceOwner(licenceHashHex: string): Promise<string | undefined>;
  submitApply(signed: Transaction): Promise<void>;
  approve(merchant: string, licenceExpires: number): Promise<void>;
}

export interface OnboardingConfig {
  rules: Rules;
  registry: LicenceRegistry;
  chain: OnboardingChain;
  store: Store;
  clock: Clock;
  networkPassphrase: string;
  registryContractId: string;
  /** seconds added to 00:00 UTC of the expiry date (programme-local end of day) */
  tzOffsetSeconds: number;
}

export function categoryMask(rules: Rules, categories: string[]): number {
  let mask = 0;
  for (const c of categories) {
    const bit = rules.file.category_bits[c.trim().toLowerCase()];
    if (!bit) throw new Error(`unknown category "${c}"`);
    mask |= bit;
  }
  return mask;
}

/** Last second of the licence's expiry date in programme-local time. */
export function licenceExpiryUnix(expires: string, tzOffsetSeconds: number): number {
  const midnightUtc = Date.parse(`${expires}T00:00:00Z`) / 1000;
  if (Number.isNaN(midnightUtc)) throw new Error(`invalid licence expiry "${expires}"`);
  return midnightUtc - tzOffsetSeconds + 86_400 - 1;
}

/** Checks that the signed tx is `address` calling registry.apply(address, hash, mask). */
export function checkApplyTx(
  xdrB64: string,
  cfg: Pick<OnboardingConfig, 'networkPassphrase' | 'registryContractId'>,
  address: string,
  hashHex: string,
  mask: number,
): { ok: true; tx: Transaction } | { ok: false; detail: string } {
  let tx: Transaction;
  try {
    tx = parseTx(xdrB64, cfg.networkPassphrase);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  if (tx.source !== address) return { ok: false, detail: 'transaction source is not the applying address' };
  let kp: Keypair;
  try {
    kp = Keypair.fromPublicKey(address);
  } catch {
    return { ok: false, detail: 'address is not a valid account id' };
  }
  const hash = tx.hash();
  const signed = tx.signatures.some((s) => {
    try {
      return Buffer.from(s.hint.toBytes()).equals(Buffer.from(kp.signatureHint())) && kp.verify(hash, s.signature.toBytes());
    } catch {
      return false;
    }
  });
  if (!signed) return { ok: false, detail: 'no valid signature by the applying address' };
  let inv;
  try {
    inv = decodeInvocation(tx);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  if (inv.contractId !== cfg.registryContractId || inv.method !== 'apply') {
    return { ok: false, detail: 'transaction does not call merchant_registry.apply' };
  }
  const [a, h, m] = inv.args as [unknown, unknown, unknown];
  const hArg = h instanceof Uint8Array ? Buffer.from(h).toString('hex') : '';
  if (String(a) !== address || hArg !== hashHex || Number(m) !== mask) {
    return { ok: false, detail: 'apply arguments do not match the application' };
  }
  return { ok: true, tx };
}

export class Onboarding {
  constructor(readonly cfg: OnboardingConfig) {}

  private log(req: ApplyRequest, hashHex: string, appliedAt: number, res: ApplyResult, activatedAt?: number): void {
    this.cfg.store.logOnboarding({
      at: this.cfg.clock(),
      merchant: req.address,
      licenceHash: hashHex,
      status: res.status,
      reason: res.status === 'rejected' ? res.reason : undefined,
      appliedAt,
      activatedAt,
      businessName: req.businessName,
      similarity: res.status === 'rejected' ? undefined : res.similarity,
    });
  }

  async apply(req: ApplyRequest): Promise<ApplyResult> {
    const { cfg } = this;
    const appliedAt = cfg.clock();
    const hashHex = licenceHash(req.issuingAuthority, req.licenceNumber);
    const reject = (reason: RejectReason, detail: string): ApplyResult => {
      const r: ApplyResult = { status: 'rejected', reason, detail };
      this.log(req, hashHex, appliedAt, r);
      return r;
    };

    let mask: number;
    try {
      mask = categoryMask(cfg.rules, req.categories);
    } catch (e) {
      return reject('LICENCE_CLASS_NOT_ALLOWED', (e as Error).message);
    }
    const sig = checkApplyTx(req.signedApplyTx, cfg, req.address, hashHex, mask);
    if (!sig.ok) return reject('BAD_SIGNATURE', sig.detail);

    const rec: LicenceRecord | undefined = cfg.registry.lookup(req.issuingAuthority, req.licenceNumber);
    if (!rec) return reject('LICENCE_NOT_FOUND', `no licence ${req.licenceNumber} from ${req.issuingAuthority} in the agency registry`);

    const expiresUnix = licenceExpiryUnix(rec.expires, cfg.tzOffsetSeconds);
    const minDays = cfg.rules.file.min_licence_days;
    if (rec.status !== 'valid') return reject('LICENCE_EXPIRED', `licence status is "${rec.status}"`);
    if (expiresUnix <= appliedAt + minDays * 86_400) {
      return reject('LICENCE_EXPIRED', `licence expires ${rec.expires}, less than ${minDays} days from now`);
    }

    const allowed = cfg.rules.file.licence_classes[rec.licenceClass] ?? [];
    const notAllowed = req.categories.map((c) => c.trim().toLowerCase()).filter((c) => !allowed.includes(c as never));
    if (notAllowed.length > 0) {
      return reject('LICENCE_CLASS_NOT_ALLOWED', `licence class ${rec.licenceClass} does not allow ${notAllowed.join(', ')}`);
    }

    const owner = await cfg.chain.licenceOwner(hashHex);
    if (owner && owner !== req.address) return reject('LICENCE_IN_USE', 'licence is already bound to another merchant address');

    const similarity = Math.round(tokenSetSimilarity(req.businessName, rec.businessName) * 1000) / 1000;
    await cfg.chain.submitApply(sig.tx);
    if (similarity < cfg.rules.file.name_match_threshold) {
      const r: ApplyResult = { status: 'pending_review', licenceHash: hashHex, similarity };
      this.log(req, hashHex, appliedAt, r);
      return r;
    }
    await cfg.chain.approve(req.address, expiresUnix);
    const r: ApplyResult = { status: 'active', licenceHash: hashHex, similarity, licenceExpires: expiresUnix };
    this.log(req, hashHex, appliedAt, r, cfg.clock());
    return r;
  }
}
