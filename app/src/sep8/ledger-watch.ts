// Reservation watcher: converts a reservation into a spend when its revised transaction
// appears on the ledger, and releases it once its timebound has passed without it.
import type { Store } from '../store.js';
import type { Clock } from './registry-reader.js';

export interface LedgerSource {
  /** returns the close time (unix s) for each hash that is on the ledger */
  lookup(hashes: string[]): Promise<Map<string, number>>;
}

export class LedgerWatcher {
  constructor(
    private readonly store: Store,
    private readonly source: LedgerSource,
    private readonly clock: Clock,
  ) {}

  async poll(): Promise<{ confirmed: number; released: number }> {
    const now = this.clock();
    const live = this.store.entries().filter((e) => e.kind === 'reservation');
    if (live.length === 0) return { confirmed: 0, released: 0 };
    const seen = await this.source.lookup(live.map((e) => e.key));
    let confirmed = 0;
    let released = 0;
    for (const e of live) {
      const at = seen.get(e.key);
      if (at !== undefined) {
        if (this.store.confirmReservation(e.key, at)) confirmed++;
      } else if (e.expiresAt !== undefined && now >= e.expiresAt) {
        if (this.store.releaseReservation(e.key)) released++;
      }
    }
    return { confirmed, released };
  }
}

/** Horizon lookup (GET /transactions/:hash). Not exercised offline. */
export class HorizonLedgerSource implements LedgerSource {
  constructor(private readonly horizonUrl: string) {}
  async lookup(hashes: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const h of hashes) {
      const res = await fetch(`${this.horizonUrl.replace(/\/$/, '')}/transactions/${h}`);
      if (res.status === 200) {
        const body = (await res.json()) as { successful?: boolean; created_at?: string };
        if (body.successful && body.created_at) out.set(h, Math.floor(Date.parse(body.created_at) / 1000));
      }
    }
    return out;
  }
}

/** In-memory ledger for tests and the simulator. */
export class MemoryLedgerSource implements LedgerSource {
  readonly seen = new Map<string, number>();
  async lookup(hashes: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const h of hashes) {
      const at = this.seen.get(h);
      if (at !== undefined) out.set(h, at);
    }
    return out;
  }
}
