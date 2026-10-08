// A TypeScript model of the redeem_pool contract (same checks, same FIFO rules) used by
// the offline simulator. The contract itself is tested in contracts/redeem_pool.
export type Outcome = { kind: 'Paid'; amount: bigint } | { kind: 'Queued'; id: number; gap: bigint };

export class PoolModel {
  float = 0n;
  funded = 0n;
  paid = 0n;
  queued = 0n;
  clawed = 0n;
  withdrawn = 0n;
  head = 0;
  claims: Array<{ merchant: string; amount: bigint; at: number } | undefined> = [];
  paidTo = new Map<string, bigint>();

  constructor(
    readonly asset: string,
    public deadline: number,
  ) {}

  fund(amount: bigint): void {
    if (amount <= 0n) throw new Error('InvalidAmount');
    this.float += amount;
    this.funded += amount;
  }

  redeem(merchant: string, amount: bigint, now: number, active: boolean, voucherBalance: bigint): Outcome {
    if (amount <= 0n) throw new Error('InvalidAmount');
    if (now > this.deadline) throw new Error('RedemptionClosed');
    if (!active) throw new Error('MerchantNotActive');
    if (voucherBalance < amount) throw new Error('InsufficientVouchers');
    this.clawed += amount;
    if (this.head === this.claims.length && this.float >= amount) {
      this.float -= amount;
      this.paid += amount;
      this.paidTo.set(merchant, (this.paidTo.get(merchant) ?? 0n) + amount);
      return { kind: 'Paid', amount };
    }
    const id = this.claims.length;
    this.claims.push({ merchant, amount, at: now });
    this.queued += amount;
    return { kind: 'Queued', id, gap: amount > this.float ? amount - this.float : 0n };
  }

  settle(max: number): Array<{ id: number; merchant: string; amount: bigint }> {
    const out: Array<{ id: number; merchant: string; amount: bigint }> = [];
    while (this.head < this.claims.length && out.length < max) {
      const c = this.claims[this.head]!;
      if (this.float < c.amount) break;
      this.float -= c.amount;
      this.paid += c.amount;
      this.queued -= c.amount;
      this.paidTo.set(c.merchant, (this.paidTo.get(c.merchant) ?? 0n) + c.amount);
      out.push({ id: this.head, merchant: c.merchant, amount: c.amount });
      this.claims[this.head] = undefined;
      this.head++;
    }
    return out;
  }

  withdraw(amount: bigint, now: number): void {
    if (now <= this.deadline) throw new Error('WindowOpen');
    if (this.head !== this.claims.length) throw new Error('QueueNotEmpty');
    if (this.float < amount) throw new Error('InsufficientFloat');
    this.float -= amount;
    this.withdrawn += amount;
  }

  invariantsHold(): boolean {
    return this.clawed === this.paid + this.queued && this.float === this.funded - this.paid - this.withdrawn && this.queued >= 0n;
  }
}
