// Approval-server state: recipients, spends, reservations, cached results, refusal log and
// onboarding log. `MemoryStore` is used by tests and the simulator; `JsonFileStore`
// persists the same data to one JSON file for the demo server.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ReasonCode, RecipientView, Sep8Response, SpendEntry } from './sep8/types.js';

export interface RefusalLog {
  at: number;
  code: ReasonCode;
  source: string;
  destination: string;
  asset: string;
  amount: bigint;
}

export interface OnboardingLog {
  at: number;
  merchant: string;
  licenceHash: string;
  status: 'active' | 'pending_review' | 'rejected';
  reason?: string;
  appliedAt: number;
  activatedAt?: number;
  businessName: string;
  similarity?: number;
}

export interface CachedResult {
  response: Sep8Response;
  expiresAt: number;
}

export interface Store {
  getRecipient(address: string): RecipientView | undefined;
  putRecipient(r: RecipientView): void;
  recipients(): RecipientView[];

  /** spends + reservations of `source` in `asset` */
  history(source: string, asset: string): SpendEntry[];
  addReservation(e: SpendEntry): void;
  /** reservation → spend (seen on the ledger); returns false if unknown */
  confirmReservation(key: string, seenAt: number): boolean;
  releaseReservation(key: string): boolean;
  addSpend(e: SpendEntry): void;
  entries(): SpendEntry[];

  getResult(key: string, now: number): Sep8Response | undefined;
  putResult(key: string, r: CachedResult): void;

  logRefusal(r: RefusalLog): void;
  refusals(): RefusalLog[];

  logOnboarding(e: OnboardingLog): void;
  onboarding(): OnboardingLog[];
}

export class MemoryStore implements Store {
  protected recips = new Map<string, RecipientView>();
  protected byKey = new Map<string, SpendEntry>();
  protected bySourceAsset = new Map<string, SpendEntry[]>();
  protected results = new Map<string, CachedResult>();
  protected refusalLog: RefusalLog[] = [];
  protected onboardingLog: OnboardingLog[] = [];

  getRecipient(address: string): RecipientView | undefined {
    return this.recips.get(address);
  }
  putRecipient(r: RecipientView): void {
    this.recips.set(r.address, r);
    this.changed();
  }
  recipients(): RecipientView[] {
    return [...this.recips.values()];
  }

  history(source: string, asset: string): SpendEntry[] {
    return this.bySourceAsset.get(`${source}|${asset}`) ?? [];
  }
  private index(e: SpendEntry): void {
    this.byKey.set(e.key, e);
    const k = `${e.source}|${e.asset}`;
    const list = this.bySourceAsset.get(k);
    if (list) list.push(e);
    else this.bySourceAsset.set(k, [e]);
  }
  addReservation(e: SpendEntry): void {
    if (this.byKey.has(e.key)) return; // idempotent
    this.index({ ...e, kind: 'reservation' });
    this.changed();
  }
  confirmReservation(key: string, seenAt: number): boolean {
    const e = this.byKey.get(key);
    if (!e || e.kind !== 'reservation') return false;
    e.kind = 'spend';
    e.at = Math.min(e.at, seenAt);
    delete e.expiresAt;
    this.changed();
    return true;
  }
  releaseReservation(key: string): boolean {
    const e = this.byKey.get(key);
    if (!e || e.kind !== 'reservation') return false;
    this.byKey.delete(key);
    const k = `${e.source}|${e.asset}`;
    this.bySourceAsset.set(
      k,
      (this.bySourceAsset.get(k) ?? []).filter((x) => x.key !== key),
    );
    this.changed();
    return true;
  }
  addSpend(e: SpendEntry): void {
    if (this.byKey.has(e.key)) return;
    this.index({ ...e, kind: 'spend' });
    this.changed();
  }
  entries(): SpendEntry[] {
    return [...this.byKey.values()];
  }

  getResult(key: string, now: number): Sep8Response | undefined {
    const r = this.results.get(key);
    if (!r) return undefined;
    if (now >= r.expiresAt) return undefined;
    return r.response;
  }
  putResult(key: string, r: CachedResult): void {
    this.results.set(key, r);
    this.changed();
  }

  logRefusal(r: RefusalLog): void {
    this.refusalLog.push(r);
    this.changed();
  }
  refusals(): RefusalLog[] {
    return this.refusalLog;
  }

  logOnboarding(e: OnboardingLog): void {
    this.onboardingLog.push(e);
    this.changed();
  }
  onboarding(): OnboardingLog[] {
    return this.onboardingLog;
  }

  /** hook for persistence */
  protected changed(): void {}
}

// ------------------------------------------------------------------ JSON persistence

type Json = Record<string, unknown>;

function reviveEntry(e: Json): SpendEntry {
  return { ...(e as unknown as SpendEntry), amount: BigInt(e.amount as string) };
}

export class JsonFileStore extends MemoryStore {
  private loading = false;
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      this.loading = true;
      const doc = JSON.parse(readFileSync(path, 'utf8')) as Json;
      for (const r of (doc.recipients as RecipientView[]) ?? []) this.putRecipient(r);
      for (const e of (doc.entries as Json[]) ?? []) {
        const s = reviveEntry(e);
        if (s.kind === 'spend') this.addSpend(s);
        else this.addReservation(s);
      }
      for (const [k, v] of Object.entries((doc.results as Record<string, CachedResult>) ?? {})) this.putResult(k, v);
      for (const r of (doc.refusals as Json[]) ?? []) this.logRefusal({ ...(r as unknown as RefusalLog), amount: BigInt(r.amount as string) });
      for (const o of (doc.onboarding as OnboardingLog[]) ?? []) this.logOnboarding(o);
      this.loading = false;
    }
  }
  protected override changed(): void {
    if (this.loading) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const doc = {
      recipients: this.recipients(),
      entries: this.entries(),
      results: Object.fromEntries(this.results),
      refusals: this.refusals(),
      onboarding: this.onboarding(),
    };
    writeFileSync(this.path, JSON.stringify(doc, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  }
}
