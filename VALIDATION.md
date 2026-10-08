# Open Voucher validation

This file records what we know, what we assume, what we built, and what would prove or kill
the idea. None of it claims adoption: there is no user, agency, merchant, interview, pilot
or partner. Section ids follow `research/round2-specs/12-open-voucher.md`:

- `10-R3` = `research/10-round2-stellar-problems.md` §R3
- `12-§3` = `research/12-round2-demoted-recheck.md` §3
- `03-G1` = `research/03-problems-enterprise-b2b.md` §G1
- `01-§n` = `research/01-stellar-ecosystem.md` section n

## Evidence tiers

### Researched evidence

**The problem**
- WFP's Kenya refugee programme: about 400,000 refugees received $3–13 a month in restricted
  digital transfers. They could spend them only at 252 licensed vendors, against 1,400+
  vendors competing for cash customers, and the licensed vendors charged 16–30% more for the
  same goods (`10-R3`, `03-G1`; ictworks.org, "hidden cost premium").
- Kenya's fertiliser-subsidy e-voucher registry accepted several registrations from the same
  farmer on the same land. Cartels hoarded vouchers, and the Auditor-General flagged
  KSh31.5bn of irregularities in 2025 (`10-R3` Variant B).
- In 2025, UN agencies delivered 53% of cash and voucher assistance, NGOs 35% and the Red
  Cross/Red Crescent 12% (`10-R3`). WFP's cost-transfer ratio is about 17 cents per dollar
  (`03-G1`).

**The Stellar ecosystem**
- SDP backend 7.0.0 added multiple distribution accounts, audit tables and wallet rotation.
  It has no clawback, restricted-asset or voucher logic (`12-§3(a)`, `01-§5`).
- Stellar already has humanitarian deployments: Stellar Aid Assist (UNHCR), Hope for Haiti
  with VIA, and the Bousol/Fonkoze/Mercy Corps Ventures Haiti pilot with a local vendor
  network (`12-§3(a)`, `10-R3`, `03-G1`, `01-§5`).
- SEP-8 is Final. The issuer flags `AUTH_REQUIRED`, `AUTH_REVOCABLE` and
  `AUTH_CLAWBACK_ENABLED` exist, and the SAC honours them (`01-§4`, `01-§8`).
- A GitHub search found no Stellar voucher contracts. Cygnus, Milepost and lastmile-contracts
  do milestone or offline disbursement and do not restrict the token itself (`12-§3(c)`,
  `10-R3`).

**Portfolio history**
- The cross-agency dedup half of the original idea was killed: WFP Building Blocks already
  serves 159 organisations (`12-§3(a),(d)`).
- `12-§3(h)` judges the project "an SDP feature/public-good PR, not a company", and this
  project accepts that judgement.

### Observed facts (this repository, 2026-09-27)

**Contracts**
- `cargo test` passes 48 tests in the Soroban host: 29 for `merchant_registry` and 19 for
  `redeem_pool`. The `redeem_pool` tests include a 200-sequence property test of the pool
  invariants and `scenario_programme_cycle`.
- `stellar contract build` produces `merchant_registry.wasm` (12,577 bytes) and
  `redeem_pool.wasm` (12,316 bytes).

**App tests**
- `npm test` passes 103 offline tests: one per reason code, the cap boundaries,
  reservations, the sandwich layout, the threshold classification, onboarding, the licence
  registry signature, dedup, the report guard and the full simulation.

**Simulation** (`voucher simulate --weeks 4`, over the committed seed)
- 4,036 attempts: 3,821 approved, 215 refused, 0 false refusals.
- The refusal count for each code equals `expected.json` exactly.
- Disbursed = spent + unspent: OVFOOD 4,085.00 = 3,732.71 + 352.29 and OVAGRI
  3,880.00 = 3,572.822 + 307.178 (the report rounds these to 3,572.82 and 307.18).
- The unspent amounts are clawed back at expiry in 2 transactions.
- Week-4 food redemptions queue 7 claims (267.38). The day-30 top-up settles them.
- Merchant USDC paid equals merchant voucher receipts.

**Dedup and onboarding**
- The heuristic finds all 12 planted duplicate pairs as `likely_same`. The 3 hard negatives
  land in `review`, and no other pair is proposed.
- Onboarding activates the 5 self-onboarding merchants and refuses M30 with
  `LICENCE_NOT_FOUND`. The "4 minutes" apply→active in the simulation is the simulated
  clock, not a measurement.

**Approval server and seed**
- `voucher serve --demo` answered over HTTP on 2026-09-27: a valid payment came back
  `revised`, and the P2P, over-cap, category-mismatch and wrong-asset payments came back
  `rejected` with the right codes (`docs/SEP8-RULES.md`).
- Regenerating the seed (`npm run seed`) reproduces the committed files byte for byte.

**SDP format**
- The SDP disbursement CSV column names used here match the `csv:` tags in the SDP backend
  source (`docs/SDP-INTEGRATION.md`).

**Not done**
- No testnet deployment was made, and the verify-first items (a)–(c) in `ARCHITECTURE.md`
  are unconfirmed. The build environment could not reach Stellar testnet, Horizon or
  Friendbot (`TOOLCHAIN.md`).

### Team assumptions

- Agencies that fixed their vendor lists did so deliberately, for price monitoring and
  diversion control. Demand for open onboarding exists in some programmes and not in others.
- Contracting a new vendor takes weeks of procurement (unknown; to be measured).
- A licensing authority's register, exported and signed by the agency, is good enough
  evidence for activating a merchant.
- Agencies would fund a USDC float and accept clawback of unspent balances at expiry.
- Recipients can hold a classic trustline in a wallet that submits SEP-8 transactions.
  SDP embedded wallets may not be able to (contract accounts).
- Agencies keep a fallback cash or paper process for approval-server outages.

### Hypotheses

- **H1 (price):** a wider merchant set narrows the voucher-versus-cash price gap for a fixed
  basket. The baseline is 16–30% in one programme (`10-R3`).
- **H2 (onboarding):** a merchant with a valid licence reaches its first accepted payment
  in under 1 hour. Today's baseline is unknown.
- **H3 (leakage):** 100% of P2P, unregistered-merchant, over-cap, wrong-category,
  suspended-merchant and post-expiry attempts are refused, with no false refusals. This
  holds on Simulated data only.
- **H4 (reporting):** a donor-report draft generated from events saves staff hours per
  cycle. Today's baseline is unknown.
- **H5 (merchant cash):** merchants accept voucher sales if par redemption to USDC arrives
  within one ledger and cash-out works locally. Local anchor coverage was not researched.

### Simulated / demo data

Everything in `data/seed/` is Simulated (see `data/seed/README.md`):

- programme `KE-PILOT-SIM`;
- 500 beneficiary rows with planted duplicates and hard negatives;
- 30 merchants and 60 licences;
- 4,036 payment attempts with planted invalid ones;
- the pool plan.

The caps (5/10 food, 25/40 agri) and the 85% funding level are choices made for the seed,
not observed programme parameters.

### Actual validation

None yet. No programme officer, merchant, recipient or SDP maintainer has seen this.

## Baseline and success metric

| Metric | Baseline | Target | Level now |
|---|---|---|---|
| Voucher-vs-cash price gap, fixed basket, participating merchants | 16–30% (one programme, `10-R3`) | falls as the merchant count rises | not measurable in the MVP; needs a pilot price survey |
| Onboarding time, application → first accepted payment | unknown (procurement; interviews) | < 1 hour with a valid licence | Simulated only |
| Planted invalid attempts refused; valid attempts refused | – | 100%; 0 | Simulated, asserted by test |
| Redemption to USDC | agency finance reconciles vendor claims (Assumption) | one transaction (~5 s ledger, `01-§14`), coverage public | contract-tested in the host; not on testnet |
| Unspent recipient balances clawed back and reported at expiry | written off or reconciled by hand (Assumption) | 100% | Simulated |
| Donor-report draft | staff time unknown | minutes from events | Simulated events only |

## Experiment plan

**Week 1: 8–10 conversations.**
- Who: cash programme officers and CVA leads, reached through the CALP Network and East
  African cash working groups (`12-§3(b)`, `10-R3`), plus SDP maintainers on GitHub/Discord.
- Questions:
  - How is a vendor added today, and how long does it take?
  - **Was the vendor cap chosen deliberately, and for what?** This is the killer question.
    If every respondent says the cap is intentional and wanted, the project stops at an SDP
    contribution.
  - Which licence registry would you trust?
  - Would you fund a float and accept clawback at expiry?
- Also: one input-subsidy programme contact, if reachable, on duplicate registrations.
- Output: baselines for onboarding time and reconciliation hours from named respondents
  (Observed, with consent), recorded here.

**Week 2.**
- Run `scripts/e2e-testnet.sh` and record every transaction hash and the verify-first
  results (a)–(c) here. If (c) fails, stop.
- One programme officer runs the testnet walk-through with their own category and cap
  settings.
- 3–5 real shopkeepers try self-onboarding on testnet with dummy licence numbers in their
  real licence format. Measure completion rate and minutes.
- File the SDP issue drafted in `docs/SDP-INTEGRATION.md` and record the maintainers'
  response.

**Pilot (beyond the MVP, `12-§3(g)`).** One NGO, 50 recipients, 5 merchants, redemption
within 30 days. Measure leakage and do a basket price comparison against cash vendors.

**Willingness to pay.** Ask whether the country office or the donor would pay $1–5k a month
per programme (the range is labelled an estimate in `10-R3`/`03-G1`), or whether this only
makes sense as a free SDP feature.

**Kill criteria.**
- Every week-1 respondent says the vendor cap is wanted.
- Verify-first (c) fails on testnet.
- SDP maintainers reject a regulated-asset path and no agency would run a separate
  disbursement tool.

## Killer questions

1. **Would the user care if it disappeared?** Untested. The problem (the vendor-market-power
   premium and duplicate registrations) is documented, but the demand for open onboarding is
   an assumption. Some agencies chose their caps on purpose.
2. **Did anyone outside the team use it?** No.
3. **Before/after measured?** No. The baselines are researched figures from one programme
   or are unknown. The instruments are defined above.
4. **Value lost without AI?** Small by design. The restriction, onboarding, redemption and
   expiry work without it. Staff lose a pre-sorted duplicate queue and a narrative draft.
   When the model is wrong:
   - A missed duplicate costs one extra entitlement, within caps, recoverable by clawback.
   - A false duplicate delays one person until staff mark the pair `distinct`.
   - An invented number is blocked by the numbers guard.
   The LLM is off by default.
5. **Reason to keep using after demo?** Hypothesis: every programme cycle repeats
   disbursement, spending, redemption and expiry. The public redemption record is only
   useful if all cycles run through it.
6. **Would someone pay?** Weakly. The primary model is an SCF-funded open-source SDP add-on
   (`12-§3(h)`). Paid hosting and approval-server operation at $1–5k a month is an untested
   estimate.
7. **Does the chain create value?** Partly, and the limit is stated. It gives a restriction
   that belongs to the asset and so survives a wallet switch, merchant settlement through any
   anchor, and a public record of issuance, redemption, float coverage and clawback. It does
   not give neutrality: the agency still runs the approval server and holds the issuer keys.
   A database would do as well if the agency ran every wallet.
8. **Why this chain?** SEP-8 regulated assets and issuer auth/clawback flags are
   protocol-level and standardised. SDP, USDC, MoneyGram Access and existing UN/INGO
   deployments are already on Stellar, and sub-cent fees suit $3–13 transfers split into
   several purchases. Arbitrum could enforce a transfer hook but has no humanitarian
   disbursement footprint or cash-out network in the target markets (`10-R3`, `03-G1`).
