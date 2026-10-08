// In-memory stand-in for merchant_registry's apply/approve/licence index (tests and the
// simulator). Mirrors the contract's rules that onboarding depends on.
import type { Transaction } from '@stellar/stellar-sdk';
import { decodeInvocation } from '../chain.js';
import type { MemoryRegistry } from '../sep8/registry-reader.js';
import type { Clock } from '../sep8/registry-reader.js';
import type { OnboardingChain } from './apply.js';

export class MemoryOnboardingChain implements OnboardingChain {
  readonly licences = new Map<string, string>();
  readonly appliedAt = new Map<string, number>();
  readonly activatedAt = new Map<string, number>();

  constructor(
    readonly registry: MemoryRegistry,
    private readonly clock: Clock,
  ) {}

  async licenceOwner(licenceHashHex: string): Promise<string | undefined> {
    return this.licences.get(licenceHashHex);
  }

  /** Agency enrolment of a legacy vendor (contract `enrol`). */
  enrol(merchant: string, licenceHashHex: string, categories: number, licenceExpires: number): void {
    if (this.licences.has(licenceHashHex)) throw new Error('LicenceInUse');
    this.licences.set(licenceHashHex, merchant);
    this.registry.set(merchant, { status: 'Active', categories, licenceExpires, selfOnboarded: false });
    this.appliedAt.set(merchant, this.clock());
    this.activatedAt.set(merchant, this.clock());
  }

  async submitApply(signed: Transaction): Promise<void> {
    const inv = decodeInvocation(signed);
    const [merchant, hash, mask] = inv.args as [string, Uint8Array, number];
    const hex = Buffer.from(hash).toString('hex');
    const owner = this.licences.get(hex);
    if (owner && owner !== String(merchant)) throw new Error('LicenceInUse');
    if (this.registry.getSync(String(merchant))) throw new Error('AlreadyExists');
    this.licences.set(hex, String(merchant));
    this.registry.set(String(merchant), { status: 'Pending', categories: Number(mask), licenceExpires: 0, selfOnboarded: true });
    this.appliedAt.set(String(merchant), this.clock());
  }

  async approve(merchant: string, licenceExpires: number): Promise<void> {
    const r = this.registry.getSync(merchant);
    if (!r || r.status !== 'Pending') throw new Error('BadState');
    if (licenceExpires <= this.clock()) throw new Error('LicenceExpired');
    this.registry.set(merchant, { ...r, status: 'Active', licenceExpires });
    this.activatedAt.set(merchant, this.clock());
  }
}
