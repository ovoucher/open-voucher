// Classic issuer and asset setup for one Open Voucher programme (testnet).
//
// NOT EXECUTED in the environment this project was built in: the sandbox could not reach
// horizon-testnet.stellar.org or friendbot. The operation builders it calls
// (app/src/issuer/ops.ts) are unit-tested offline in app/test/ops.test.ts.
//
// Runs with Node 22 type stripping, after `cd app && npm install && npm run build`:
//
//   node scripts/issuer-setup.ts setup                      # flags, home domain, signers, thresholds
//   node scripts/issuer-setup.ts trust OVFOOD alice bob     # ChangeTrust from VOUCHER_SECRET_ALICE, _BOB
//   node scripts/issuer-setup.ts flags <G...> OVFOOD        # print a trustline's flags and balance
//
// Environment (see .env.example): ISSUER_SECRET, OPS_PUBLIC, APPROVAL_SIGNER_PUBLIC,
// HORIZON_URL, STELLAR_NETWORK_PASSPHRASE, optional PROGRAMME_CONFIG, RULES_PATH,
// STELLAR_TOML_OUT.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP = new URL('../app/', import.meta.url);
const require = createRequire(new URL('package.json', APP));
const sdk = require('@stellar/stellar-sdk');
const { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } = sdk;

const dist = (p: string) => new URL(`dist/src/${p}`, APP).href;
const { buildIssuerSetupTx, policyFrom, sacCommands, stellarToml, ISSUER_FLAGS } = await import(dist('issuer/ops.js'));
const { loadProgramme, loadRules } = await import(dist('config.js'));

const env = process.env;
const horizonUrl = env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const passphrase = env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
const horizon = new Horizon.Server(horizonUrl);

function need(name: string): string {
  const v = env[name];
  if (!v) {
    console.error(`${name} is not set (see .env.example)`);
    process.exit(2);
  }
  return v;
}

async function setup(): Promise<void> {
  const programme = loadProgramme(env.PROGRAMME_CONFIG ? resolve(env.PROGRAMME_CONFIG) : undefined);
  const rules = loadRules(env.RULES_PATH ? resolve(env.RULES_PATH) : undefined);
  const master = Keypair.fromSecret(need('ISSUER_SECRET'));
  const issuer = master.publicKey();
  const s = {
    issuer,
    opsKey: need('OPS_PUBLIC'),
    approvalSigner: need('APPROVAL_SIGNER_PUBLIC'),
    homeDomain: programme.file.home_domain,
    policy: policyFrom(programme),
  };
  const acct = await horizon.loadAccount(issuer);
  const flags = acct.flags;
  const signers = new Map<string, number>(acct.signers.map((x: { key: string; weight: number }) => [x.key, x.weight]));
  const done =
    flags.auth_required && flags.auth_revocable && flags.auth_clawback_enabled &&
    signers.get(s.opsKey) === s.policy.opsKeyWeight &&
    signers.get(s.approvalSigner) === s.policy.approvalSignerWeight &&
    acct.thresholds.med_threshold === s.policy.thresholds.med;
  if (done) {
    console.log(`issuer ${issuer} is already configured; nothing to do`);
  } else {
    const tx = buildIssuerSetupTx(new sdk.Account(issuer, acct.sequenceNumber()), s, passphrase);
    tx.sign(master);
    const res = await horizon.submitTransaction(tx);
    console.log(`issuer setup submitted: ${res.hash}`);
    console.log(`  flags ${ISSUER_FLAGS} (AUTH_REQUIRED|AUTH_REVOCABLE|AUTH_CLAWBACK_ENABLED), home_domain ${s.homeDomain}`);
    console.log(`  signers: ops ${s.opsKey} w${s.policy.opsKeyWeight}, approval ${s.approvalSigner} w${s.policy.approvalSignerWeight}, master w${s.policy.masterWeight}`);
    console.log(`  thresholds low/med/high ${s.policy.thresholds.low}/${s.policy.thresholds.med}/${s.policy.thresholds.high}`);
  }
  console.log('assets: ' + [...rules.assets.keys()].map((c) => `${c}:${issuer}`).join(', '));
  console.log('next: deploy one SAC per asset and hand its admin to that asset\'s redeem_pool:');
  for (const c of sacCommands(rules, issuer)) console.log(`  ${c}`);
  const toml = stellarToml(programme, rules, issuer);
  if (env.STELLAR_TOML_OUT) {
    writeFileSync(resolve(env.STELLAR_TOML_OUT), toml);
    console.log(`wrote ${env.STELLAR_TOML_OUT}`);
  }
}

async function trust(code: string, aliases: string[]): Promise<void> {
  const issuer = env.ISSUER_PUBLIC ?? Keypair.fromSecret(need('ISSUER_SECRET')).publicKey();
  const asset = new Asset(code, issuer);
  for (const alias of aliases) {
    const kp = Keypair.fromSecret(need(`VOUCHER_SECRET_${alias.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`));
    const acct = await horizon.loadAccount(kp.publicKey());
    if (acct.balances.some((b: { asset_code?: string; asset_issuer?: string }) => b.asset_code === code && b.asset_issuer === issuer)) {
      console.log(`${alias}: trustline ${code} exists`);
      continue;
    }
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(Operation.changeTrust({ asset }))
      .setTimeout(120)
      .build();
    tx.sign(kp);
    console.log(`${alias}: ChangeTrust ${code} ${(await horizon.submitTransaction(tx)).hash}`);
  }
}

async function showFlags(address: string, code: string): Promise<void> {
  const issuer = env.ISSUER_PUBLIC ?? Keypair.fromSecret(need('ISSUER_SECRET')).publicKey();
  const acct = await horizon.loadAccount(address);
  const line = acct.balances.find((b: { asset_code?: string; asset_issuer?: string }) => b.asset_code === code && b.asset_issuer === issuer);
  if (!line) {
    console.log(`${address}: no ${code} trustline`);
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      address,
      asset: code,
      balance: line.balance,
      is_authorized: line.is_authorized,
      is_authorized_to_maintain_liabilities: line.is_authorized_to_maintain_liabilities,
      is_clawback_enabled: line.is_clawback_enabled,
    }),
  );
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'setup') await setup();
else if (cmd === 'trust' && rest.length >= 2) await trust(rest[0], rest.slice(1));
else if (cmd === 'flags' && rest.length === 2) await showFlags(rest[0], rest[1]);
else {
  console.error('usage: node scripts/issuer-setup.ts setup | trust <ASSET> <alias...> | flags <G...> <ASSET>');
  process.exit(2);
}
