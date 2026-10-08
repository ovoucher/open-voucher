// `voucher simulate`: an offline run of the whole seed through the real approval service
// (XDR in, co-signed sandwich out), onboarding service, disbursement planner, expiry
// planner and a model of the redemption pools, over an in-memory ledger. No RPC.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Account, Asset, BASE_FEE, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { parseAmount, toStellarAmount } from '../amount.js';
import { loadProgramme, loadRules, SEED_DIR, type Programme, type Rules } from '../config.js';
import { parseCsv } from '../csv.js';
import { heuristicDedup, type DedupRow } from '../ai/dedup.js';
import { SIM, simKeypair } from '../keys.js';
import { Onboarding } from '../onboarding/apply.js';
import { licenceHash } from '../onboarding/licence.js';
import { LicenceRegistry } from '../onboarding/licence-registry.js';
import { MemoryOnboardingChain } from '../onboarding/memory-chain.js';
import { buildDisbursementTxs, parseDecisions, planDisbursement } from '../ops/disburse.js';
import { buildClawbackTxs, planExpiry, type Holding } from '../ops/expire.js';
import { ApprovalService } from '../sep8/approve.js';
import { LedgerWatcher, MemoryLedgerSource } from '../sep8/ledger-watch.js';
import { CachedRegistryReader, MemoryRegistry } from '../sep8/registry-reader.js';
import { MemoryStore } from '../store.js';
import type { EventLog } from '../report/figures.js';
import { PoolModel } from './pool-model.js';

const DAY = 86_400;

export interface SimOptions {
  seedDir?: string;
  weeks?: number;
  networkPassphrase?: string;
}

export interface SimResult {
  programme: string;
  attempts: number;
  approved: number;
  refused: number;
  refusalsByCode: Record<string, number>;
  plantedOutcome: Record<string, { attempts: number; refusedAsExpected: number }>;
  falseRefusals: number;
  failedSubmissions: number;
  disbursed: Record<string, bigint>;
  spent: Record<string, bigint>;
  unspentDay28: Record<string, bigint>;
  clawedAtExpiry: Record<string, bigint>;
  clawbackTxs: number;
  merchantReceipts: Record<string, bigint>;
  redeemedPaid: Record<string, bigint>;
  queuedAfterWeek4: Record<string, bigint>;
  queuedFinal: Record<string, bigint>;
  surplusWithdrawn: Record<string, bigint>;
  rounds: Array<{ asset: string; day: number; redemptions: Array<{ merchant: string; amount: bigint; outcome: string }> }>;
  onboarding: Array<{ merchant: string; status: string; reason?: string; minutes?: number }>;
  skippedDuplicates: number;
  disbursementTxs: number;
  invariants: boolean;
  events: EventLog;
  /** balances just after expiry (before clawback), for `voucher expire --holdings` */
  holdingsDay28: { recipients: string[]; holdings: Array<{ address: string; asset: string; balance: string }> };
}

interface AttemptLine {
  i: number;
  at: string;
  from: string;
  to: string;
  to_label: string;
  asset: string;
  amount: string;
  plant: string;
}

type Ev = { at: number; order: number; run: () => Promise<void> | void };

export async function simulate(opts: SimOptions = {}): Promise<SimResult> {
  const dir = opts.seedDir ?? SEED_DIR;
  const passphrase = opts.networkPassphrase ?? Networks.TESTNET;
  const programme: Programme = loadProgramme(resolve(dir, 'programme.json'));
  const rules: Rules = loadRules(resolve(dir, 'rules.json'));
  const weeks = opts.weeks ?? 4;
  const lastSpendDay = weeks * 7;
  const issuerKp = SIM.issuer();
  const issuer = issuerKp.publicKey();
  const read = (n: string) => readFileSync(resolve(dir, n), 'utf8');

  let now = programme.start - 3 * DAY;
  const clock = () => now;
  const store = new MemoryStore();
  const registry = new MemoryRegistry();
  const chain = new MemoryOnboardingChain(registry, clock);
  const ledgerSrc = new MemoryLedgerSource();
  const watcher = new LedgerWatcher(store, ledgerSrc, clock);
  const approval = new ApprovalService({
    programme,
    rules,
    issuer,
    approvalSigner: SIM.approvalSigner(),
    networkPassphrase: passphrase,
    store,
    registry: new CachedRegistryReader(registry, rules.file.registry_cache_seconds, clock),
    clock,
  });

  const balances = new Map<string, bigint>();
  const bal = (a: string, asset: string) => balances.get(`${a}|${asset}`) ?? 0n;
  const addBal = (a: string, asset: string, v: bigint) => balances.set(`${a}|${asset}`, bal(a, asset) + v);

  const events: EventLog = { programme: programme.id, disbursements: [], payments: [], pool: [], merchants: [], clawbacks: [] };

  // ---------------------------------------------------------------- dedup + disbursement plan
  const ben = parseCsv(read('beneficiaries.csv')).rows;
  const dedupRows: DedupRow[] = ben.map((r) => ({
    rowId: r.row_id,
    fullName: r.full_name,
    dob: r.dob,
    phone: r.phone,
    nationalId: r.national_id,
    householdSize: Number(r.household_size),
    location: r.location,
  }));
  const candidates = heuristicDedup(dedupRows);
  const decisions = parseDecisions(parseCsv(read('dedup-decisions.csv')).rows);
  const sdp = parseCsv(read('sdp-disbursement.csv')).rows;
  const catOf = new Map(ben.map((r) => [r.row_id, r.category]));
  const plans = {
    OVFOOD: planDisbursement(sdp, candidates, decisions, (id) => catOf.get(id) === 'food'),
    OVAGRI: planDisbursement(sdp, candidates, decisions, (id) => catOf.get(id) === 'agri'),
  };
  let disbursementTxs = 0;
  for (const [asset, plan] of Object.entries(plans)) {
    for (const l of plan.lines) {
      const prev = store.getRecipient(l.walletAddress);
      store.putRecipient({ address: l.walletAddress, assets: [...(prev?.assets ?? []), asset], suspended: false });
    }
    disbursementTxs += buildDisbursementTxs(plan, issuer, '1000', asset, passphrase).length;
  }

  // ---------------------------------------------------------------- merchants
  const merchants = parseCsv(read('merchants.csv')).rows;
  const licReg = LicenceRegistry.fromBytes(readFileSync(resolve(dir, 'licence-registry.csv')), read('licence-registry.sig'), SIM.agency().publicKey());
  const onboarding = new Onboarding({
    rules,
    registry: licReg,
    chain,
    store,
    clock,
    networkPassphrase: passphrase,
    registryContractId: SIM.registryId(),
    tzOffsetSeconds: programme.tzOffsetSeconds,
  });
  const idOf = new Map(merchants.map((m) => [m.address, m.merchant_id]));
  const bits = (cats: string) => cats.split(';').reduce((a, c) => a | (rules.file.category_bits[c.trim()] ?? 0), 0);
  const onboardResults: SimResult['onboarding'] = [];

  const evs: Ev[] = [];
  let order = 0;
  const at = (t: number, run: Ev['run']) => evs.push({ at: t, order: order++, run });

  for (const m of merchants) {
    if (m.onboarding === 'legacy') {
      at(programme.start - 2 * DAY, () => {
        const rec = licReg.lookup(m.issuing_authority, m.licence_no);
        if (!rec) throw new Error(`legacy merchant ${m.merchant_id} has no licence`);
        const exp = Date.parse(`${rec.expires}T00:00:00Z`) / 1000 - programme.tzOffsetSeconds + DAY - 1;
        chain.enrol(m.address, licenceHash(m.issuing_authority, m.licence_no), bits(m.categories), exp);
        events.merchants.push({ id: m.merchant_id, address: m.address, onboarding: 'legacy', activatedAt: now, categories: m.categories.split(';') });
      });
    } else {
      const t = programme.start + Number(m.onboard_day) * DAY + 10 * 3600 + 17 * 60 - 4 * 60;
      at(t, async () => {
        const kp = simKeypair(`merchant/${m.merchant_id}`);
        const mask = bits(m.categories);
        const hash = licenceHash(m.issuing_authority, m.licence_no);
        const { registryCall, buildInvokeTx } = await import('../chain.js');
        const tx = buildInvokeTx(new Account(kp.publicKey(), '100'), registryCall.apply(SIM.registryId(), kp.publicKey(), hash, mask), passphrase);
        tx.sign(kp);
        const appliedAt = now;
        // the applicant fills the form in; the service answers in the same request
        now += 4 * 60;
        const res = await onboarding.apply({
          address: kp.publicKey(),
          businessName: m.business_name,
          licenceNumber: m.licence_no,
          issuingAuthority: m.issuing_authority,
          categories: m.categories.split(';'),
          signedApplyTx: tx.toXDR(),
        });
        onboardResults.push({
          merchant: m.merchant_id,
          status: res.status,
          reason: res.status === 'rejected' ? res.reason : undefined,
          minutes: res.status === 'active' ? (now - appliedAt) / 60 : undefined,
        });
        if (res.status === 'active') {
          events.merchants.push({ id: m.merchant_id, address: m.address, onboarding: 'self', appliedAt, activatedAt: now, categories: m.categories.split(';') });
        }
      });
    }
  }
  const m07 = merchants.find((m) => m.merchant_id === 'M07')!;
  at(programme.start + 17 * DAY + 10 * 3600, () => registry.setStatus(m07.address, 'Suspended'));
  at(programme.start + 33 * DAY + 9 * 3600, () => registry.setStatus(m07.address, 'Active'));

  // ---------------------------------------------------------------- disbursement + float
  const disbursed: Record<string, bigint> = { OVFOOD: 0n, OVAGRI: 0n };
  at(programme.start + 1 * DAY + 6 * 3600, () => {
    for (const [asset, plan] of Object.entries(plans)) {
      for (const l of plan.lines) {
        addBal(l.walletAddress, asset, l.amount);
        disbursed[asset] += l.amount;
        events.disbursements.push({ asset, recipient: l.walletAddress, amount: toStellarAmount(l.amount), at: now });
      }
    }
  });
  const poolPlan = JSON.parse(read('pool-plan.json')) as Record<string, { fund_day1: { amount: string }; top_up: { day: number; amount: string } | null }>;
  const pools: Record<string, PoolModel> = { OVFOOD: new PoolModel('OVFOOD', programme.redeemDeadline), OVAGRI: new PoolModel('OVAGRI', programme.redeemDeadline) };
  at(programme.start + 1 * DAY + 6 * 3600 + 1800, () => {
    for (const asset of ['OVFOOD', 'OVAGRI']) {
      const amt = parseAmount(poolPlan[asset].fund_day1.amount);
      pools[asset].fund(amt);
      events.pool.push({ asset, kind: 'fund', amount: toStellarAmount(amt), at: now });
    }
  });

  // ---------------------------------------------------------------- payments
  const attempts: AttemptLine[] = read('spend-weeks-1-4.jsonl')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AttemptLine);
  const seq = new Map<string, bigint>();
  const refusalsByCode: Record<string, number> = {};
  const plantedOutcome: SimResult['plantedOutcome'] = {};
  let approved = 0;
  let refused = 0;
  let falseRefusals = 0;
  let failedSubmissions = 0;
  const spent: Record<string, bigint> = { OVFOOD: 0n, OVAGRI: 0n };
  const receipts: Record<string, bigint> = {};
  const expected = JSON.parse(read('expected.json')) as { refusals_by_code: Record<string, number> };
  const plantCode: Record<string, string> = {
    p2p: 'PEER_TO_PEER',
    unregistered: 'MERCHANT_NOT_REGISTERED',
    m30: 'MERCHANT_NOT_REGISTERED',
    daily_cap: 'DAILY_CAP',
    weekly_cap: 'WEEKLY_CAP',
    category_mismatch: 'CATEGORY_MISMATCH',
    m07_suspended: 'MERCHANT_NOT_ACTIVE',
    after_expiry: 'PROGRAMME_NOT_ACTIVE',
  };
  void expected;

  for (const a of attempts) {
    const t = Math.floor(Date.parse(a.at) / 1000);
    if (t > programme.start + lastSpendDay * DAY + 3 * DAY) continue;
    at(t, async () => {
      const s = (seq.get(a.from) ?? 4_000_000_000n) + 1n;
      seq.set(a.from, s);
      const tx = new TransactionBuilder(new Account(a.from, (s - 1n).toString()), { fee: BASE_FEE, networkPassphrase: passphrase })
        .addOperation(Operation.payment({ destination: a.to, asset: new Asset(a.asset, issuer), amount: a.amount }))
        .setTimeout(300)
        .build();
      const out = await approval.approve(tx.toXDR());
      const po = (plantedOutcome[a.plant] ??= { attempts: 0, refusedAsExpected: 0 });
      po.attempts++;
      const amount = parseAmount(a.amount);
      if (out.response.status === 'revised') {
        approved++;
        if (a.plant !== 'valid') throw new Error(`planted ${a.plant} attempt #${a.i} was approved`);
        // recipient signs and submits; the ledger applies the payment inside the sandwich
        if (bal(a.from, a.asset) < amount) {
          failedSubmissions++;
        } else {
          addBal(a.from, a.asset, -amount);
          addBal(a.to, a.asset, amount);
          spent[a.asset] += amount;
          receipts[a.asset] = (receipts[a.asset] ?? 0n) + amount;
          ledgerSrc.seen.set(out.revisedHash!, now + 5);
          events.payments.push({ asset: a.asset, from: a.from, to: idOf.get(a.to) ?? a.to, amount: a.amount, at: now, status: 'approved' });
        }
        now += 5;
        await watcher.poll();
        now -= 5;
      } else {
        refused++;
        const code = out.response.code ?? 'INVALID';
        refusalsByCode[code] = (refusalsByCode[code] ?? 0) + 1;
        events.payments.push({ asset: a.asset, from: a.from, to: idOf.get(a.to) ?? a.to, amount: a.amount, at: now, status: 'refused', code });
        if (a.plant === 'valid') falseRefusals++;
        else if (plantCode[a.plant] === code) po.refusedAsExpected++;
      }
    });
  }

  // ---------------------------------------------------------------- redemption rounds
  const rounds: SimResult['rounds'] = [];
  const queuedAfterWeek4: Record<string, bigint> = {};
  const merchantAddrs = merchants.map((m) => m.address);
  const roundAt = (day: number) => programme.start + day * DAY + (day === 34 ? 12 : 20) * 3600;
  for (const day of [7, 14, 21, 28, 34]) {
    at(roundAt(day), async () => {
      for (const asset of ['OVFOOD', 'OVAGRI']) {
        const reds: SimResult['rounds'][number]['redemptions'] = [];
        for (const addr of merchantAddrs) {
          const b = bal(addr, asset);
          if (b <= 0n) continue;
          const v = registry.getSync(addr);
          const bit = rules.assets.get(asset)!.categoryBit;
          const active = !!v && v.status === 'Active' && now < v.licenceExpires && (v.categories & bit) !== 0;
          try {
            const o = pools[asset].redeem(addr, b, now, active, b);
            addBal(addr, asset, -b); // burned by SAC clawback
            if (o.kind === 'Paid') {
              events.pool.push({ asset, kind: 'redeem_paid', merchant: idOf.get(addr), amount: toStellarAmount(b), at: now });
              reds.push({ merchant: idOf.get(addr)!, amount: b, outcome: 'Paid' });
            } else {
              events.pool.push({ asset, kind: 'shortfall', merchant: idOf.get(addr), amount: toStellarAmount(b), gap: toStellarAmount(o.gap), at: now });
              events.pool.push({ asset, kind: 'redeem_queued', merchant: idOf.get(addr), amount: toStellarAmount(b), at: now, claimId: o.id });
              reds.push({ merchant: idOf.get(addr)!, amount: b, outcome: `Queued #${o.id}` });
            }
          } catch (e) {
            reds.push({ merchant: idOf.get(addr)!, amount: b, outcome: (e as Error).message });
          }
        }
        rounds.push({ asset, day, redemptions: reds });
        if (day === 28) queuedAfterWeek4[asset] = pools[asset].queued;
      }
    });
  }
  const topUp = poolPlan.OVFOOD.top_up!;
  at(programme.start + topUp.day * DAY + 9 * 3600, () => {
    const amt = parseAmount(topUp.amount);
    pools.OVFOOD.fund(amt);
    events.pool.push({ asset: 'OVFOOD', kind: 'fund', amount: toStellarAmount(amt), at: now });
    for (const asset of ['OVFOOD', 'OVAGRI']) {
      for (const s of pools[asset].settle(1000)) {
        events.pool.push({ asset, kind: 'settle', merchant: idOf.get(s.merchant), amount: toStellarAmount(s.amount), at: now, claimId: s.id });
      }
    }
  });

  // ---------------------------------------------------------------- expiry clawback
  const unspentDay28: Record<string, bigint> = { OVFOOD: 0n, OVAGRI: 0n };
  const clawedAtExpiry: Record<string, bigint> = { OVFOOD: 0n, OVAGRI: 0n };
  let clawbackTxs = 0;
  const holdingsDay28: SimResult['holdingsDay28'] = { recipients: [], holdings: [] };
  at(programme.expiry + 60, () => {
    const holdings: Holding[] = [];
    holdingsDay28.recipients = store.recipients().map((r) => r.address);
    for (const [k, v] of balances) {
      const [address, asset] = k.split('|');
      if (v > 0n) holdingsDay28.holdings.push({ address, asset, balance: toStellarAmount(v) });
    }
    for (const [k, v] of balances) {
      const [address, asset] = k.split('|');
      holdings.push({ address, asset, balance: v });
      if (store.getRecipient(address)) unspentDay28[asset] += v;
    }
    const plan = planExpiry(holdings, (a) => store.getRecipient(a) !== undefined);
    clawbackTxs = buildClawbackTxs(plan, issuer, '2000', passphrase).length;
    for (const batch of plan.batches) {
      for (const h of batch) {
        addBal(h.address, h.asset, -h.balance);
        clawedAtExpiry[h.asset] += h.balance;
        events.clawbacks.push({ asset: h.asset, from: h.address, amount: toStellarAmount(h.balance), at: now });
      }
    }
  });

  // ---------------------------------------------------------------- after the deadline
  const surplusWithdrawn: Record<string, bigint> = { OVFOOD: 0n, OVAGRI: 0n };
  let lateRedeemRefused = false;
  at(programme.redeemDeadline + 3600, () => {
    try {
      pools.OVFOOD.redeem(merchantAddrs[0], 1n, now, true, 1n);
    } catch (e) {
      lateRedeemRefused = (e as Error).message === 'RedemptionClosed';
    }
    for (const asset of ['OVFOOD', 'OVAGRI']) {
      const amt = pools[asset].float;
      if (amt > 0n) {
        pools[asset].withdraw(amt, now);
        surplusWithdrawn[asset] = amt;
        events.pool.push({ asset, kind: 'withdraw', amount: toStellarAmount(amt), at: now });
      }
    }
  });

  // ---------------------------------------------------------------- run
  evs.sort((x, y) => x.at - y.at || x.order - y.order);
  for (const e of evs) {
    now = e.at;
    await e.run();
  }

  const redeemedPaid: Record<string, bigint> = { OVFOOD: pools.OVFOOD.paid, OVAGRI: pools.OVAGRI.paid };
  const merchantReceipts: Record<string, bigint> = { OVFOOD: receipts.OVFOOD ?? 0n, OVAGRI: receipts.OVAGRI ?? 0n };
  const invariants = pools.OVFOOD.invariantsHold() && pools.OVAGRI.invariantsHold() && lateRedeemRefused;

  return {
    programme: programme.id,
    attempts: approved + refused,
    approved,
    refused,
    refusalsByCode: Object.fromEntries(Object.entries(refusalsByCode).sort()),
    plantedOutcome,
    falseRefusals,
    failedSubmissions,
    disbursed,
    spent,
    unspentDay28,
    clawedAtExpiry,
    clawbackTxs,
    merchantReceipts,
    redeemedPaid,
    queuedAfterWeek4,
    queuedFinal: { OVFOOD: pools.OVFOOD.queued, OVAGRI: pools.OVAGRI.queued },
    surplusWithdrawn,
    rounds,
    onboarding: onboardResults,
    skippedDuplicates: plans.OVFOOD.skipped.length + plans.OVAGRI.skipped.length,
    disbursementTxs,
    invariants,
    events,
    holdingsDay28,
  };
}
