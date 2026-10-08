import { resolve } from 'node:path';
import { Account, Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder, type xdr } from '@stellar/stellar-sdk';
import { loadProgramme, loadRules, PROJECT_ROOT, type Programme, type Rules } from '../src/config.js';
import { toStellarAmount, parseAmount } from '../src/amount.js';
import { ApprovalService } from '../src/sep8/approve.js';
import { MemoryRegistry } from '../src/sep8/registry-reader.js';
import { MemoryStore } from '../src/store.js';
import type { MerchantView, SpendEntry } from '../src/sep8/types.js';
import { simKeypair, SIM } from '../src/keys.js';

export const PASSPHRASE = Networks.TESTNET;
export const FIXTURES = resolve(PROJECT_ROOT, 'app/test/fixtures');
export const programme: Programme = loadProgramme();
export const rules: Rules = loadRules();
export const issuerKp = SIM.issuer();
export const ISSUER = issuerKp.publicKey();
export const approvalSigner = SIM.approvalSigner();

/** 2026-09-10 10:00 +03:00 (programme day 9). */
export const T = programme.start + 9 * 86_400 + 10 * 3600;

export const alice = simKeypair('test/alice'); // food recipient
export const bob = simKeypair('test/bob'); // food recipient
export const farmer = simKeypair('test/farmer'); // agri recipient
export const shop = simKeypair('test/shop'); // food merchant
export const agrovet = simKeypair('test/agrovet'); // agri merchant
export const general = simKeypair('test/general'); // food + agri merchant

export const ACTIVE_FOOD: MerchantView = { status: 'Active', categories: 1, licenceExpires: programme.start + 400 * 86_400 };

export function amt(s: string): bigint {
  return parseAmount(s);
}

export function paymentTx(opts: {
  from: string;
  to: string;
  code?: string;
  amount: string;
  issuer?: string;
  seq?: string;
  fee?: string;
  extra?: xdr.Operation[];
}): string {
  const b = new TransactionBuilder(new Account(opts.from, opts.seq ?? '41'), { fee: opts.fee ?? BASE_FEE, networkPassphrase: PASSPHRASE }).addOperation(
    Operation.payment({ destination: opts.to, asset: new Asset(opts.code ?? 'OVFOOD', opts.issuer ?? ISSUER), amount: opts.amount }),
  );
  for (const op of opts.extra ?? []) b.addOperation(op);
  return b.setTimeout(0).build().toXDR();
}

export interface World {
  store: MemoryStore;
  registry: MemoryRegistry;
  service: ApprovalService;
  clock: { now: number };
}

export function world(now = T): World {
  const store = new MemoryStore();
  const registry = new MemoryRegistry();
  const clock = { now };
  store.putRecipient({ address: alice.publicKey(), assets: ['OVFOOD'], suspended: false });
  store.putRecipient({ address: bob.publicKey(), assets: ['OVFOOD'], suspended: false });
  store.putRecipient({ address: farmer.publicKey(), assets: ['OVAGRI'], suspended: false });
  registry.set(shop.publicKey(), ACTIVE_FOOD);
  registry.set(agrovet.publicKey(), { ...ACTIVE_FOOD, categories: 2 });
  registry.set(general.publicKey(), { ...ACTIVE_FOOD, categories: 3 });
  const service = new ApprovalService({
    programme,
    rules,
    issuer: ISSUER,
    approvalSigner,
    networkPassphrase: PASSPHRASE,
    store,
    registry,
    clock: () => clock.now,
  });
  return { store, registry, service, clock };
}

export function spend(source: string, amount: string, at: number, kind: SpendEntry['kind'] = 'spend', expiresAt?: number): SpendEntry {
  return { key: `${source}-${at}-${amount}-${kind}`, source, destination: shop.publicKey(), asset: 'OVFOOD', amount: parseAmount(amount), at, kind, expiresAt };
}

export { toStellarAmount, Keypair };
