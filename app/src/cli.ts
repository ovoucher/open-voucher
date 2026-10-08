#!/usr/bin/env node
// `voucher`: CLI for Open Voucher. Offline commands (simulate, dedup, report, issue
// --offline, disburse/expire --dry-run, and --dry-run on contract calls) need no
// network. The rest talk to Stellar RPC / Horizon using the variables in .env.example;
// those paths were written against @stellar/stellar-sdk 17 but not run from the build
// environment (testnet was unreachable).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { formatAmount, formatUsd, parsePositiveAmount, toStellarAmount } from './amount.js';
import { parseArgs, parseAssetCode, parseCategories, parseDate, parseGAddress, parsePositiveInt, UsageError, COMMANDS } from './args.js';
import {
  buildInvokeTx,
  describeOutcome,
  loadAccount,
  poolCall,
  registryCall,
  RpcRegistryReader,
  sendPrepared,
  simulateView,
  submitClassic,
  submitInvocation,
  type ChainConfig,
  type Invocation,
} from './chain.js';
import { loadProgramme, loadRules, PROJECT_ROOT, seedPath } from './config.js';
import { parseCsv, toCsv } from './csv.js';
import { heuristicDedup, pseudonymise, type DedupRow } from './ai/dedup.js';
import { LlmProvider } from './ai/llm.js';
import { dedupLlmAllowed, HeuristicProvider, type AiProvider } from './ai/provider.js';
import { SIM } from './keys.js';
import { licenceExpiryUnix, Onboarding, type OnboardingChain } from './onboarding/apply.js';
import { licenceHash } from './onboarding/licence.js';
import { LicenceRegistry } from './onboarding/licence-registry.js';
import { buildDisbursementTxs, parseDecisions, planDisbursement } from './ops/disburse.js';
import { buildClawbackTxs, planExpiry, type Holding } from './ops/expire.js';
import { buildIssuerSetupTx, canAuthorise, issuerSetupOps, policyFrom, sacCommands, stellarToml } from './issuer/ops.js';
import { computeFigures, type EventLog } from './report/figures.js';
import { approveReport, draftReport } from './report/report.js';
import { ApprovalService } from './sep8/approve.js';
import { HorizonLedgerSource, LedgerWatcher } from './sep8/ledger-watch.js';
import { parseTx } from './sep8/tx.js';
import { CachedRegistryReader, MemoryRegistry, systemClock } from './sep8/registry-reader.js';
import { createApprovalServer } from './sep8/server.js';
import { JsonFileStore } from './store.js';
import { simulate } from './sim/simulate.js';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
}

const HELP = `voucher: Open Voucher CLI (restricted-use voucher assets on Stellar)

Offline:
  voucher simulate --weeks 4 [--out out/] [--json]
  voucher dedup --csv data/seed/beneficiaries.csv --out out/dedup-candidates.csv [--provider heuristic|llm]
  voucher report --programme KE-PILOT-SIM --from 2026-09-01 --to 2026-10-14 [--events out/sim-events.json] [--out out/report.md] [--provider heuristic|llm] [--approve "<staff name>"]
  voucher issue --programme KE-PILOT-SIM --config data/seed/programme.json --offline
  voucher disburse --sdp-csv data/seed/sdp-disbursement.csv --asset OVFOOD --decisions data/seed/dedup-decisions.csv --dry-run
  voucher expire --programme KE-PILOT-SIM --holdings out/holdings-day28.json --dry-run

Network (testnet; configure .env first):
  voucher enrol --merchant <G…> --licence <no> --authority <code> --categories food,agri [--legacy | --approve | --suspend <reason> | --reinstate | --revoke <reason>] [--dry-run]
  voucher pay --from <alias> --merchant <G…> --asset OVFOOD --amount 4.50
  voucher fund --asset OVFOOD --amount 3000 [--dry-run]
  voucher redeem --merchant <alias> --asset OVFOOD --amount 212.40 [--dry-run]
  voucher settle --asset OVFOOD [--max 50] [--dry-run]
  voucher serve [--port 8080] [--demo]
`;

function chainConfig(env: Io['env']): ChainConfig {
  return {
    rpcUrl: env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
    horizonUrl: env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET,
  };
}

function need(env: Io['env'], name: string): string {
  const v = env[name];
  if (!v) throw new UsageError(`${name} is not set (see .env.example)`);
  return v;
}

function keyFor(env: Io['env'], alias: string): Keypair {
  const name = `VOUCHER_SECRET_${alias.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return Keypair.fromSecret(need(env, name));
}

function poolId(env: Io['env'], asset: string): string {
  return need(env, `POOL_${asset}_ID`);
}

function rel(p: string): string {
  return resolve(process.cwd(), p);
}

/** PROGRAMME_CONFIG overrides data/seed/programme.json (e.g. a short testnet programme). */
function programmeFromEnv(env: Io['env']) {
  return loadProgramme(env.PROGRAMME_CONFIG ? rel(env.PROGRAMME_CONFIG) : undefined);
}

function readDedupRows(path: string): DedupRow[] {
  return parseCsv(readFileSync(path, 'utf8')).rows.map((r) => ({
    rowId: r.row_id,
    fullName: r.full_name,
    dob: r.dob,
    phone: r.phone,
    nationalId: r.national_id,
    householdSize: Number(r.household_size || 0),
    location: r.location,
  }));
}

function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? toStellarAmount(v) : v;
}

async function printOrSubmit(io: Io, dry: boolean, env: Io['env'], signerVar: string, inv: Invocation): Promise<void> {
  const cfg = chainConfig(env);
  if (dry) {
    const src = env[signerVar] ? Keypair.fromSecret(env[signerVar]!).publicKey() : SIM.opsKey().publicKey();
    const tx = buildInvokeTx(new Account(src, '0'), inv, cfg.networkPassphrase);
    io.out(`dry run: ${inv.method} on ${inv.contractId}`);
    io.out(`unsigned, unprepared XDR (simulate + sign before submitting):\n${tx.toXDR()}`);
    return;
  }
  const res = await submitInvocation(cfg, Keypair.fromSecret(need(env, signerVar)), inv);
  io.out(`submitted ${inv.method}: ${res.hash}`);
  if (res.returnValue !== undefined) io.out(`result: ${inv.method === 'redeem' ? describeOutcome(res.returnValue) : JSON.stringify(res.returnValue, jsonReplacer)}`);
}

export async function run(argv: string[], io: Io): Promise<number> {
  let p;
  try {
    p = parseArgs(argv);
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 2;
  }
  const { flags, switches, env } = { ...p, env: io.env };
  const dry = switches.has('dry-run');
  try {
    switch (p.command) {
      case 'help':
        io.out(HELP);
        return 0;

      case 'simulate': {
        const weeks = flags.weeks ? parsePositiveInt(flags.weeks, 'weeks') : 4;
        if (weeks > 4) throw new UsageError('--weeks: the seed covers 4 weeks');
        const r = await simulate({ weeks, seedDir: flags['seed-dir'] ? rel(flags['seed-dir']) : undefined });
        if (flags.out) {
          const dir = rel(flags.out);
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, 'sim-events.json'), JSON.stringify(r.events, jsonReplacer, 2));
          writeFileSync(resolve(dir, 'holdings-day28.json'), JSON.stringify(r.holdingsDay28, null, 2));
          const { events: _e, holdingsDay28: _h, ...summary } = r;
          writeFileSync(resolve(dir, 'sim-summary.json'), JSON.stringify(summary, jsonReplacer, 2));
        }
        if (switches.has('json')) {
          const { events: _e, holdingsDay28: _h, ...summary } = r;
          io.out(JSON.stringify(summary, jsonReplacer, 2));
          return 0;
        }
        io.out(`Open Voucher simulation: ${r.programme} (SIMULATED data, ${weeks} weeks, no network)`);
        io.out(`beneficiary duplicates skipped at disbursement: ${r.skippedDuplicates}; disbursement sandwiches built: ${r.disbursementTxs}`);
        io.out(`disbursed:  OVFOOD ${formatUsd(r.disbursed.OVFOOD)}  OVAGRI ${formatUsd(r.disbursed.OVAGRI)}`);
        io.out(`payment attempts ${r.attempts}: approved ${r.approved}, refused ${r.refused}, false refusals ${r.falseRefusals}`);
        for (const [c, n] of Object.entries(r.refusalsByCode)) io.out(`  ${c.padEnd(24)} ${n}`);
        io.out(`spent:      OVFOOD ${formatUsd(r.spent.OVFOOD)}  OVAGRI ${formatUsd(r.spent.OVAGRI)}`);
        io.out(`clawed back at expiry (recipients only): OVFOOD ${formatUsd(r.clawedAtExpiry.OVFOOD)}  OVAGRI ${formatUsd(r.clawedAtExpiry.OVAGRI)} in ${r.clawbackTxs} tx`);
        io.out(`onboarding: ${r.onboarding.map((o) => `${o.merchant} ${o.status}${o.reason ? ` (${o.reason})` : ''}${o.minutes !== undefined ? ` ${o.minutes} min` : ''}`).join('; ')}`);
        for (const rd of r.rounds.filter((x) => x.redemptions.length > 0)) {
          const paid = rd.redemptions.filter((x) => x.outcome === 'Paid').reduce((a, x) => a + x.amount, 0n);
          const other = rd.redemptions.filter((x) => x.outcome !== 'Paid').map((x) => `${x.merchant} ${x.outcome}`);
          io.out(`redeem day ${String(rd.day).padStart(2)} ${rd.asset}: paid ${formatUsd(paid)}${other.length ? `; ${other.join(', ')}` : ''}`);
        }
        io.out(`queued after week 4: OVFOOD ${formatUsd(r.queuedAfterWeek4.OVFOOD)}; after top-up and settle: ${formatUsd(r.queuedFinal.OVFOOD)}`);
        io.out(`paid to merchants: OVFOOD ${formatUsd(r.redeemedPaid.OVFOOD)}  OVAGRI ${formatUsd(r.redeemedPaid.OVAGRI)} (receipts ${formatUsd(r.merchantReceipts.OVFOOD)} / ${formatUsd(r.merchantReceipts.OVAGRI)})`);
        io.out(`surplus withdrawn after deadline: OVFOOD ${formatUsd(r.surplusWithdrawn.OVFOOD)}  OVAGRI ${formatUsd(r.surplusWithdrawn.OVAGRI)}`);
        io.out(`pool invariants: ${r.invariants ? 'hold' : 'VIOLATED'}`);
        return r.invariants && r.falseRefusals === 0 ? 0 : 1;
      }

      case 'dedup': {
        const rows = readDedupRows(rel(flags.csv));
        let pairs = heuristicDedup(rows);
        const programme = loadProgramme(flags['programme-config'] ? rel(flags['programme-config']) : undefined);
        const wantLlm = (flags.provider ?? 'heuristic') === 'llm';
        if (flags.provider && !['heuristic', 'llm'].includes(flags.provider)) throw new UsageError('--provider must be heuristic or llm');
        let providerName = 'heuristic';
        if (wantLlm) {
          if (!dedupLlmAllowed(env, programme.file.llm_dedup_allowed)) {
            io.err('LLM dedup is disabled: it needs LLM_API_KEY and llm_dedup_allowed: true in programme.json (a data-protection sign-off). Using the heuristic only.');
          } else {
            const provider = new LlmProvider({ apiKey: env.LLM_API_KEY, model: env.LLM_MODEL });
            pairs = await provider.rejudgeReview(pairs, new Map(rows.map((r) => [r.rowId.trim(), pseudonymise(r)])));
            providerName = `llm (${provider.model})`;
          }
        }
        const out = flags.out ? rel(flags.out) : rel('out/dedup-candidates.csv');
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(
          out,
          toCsv(
            ['row_a', 'row_b', 'score', 'band', 'reasons', 'decision'],
            pairs.map((x) => ({ row_a: x.a, row_b: x.b, score: x.score.toFixed(3), band: x.band, reasons: x.reasons.join('; '), decision: '' })),
          ),
        );
        const ls = pairs.filter((x) => x.band === 'likely_same').length;
        io.out(`${rows.length} rows, ${pairs.length} candidate pairs (${ls} likely_same, ${pairs.length - ls} review) via ${providerName}`);
        io.out(`wrote ${out}; staff fill the decision column with same | distinct | unsure`);
        return 0;
      }

      case 'disburse': {
        const programme = programmeFromEnv(env);
        const rules = loadRules();
        const asset = parseAssetCode(flags.asset, rules.assets.keys());
        const cat = rules.assets.get(asset)!.category;
        const benPath = flags.beneficiaries ? rel(flags.beneficiaries) : seedPath('beneficiaries.csv');
        const rows = readDedupRows(benPath);
        const catOf = new Map(parseCsv(readFileSync(benPath, 'utf8')).rows.map((r) => [r.row_id, r.category]));
        const decisions = parseDecisions(parseCsv(readFileSync(rel(flags.decisions), 'utf8')).rows);
        const plan = planDisbursement(parseCsv(readFileSync(rel(flags['sdp-csv']), 'utf8')).rows, heuristicDedup(rows), decisions, (id) => catOf.get(id) === cat);
        io.out(`${asset}: ${plan.lines.length} recipients, total ${formatAmount(plan.total)}; skipped ${plan.skipped.length} duplicate row(s): ${plan.skipped.map((s) => `${s.id}=${s.duplicateOf}`).join(', ')}`);
        const cfg = chainConfig(env);
        const issuer = env.ISSUER_PUBLIC ?? SIM.issuer().publicKey();
        if (dry) {
          const txs = buildDisbursementTxs(plan, issuer, '0', asset, cfg.networkPassphrase);
          io.out(`dry run: built ${txs.length} authorise → payment → maintain-liabilities transactions from ${issuer}; first:\n${txs[0]?.toXDR() ?? '(none)'}`);
          void programme;
          return 0;
        }
        const ops = Keypair.fromSecret(need(env, 'OPS_SECRET'));
        const acct = await loadAccount(cfg, issuer);
        const txs = buildDisbursementTxs(plan, issuer, acct.sequenceNumber(), asset, cfg.networkPassphrase);
        // Each disbursed recipient is enrolled for this asset in the approval-server store
        // (start or restart `voucher serve` after disbursing so it loads them).
        const store = new JsonFileStore(rel(env.STORE_PATH ?? 'out/approval-store.json'));
        for (const [i, tx] of txs.entries()) {
          tx.sign(ops);
          io.out(`submitted ${await submitClassic(cfg, tx)}`);
          const line = plan.lines[i];
          const prev = store.getRecipient(line.walletAddress);
          store.putRecipient({ address: line.walletAddress, assets: [...new Set([...(prev?.assets ?? []), asset])], suspended: prev?.suspended ?? false });
        }
        return 0;
      }

      case 'issue': {
        const programme = loadProgramme(flags.config ? rel(flags.config) : undefined);
        if (flags.programme && flags.programme !== programme.id) throw new UsageError(`--programme ${flags.programme} does not match ${programme.id} in the config`);
        const rules = loadRules(flags.rules ? rel(flags.rules) : undefined);
        const policy = policyFrom(programme);
        const offline = switches.has('offline');
        const issuer = offline ? (env.ISSUER_PUBLIC ?? SIM.issuer().publicKey()) : Keypair.fromSecret(need(env, 'ISSUER_SECRET')).publicKey();
        const setup = {
          issuer,
          opsKey: env.OPS_PUBLIC ?? (env.OPS_SECRET ? Keypair.fromSecret(env.OPS_SECRET).publicKey() : SIM.opsKey().publicKey()),
          approvalSigner: env.APPROVAL_SIGNER_PUBLIC ?? (env.APPROVAL_SIGNER_SECRET ? Keypair.fromSecret(env.APPROVAL_SIGNER_SECRET).publicKey() : SIM.approvalSigner().publicKey()),
          homeDomain: programme.file.home_domain,
          policy,
        };
        io.out(`issuer ${issuer} for ${programme.id}`);
        io.out(`SetOptions: flags AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED, home_domain ${setup.homeDomain}`);
        io.out(`SetOptions: signer ops key ${setup.opsKey} weight ${policy.opsKeyWeight}; approval signer ${setup.approvalSigner} weight ${policy.approvalSignerWeight}`);
        io.out(`SetOptions: master weight ${policy.masterWeight}, thresholds low ${policy.thresholds.low} / med ${policy.thresholds.med} / high ${policy.thresholds.high}`);
        for (const op of ['setTrustLineFlags', 'payment', 'clawback', 'setOptions']) {
          io.out(`  ${op.padEnd(18)} approval signer: ${canAuthorise(policy, policy.approvalSignerWeight, op) ? 'yes' : 'no'}  ops key: ${canAuthorise(policy, policy.opsKeyWeight, op) ? 'yes' : 'no'}  master: ${canAuthorise(policy, policy.masterWeight, op) ? 'yes' : 'no'}`);
        }
        io.out(`assets: ${[...rules.assets.keys()].map((c) => `${c}:${issuer}`).join(', ')}`);
        io.out('SAC deployment (run after the issuer setup):');
        for (const c of sacCommands(rules, issuer)) io.out(`  ${c}`);
        io.out('\nstellar.toml:\n' + stellarToml(programme, rules, issuer));
        const cfg = chainConfig(env);
        if (offline) {
          const tx = buildIssuerSetupTx(new Account(issuer, '0'), setup, cfg.networkPassphrase);
          io.out(`offline: ${issuerSetupOps(setup).length} operations, unsigned XDR (sequence placeholder):\n${tx.toXDR()}`);
          return 0;
        }
        const kp = Keypair.fromSecret(need(env, 'ISSUER_SECRET'));
        const tx = buildIssuerSetupTx(await loadAccount(cfg, issuer), setup, cfg.networkPassphrase);
        tx.sign(kp);
        io.out(`submitted issuer setup: ${await submitClassic(cfg, tx)}`);
        return 0;
      }

      case 'enrol': {
        const rules = loadRules();
        const registry = env.REGISTRY_CONTRACT_ID ?? (dry ? SIM.registryId() : need(env, 'REGISTRY_CONTRACT_ID'));
        const merchant = parseGAddress(flags.merchant, 'merchant');
        if (flags.suspend) return await printOrSubmit(io, dry, env, 'ADMIN_SECRET', registryCall.suspend(registry, merchant, parsePositiveInt(flags.suspend, 'suspend'))).then(() => 0);
        if (flags.revoke) return await printOrSubmit(io, dry, env, 'ADMIN_SECRET', registryCall.revoke(registry, merchant, parsePositiveInt(flags.revoke, 'revoke'))).then(() => 0);
        if (switches.has('reinstate')) return await printOrSubmit(io, dry, env, 'ADMIN_SECRET', registryCall.reinstate(registry, merchant)).then(() => 0);
        if (!flags.licence || !flags.authority || !flags.categories) throw new UsageError('enrol: --licence, --authority and --categories are required');
        const cats = parseCategories(flags.categories);
        const mask = cats.reduce((a, c) => a | rules.file.category_bits[c], 0);
        const hash = licenceHash(flags.authority, flags.licence);
        const programme = programmeFromEnv(env);
        const expires = flags.expires ? licenceExpiryUnix(parseDate(flags.expires, 'expires'), programme.tzOffsetSeconds) : programme.redeemDeadline + 365 * 86_400;
        if (switches.has('legacy')) return await printOrSubmit(io, dry, env, 'ADMIN_SECRET', registryCall.enrol(registry, merchant, hash, mask, expires)).then(() => 0);
        if (switches.has('approve')) {
          const verifier = env.VERIFIER_SECRET ? Keypair.fromSecret(env.VERIFIER_SECRET).publicKey() : SIM.verifier().publicKey();
          return await printOrSubmit(io, dry, env, 'VERIFIER_SECRET', registryCall.approve(registry, verifier, merchant, expires)).then(() => 0);
        }
        // self-onboarding through the approval server
        const kp = keyFor(env, 'merchant');
        if (kp.publicKey() !== merchant) throw new UsageError('VOUCHER_SECRET_MERCHANT does not match --merchant');
        const cfg = chainConfig(env);
        const { rpcServer } = await import('./chain.js');
        const srv = rpcServer(cfg);
        const prepared = await srv.prepareTransaction(buildInvokeTx(await srv.getAccount(merchant), registryCall.apply(registry, merchant, hash, mask), cfg.networkPassphrase));
        prepared.sign(kp);
        const res = await fetch(`${need(env, 'APPROVAL_SERVER_URL').replace(/\/$/, '')}/merchants/apply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: merchant, businessName: flags['business-name'] ?? '', licenceNumber: flags.licence, issuingAuthority: flags.authority, categories: cats, signedApplyTx: prepared.toXDR() }),
        });
        io.out(JSON.stringify(await res.json()));
        return res.ok ? 0 : 1;
      }

      case 'pay': {
        const rules = loadRules();
        const asset = parseAssetCode(flags.asset, rules.assets.keys());
        const amount = parsePositiveAmount(flags.amount);
        const merchant = parseGAddress(flags.merchant, 'merchant');
        const cfg = chainConfig(env);
        const issuer = need(env, 'ISSUER_PUBLIC');
        const kp = keyFor(env, flags.from);
        const account = dry ? new Account(kp.publicKey(), '0') : await loadAccount(cfg, kp.publicKey());
        const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
          .addOperation(Operation.payment({ destination: merchant, asset: new Asset(asset, issuer), amount: toStellarAmount(amount) }))
          .setTimeout(300)
          .build();
        if (dry) {
          io.out(`dry run: payment XDR to send to /tx-approve:\n${tx.toXDR()}`);
          return 0;
        }
        const res = await fetch(`${need(env, 'APPROVAL_SERVER_URL').replace(/\/$/, '')}/tx-approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tx: tx.toXDR() }),
        });
        const body = (await res.json()) as { status: string; tx?: string; error?: string; message?: string };
        if (body.status !== 'revised' || !body.tx) {
          io.err(`refused: ${body.error ?? JSON.stringify(body)}`);
          return 1;
        }
        const revised = parseTx(body.tx, cfg.networkPassphrase);
        revised.sign(kp);
        io.out(`approved: ${body.message}`);
        io.out(`submitted ${await submitClassic(cfg, revised)}`);
        return 0;
      }

      case 'fund': {
        const rules = loadRules();
        const asset = parseAssetCode(flags.asset, rules.assets.keys());
        const amount = parsePositiveAmount(flags.amount);
        const from = env.OPS_SECRET ? Keypair.fromSecret(env.OPS_SECRET).publicKey() : SIM.opsKey().publicKey();
        await printOrSubmit(io, dry, env, 'OPS_SECRET', poolCall.fund(dry && !env[`POOL_${asset}_ID`] ? SIM.foodPoolId() : poolId(env, asset), from, amount));
        return 0;
      }

      case 'redeem': {
        const rules = loadRules();
        const asset = parseAssetCode(flags.asset, rules.assets.keys());
        const amount = parsePositiveAmount(flags.amount);
        const pool = dry && !env[`POOL_${asset}_ID`] ? (asset === 'OVFOOD' ? SIM.foodPoolId() : SIM.agriPoolId()) : poolId(env, asset);
        if (dry) {
          const who = /^G[A-Z2-7]{55}$/.test(flags.merchant) ? flags.merchant : SIM.opsKey().publicKey();
          await printOrSubmit(io, true, env, 'NONE', poolCall.redeem(pool, who, amount));
          return 0;
        }
        const kp = keyFor(env, flags.merchant);
        const res = await submitInvocation(chainConfig(env), kp, poolCall.redeem(pool, kp.publicKey(), amount));
        io.out(`${describeOutcome(res.returnValue)} (tx ${res.hash})`);
        return 0;
      }

      case 'settle': {
        const rules = loadRules();
        const asset = parseAssetCode(flags.asset, rules.assets.keys());
        const max = flags.max ? parsePositiveInt(flags.max, 'max') : 50;
        const pool = dry && !env[`POOL_${asset}_ID`] ? SIM.foodPoolId() : poolId(env, asset);
        await printOrSubmit(io, dry, env, 'OPS_SECRET', poolCall.settleQueue(pool, max));
        if (!dry) io.out(`coverage: ${JSON.stringify(await simulateView(chainConfig(env), poolCall.coverage(pool)), jsonReplacer)}`);
        return 0;
      }

      case 'expire': {
        const programme = programmeFromEnv(env);
        if (flags.programme !== programme.id) throw new UsageError(`unknown programme ${flags.programme}`);
        const now = Math.floor(Date.now() / 1000);
        if (!dry && now <= programme.expiry) throw new UsageError(`programme ${programme.id} has not expired yet (expiry ${programme.file.expiry})`);
        if (!flags.holdings) throw new UsageError('expire: --holdings <json> is required (Horizon holder lookup is documented in ARCHITECTURE.md, not built)');
        const raw = JSON.parse(readFileSync(rel(flags.holdings), 'utf8')) as { recipients: string[]; holdings: Array<{ address: string; asset: string; balance: string }> };
        const recipients = new Set(raw.recipients);
        const holdings: Holding[] = raw.holdings.map((h) => ({ address: h.address, asset: h.asset, balance: parsePositiveOrZero(h.balance) }));
        const plan = planExpiry(holdings, (a) => recipients.has(a));
        const cfg = chainConfig(env);
        const issuer = env.ISSUER_PUBLIC ?? SIM.issuer().publicKey();
        for (const [asset, total] of Object.entries(plan.totals)) io.out(`clawback ${asset}: ${formatAmount(total)}`);
        io.out(`${plan.batches.length} transaction(s) of at most 100 Clawback ops; ${plan.skippedMerchants} merchant balance(s) left for redemption`);
        const txs = buildClawbackTxs(plan, issuer, '0', cfg.networkPassphrase);
        if (dry) return 0;
        const ops = Keypair.fromSecret(need(env, 'OPS_SECRET'));
        const acct = await loadAccount(cfg, issuer);
        for (const tx of buildClawbackTxs(plan, issuer, acct.sequenceNumber(), cfg.networkPassphrase)) {
          tx.sign(ops);
          io.out(`submitted ${await submitClassic(cfg, tx)}`);
        }
        void txs;
        return 0;
      }

      case 'report': {
        const from = parseDate(flags.from, 'from');
        const to = parseDate(flags.to, 'to');
        const eventsPath = flags.events ? rel(flags.events) : rel('out/sim-events.json');
        if (!existsSync(eventsPath)) throw new UsageError(`no events file at ${eventsPath} (run: voucher simulate --out out)`);
        const log = JSON.parse(readFileSync(eventsPath, 'utf8')) as EventLog;
        if (log.programme !== flags.programme) throw new UsageError(`events are for ${log.programme}, not ${flags.programme}`);
        const figures = computeFigures(log, `${from}T00:00:00+03:00`, to);
        const outPath = flags.out ? rel(flags.out) : rel('out/report.md');
        mkdirSync(dirname(outPath), { recursive: true });
        if (flags.approve) {
          if (!existsSync(outPath)) throw new UsageError(`no draft at ${outPath}; run report without --approve first`);
          const stamped = approveReport(readFileSync(outPath, 'utf8'), figures, flags.approve, new Date().toISOString().slice(0, 10));
          writeFileSync(outPath, stamped);
          io.out(`approved ${outPath} by ${flags.approve}`);
          return 0;
        }
        let provider: AiProvider = new HeuristicProvider();
        if (flags.provider === 'llm') {
          if (!env.LLM_API_KEY) io.err('LLM_API_KEY not set; using the deterministic template');
          else provider = new LlmProvider({ apiKey: env.LLM_API_KEY, model: env.LLM_MODEL });
        } else if (flags.provider && flags.provider !== 'heuristic') throw new UsageError('--provider must be heuristic or llm');
        const d = await draftReport(figures, provider);
        writeFileSync(outPath, d.markdown);
        writeFileSync(outPath.replace(/\.md$/, '') + '.figures.json', JSON.stringify(figures, null, 2));
        io.out(`wrote DRAFT ${outPath} (${d.source === 'provider' ? d.provider : 'template'}${d.rejectedNumbers.length ? `; LLM draft discarded, unlisted numbers: ${d.rejectedNumbers.join(', ')}` : ''}); figures sha256 ${d.figuresSha256}`);
        return 0;
      }

      case 'serve': {
        const programme = loadProgramme(env.PROGRAMME_CONFIG ? rel(env.PROGRAMME_CONFIG) : undefined);
        const rulesPath = env.RULES_PATH ? rel(env.RULES_PATH) : seedPath('rules.json');
        const rulesText = readFileSync(rulesPath, 'utf8');
        const rules = loadRules(rulesPath);
        const cfg = chainConfig(env);
        const demo = switches.has('demo');
        const agencyPub = demo ? (env.AGENCY_PUBKEY ?? SIM.agency().publicKey()) : need(env, 'AGENCY_PUBKEY');
        // refuses to start unless the licence registry signature verifies
        const licReg = LicenceRegistry.load(
          env.LICENCE_REGISTRY_CSV ? rel(env.LICENCE_REGISTRY_CSV) : seedPath('licence-registry.csv'),
          env.LICENCE_REGISTRY_SIG ? rel(env.LICENCE_REGISTRY_SIG) : seedPath('licence-registry.sig'),
          agencyPub,
        );
        const store = new JsonFileStore(rel(env.STORE_PATH ?? 'out/approval-store.json'));
        let reader;
        let chain: OnboardingChain;
        if (demo) {
          const mem = new MemoryRegistry();
          const { MemoryOnboardingChain } = await import('./onboarding/memory-chain.js');
          const mc = new MemoryOnboardingChain(mem, systemClock);
          for (const m of parseCsv(readFileSync(seedPath('merchants.csv'), 'utf8')).rows) {
            if (m.onboarding !== 'legacy') continue;
            const rec = licReg.lookup(m.issuing_authority, m.licence_no);
            if (rec) mc.enrol(m.address, licenceHash(m.issuing_authority, m.licence_no), m.categories.split(';').reduce((a, c) => a | rules.file.category_bits[c], 0), licenceExpiryUnix(rec.expires, programme.tzOffsetSeconds));
          }
          for (const r of parseCsv(readFileSync(seedPath('beneficiaries.csv'), 'utf8')).rows) {
            if (!store.getRecipient(r.wallet_address)) store.putRecipient({ address: r.wallet_address, assets: [r.category === 'food' ? 'OVFOOD' : 'OVAGRI'], suspended: false });
          }
          reader = mem;
          chain = mc;
        } else {
          const registryId = need(env, 'REGISTRY_CONTRACT_ID');
          reader = new RpcRegistryReader(cfg, registryId);
          const verifier = Keypair.fromSecret(need(env, 'VERIFIER_SECRET'));
          chain = {
            licenceOwner: async (h) => ((await simulateView(cfg, registryCall.licenceOwner(registryId, h))) as string | undefined) ?? undefined,
            submitApply: async (tx) => void (await sendPrepared(cfg, tx)),
            approve: async (m, exp) => void (await submitInvocation(cfg, verifier, registryCall.approve(registryId, verifier.publicKey(), m, exp))),
          };
        }
        const approval = new ApprovalService({
          programme,
          rules,
          issuer: demo ? (env.ISSUER_PUBLIC ?? SIM.issuer().publicKey()) : need(env, 'ISSUER_PUBLIC'),
          approvalSigner: demo && !env.APPROVAL_SIGNER_SECRET ? SIM.approvalSigner() : Keypair.fromSecret(need(env, 'APPROVAL_SIGNER_SECRET')),
          networkPassphrase: cfg.networkPassphrase,
          store,
          registry: new CachedRegistryReader(reader, rules.file.registry_cache_seconds),
          clock: systemClock,
        });
        const onboarding = new Onboarding({
          rules,
          registry: licReg,
          chain,
          store,
          clock: systemClock,
          networkPassphrase: cfg.networkPassphrase,
          registryContractId: demo ? SIM.registryId() : need(env, 'REGISTRY_CONTRACT_ID'),
          tzOffsetSeconds: programme.tzOffsetSeconds,
        });
        const port = flags.port ? parsePositiveInt(flags.port, 'port') : Number(env.PORT ?? 8080);
        const server = createApprovalServer({ approval, onboarding, rules, rulesText, programmeId: programme.id });
        await new Promise<void>((ok) => server.listen(port, ok));
        if (!demo) {
          // Turns reservations into spends once their revised tx is on the ledger, and
          // releases the ones whose timebound passed without it (docs/SEP8-RULES.md).
          const watcher = new LedgerWatcher(store, new HorizonLedgerSource(cfg.horizonUrl), systemClock);
          const every = Number(env.WATCH_INTERVAL_SECONDS ?? 5) * 1000;
          setInterval(() => void watcher.poll().catch((e: unknown) => io.err(`ledger watcher: ${(e as Error).message}`)), every);
        }
        io.out(`approval server for ${programme.id} on :${port} (rules ${rules.hash.slice(0, 12)}${demo ? ', DEMO mode: in-memory registry, simulation keys' : ''})`);
        return await new Promise<number>(() => undefined);
      }
    }
    io.err(`error: unhandled command ${p.command}`);
    return 2;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}`);
      return 2;
    }
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}

function parsePositiveOrZero(s: string): bigint {
  const v = s.trim() === '0' ? 0n : parsePositiveAmount(s);
  return v;
}

export { COMMANDS, PROJECT_ROOT };

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s), env: process.env }).then((code) => {
    process.exitCode = code;
  });
}
