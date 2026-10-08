// Reading merchant_registry from the approval server. The interface lets tests use an
// in-memory registry; `CachedRegistryReader` adds the 60 s cache that bounds how long a
// suspension takes to reach the approval server.
import type { MerchantView } from './types.js';

export interface RegistryReader {
  getMerchant(address: string): Promise<MerchantView | undefined>;
}

export type Clock = () => number;
export const systemClock: Clock = () => Math.floor(Date.now() / 1000);

/** In-memory registry mirroring the contract's state machine (tests, simulator). */
export class MemoryRegistry implements RegistryReader {
  readonly records = new Map<string, MerchantView>();
  async getMerchant(address: string): Promise<MerchantView | undefined> {
    const r = this.records.get(address);
    return r ? { ...r } : undefined;
  }
  getSync(address: string): MerchantView | undefined {
    return this.records.get(address);
  }
  set(address: string, v: MerchantView): void {
    this.records.set(address, { ...v });
  }
  setStatus(address: string, status: MerchantView['status']): void {
    const r = this.records.get(address);
    if (!r) throw new Error(`no registry record for ${address}`);
    r.status = status;
  }
  delete(address: string): void {
    this.records.delete(address);
  }
}

export class CachedRegistryReader implements RegistryReader {
  private cache = new Map<string, { at: number; value: MerchantView | undefined }>();
  constructor(
    private readonly inner: RegistryReader,
    private readonly ttlSeconds = 60,
    private readonly clock: Clock = systemClock,
  ) {}
  async getMerchant(address: string): Promise<MerchantView | undefined> {
    const now = this.clock();
    const hit = this.cache.get(address);
    if (hit && now - hit.at < this.ttlSeconds) return hit.value;
    const value = await this.inner.getMerchant(address);
    this.cache.set(address, { at: now, value });
    return value;
  }
  invalidate(address?: string): void {
    if (address) this.cache.delete(address);
    else this.cache.clear();
  }
}
