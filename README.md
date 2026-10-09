# Open Voucher

Restricted-use voucher assets for cash-and-voucher programmes and farm-input subsidies on
Stellar. Any merchant with a valid licence can join, not only a fixed vendor list. Each
payment is checked against category and velocity limits at the moment it is authorised,
and merchants redeem vouchers at par for USDC. It is designed as an add-on to the Stellar
Disbursement Platform (SDP).

## Problem

Restricted transfers can often be spent only at a small, contracted vendor set, and that
set has market power. In WFP's Kenya refugee programme about 400,000 refugees received
$3-13 a month in restricted digital transfers. They could spend them only at 252 licensed
vendors, while 1,400+ vendors competed for cash customers, and the licensed vendors
charged 16-30% more for the same goods (research `10-R3`, `03-G1`). Input-subsidy
e-vouchers fail in a different way. Kenya's fertiliser registry accepted duplicate
registrations, and the Auditor-General flagged KSh31.5bn of irregularities in 2025
(`10-R3` Variant B). SDP, which Stellar humanitarian users already run, disburses
unrestricted USDC. It has no restricted asset, no merchant allowlist, no clawback and no
voucher logic (`12-§3(a)`).

**Caveat that shapes the whole project.** WFP chose the 252-vendor cap itself, for price
monitoring and diversion control. Technology did not impose it. Open Voucher does not
make a programme neutral: the agency still issues the asset, runs the approval server and
can freeze or claw back balances. The chain adds three things:

1. a restriction that belongs to the asset, so it survives a change of wallet provider;
2. merchant redemption to USDC with anchor cash-out, which does not depend on the
   agency's bank relationship with each shop;
3. a public redemption record that a donor can check.

The product is for agencies and subsidy programmes that already want open merchant
onboarding. It is not a fix to impose on WFP.

**User.** A cash programme officer or CVA lead at an INGO or UN country office who runs a
food or farm-input voucher and uses or is evaluating SDP. Secondary user: the manager of
an agricultural input-subsidy e-voucher scheme.

## What the MVP does

- **Classic asset per category.** `OVFOOD` and `OVAGRI` are issued with `AUTH_REQUIRED`,
  `AUTH_REVOCABLE` and `AUTH_CLAWBACK_ENABLED`. Recipient and merchant trustlines rest in
  the *authorised to maintain liabilities* state, so no voucher moves without the issuer.
  The issuer has three signers: master (weight 20), agency ops key (weight 10) and
  approval signer (weight 1). The approval signer can only flip trustline flags. It cannot
  mint or claw back (`app/src/issuer/ops.ts`, tested).
- **SEP-8 approval server** (`app/src/sep8/`). A pure rule engine checks 12 reason codes
  in a fixed order: single payment, asset, programme window, beneficiary, suspended,
  peer-to-peer, merchant registered, merchant active, category, amount, daily cap and
  rolling-week cap. An allowed payment comes back as a five-op sandwich (authorise both
  ends → pay → back to maintain-liabilities), co-signed by the approval signer, with
  `MEMO_HASH = sha256(rules.json)`. Caps count approved spends plus live reservations.
  The HTTP wrapper uses `node:http` only.
- **`merchant_registry`** (Soroban). Licence-bound merchant records follow the state
  machine `∅ → Pending → Active ⇄ Suspended → Revoked`. A licence hash maps to exactly one
  address. Verifier keys approve self-onboarding.
- **Self-onboarding** (`app/src/onboarding/`). A merchant submits a licence number. It is
  checked against a licence registry file signed by the agency (the server refuses to
  start if the signature fails), then against expiry, licence class and a deterministic
  name match. The merchant is activated on chain in the same request, or left `Pending`
  for staff review.
- **`redeem_pool`** (Soroban, one per asset). The pool is the SAC admin. `redeem` burns
  the merchant's vouchers through SAC `clawback` and pays USDC 1:1 from the agency float.
  If the float is short, the claim is queued FIFO and a public `shortfall` event is
  emitted. There is no `mint`, no generic clawback and no admin transfer.
- **Expiry.** `voucher expire` claws back unspent recipient balances with classic
  `Clawback` ops, at most 100 ops per transaction. Merchant balances stay redeemable
  until the redemption deadline.
- **AI, supporting only.** The CLI proposes duplicate-recipient pairs within one
  programme (heuristic: transliteration, Soundex blocking, Jaro-Winkler, E.164 phones,
  day/month-swapped birth dates, IDs within one edit). It also drafts the donor report,
  and a numbers guard falls back to a template if the draft contains any number that is
  not a computed figure. Staff decide every pair and sign every report. The LLM provider
  is optional and off by default.
- **`voucher simulate`.** The whole seed (500 beneficiary rows, 30 merchants, 4,036
  payment attempts over 4 weeks, all simulated) runs offline through the real approval
  service, onboarding, disbursement and expiry planners and a model of the pools.

## Quickstart

```bash
# contracts: unit, negative, property and scenario tests inside the Soroban host
cargo test -j 2
stellar contract build            # target/wasm32v1-none/release/{merchant_registry,redeem_pool}.wasm

# app: offline tests (no RPC, no LLM key), build, simulation
cd app
npm install
npm test
npm run build
node dist/src/cli.js simulate --weeks 4 --out out
node dist/src/cli.js report --programme KE-PILOT-SIM --from 2026-09-01 --to 2026-10-14 --events out/sim-events.json --out out/report.md
```

Where to read next:

- `DEMO.md`: every command and its expected output, including the approval server over HTTP;
- `ARCHITECTURE.md`: contract interfaces, the verify-first items that testnet must confirm,
  trust assumptions and limits;
- `VALIDATION.md`: evidence tiers, the experiment plan and the killer questions;
- `.env.example`: every variable the app reads.

## Repository layout

```
Cargo.toml                    workspace (soroban-sdk 28.0.0, release profile per CONTRIBUTING.md)
contracts/merchant_registry/  registry contract, tests, test_snapshots/
contracts/redeem_pool/        pool contract, unit/property tests, scenario_programme_cycle, test_snapshots/
README.md ARCHITECTURE.md VALIDATION.md DEMO.md .env.example
app/src/sep8/                 rule engine, velocity, sandwich builder, approval service, HTTP server, ledger watcher
app/src/onboarding/           licence normalisation, signed licence registry, self-onboarding
app/src/ai/                   dedup heuristic, provider interface, LLM provider (optional)
app/src/report/               figures, numbers guard, template, draft/approve
app/src/ops/                  disburse (SDP CSV stand-in), expire (clawback batches)
app/src/issuer/               issuer SetOptions, threshold classification, stellar.toml, SAC commands
app/src/sim/, app/src/seed/   offline simulator, deterministic seed generator
app/test/                     node --test suites + fixtures
data/seed/                    simulated seed data (see data/seed/README.md)
docs/                         SEP8-RULES.md, SDP-INTEGRATION.md, STELLAR-TOML.md, DATA-PROTECTION.md
scripts/                      issuer-setup.ts, deploy-testnet.sh, e2e-testnet.sh (not executed here)
```

## Status

**functional locally**: both contracts pass their tests in the Soroban host and build to
wasm, and the approval server, onboarding, AI helpers and simulator pass offline tests.
**testnet-ready** scripts (`scripts/issuer-setup.ts`, `scripts/deploy-testnet.sh`,
`scripts/e2e-testnet.sh`) are written but were not executed, because testnet, Horizon and
Friendbot were unreachable from the build environment. Nothing is deployed. No user,
agency or merchant has seen it. No metric has been measured. All data is simulated.

## Testnet Deployments (v0.1.0)
- **Merchant Registry:** `CCPNVKO2I3QGWPLNN5LB6YHECU5ND37HSIROZNABUSIDNM6B54E47CJZ`
- **Redeem Pool:** `CDNMS7MFIDHCIKQODQ4QFAVA3EBO34R3OLFEQVY6VWTFNFJUYUIOYLQF`
