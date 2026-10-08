# Open Voucher demo

These are the exact commands and the output they produced on 2026-09-27 (Rust 1.94.1,
stellar-cli 28.0.0, Node 22.22.2). Every step runs offline. All data is Simulated
(`data/seed/README.md`), and every address comes from a simulation-only key.

Run everything from the project root, `stellar/open-voucher/`, unless a step says otherwise.

## 1. Contracts in the Soroban host

```bash
cargo test -j 2
```

```
running 29 tests            # merchant_registry
...
test test::licence_hash_vectors_match_typescript ... ok
test test::revoke_is_terminal_and_retires_the_licence ... ok
test test::is_active_false_after_licence_expiry_and_for_wrong_category ... ok
...
test result: ok. 29 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

running 19 tests            # redeem_pool
...
test test::shortfall_queues_and_later_claims_never_jump_the_queue ... ok
test test::deauthorised_balances_cannot_move_vouchers_but_can_be_clawed_back ... ok
test test::scenario::scenario_programme_cycle ... ok
test test::property_invariants_hold_over_random_sequences ... ok
test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

```bash
stellar contract build
ls -l target/wasm32v1-none/release/*.wasm
```

```
12577  merchant_registry.wasm
12316  redeem_pool.wasm
```

The scenario test `scenario_programme_cycle` runs the pool journey with the seed's
redemption rounds:

1. 24 legacy and 5 self-onboarded merchants; M30 is never active.
2. The food pool is funded at 85%.
3. Four weekly redemption rounds run.
4. M07 is suspended in week 3 and refused `MerchantNotActive`.
5. The week-4 claims queue on the shortfall.
6. A top-up and `settle_queue` pay them in order.
7. M07 is reinstated and paid.
8. After the deadline, `redeem` fails and the surplus is withdrawn.

## 2. App: install, build, offline tests

```bash
cd app
npm install
npm test
```

```
# tests 103
# pass 103
# fail 0
```

No test needs a network, an RPC or an LLM key. The rest of this demo runs from `app/`.

## 3. The whole programme, offline

```bash
node dist/src/cli.js simulate --weeks 4 --out out
```

```
Open Voucher simulation: KE-PILOT-SIM (SIMULATED data, 4 weeks, no network)
beneficiary duplicates skipped at disbursement: 12; disbursement sandwiches built: 488
disbursed:  OVFOOD 4,085.00  OVAGRI 3,880.00
payment attempts 4036: approved 3821, refused 215, false refusals 0
  CATEGORY_MISMATCH        15
  DAILY_CAP                60
  MERCHANT_NOT_ACTIVE      12
  MERCHANT_NOT_REGISTERED  43
  PEER_TO_PEER             40
  PROGRAMME_NOT_ACTIVE     10
  WEEKLY_CAP               35
spent:      OVFOOD 3,732.71  OVAGRI 3,572.82
clawed back at expiry (recipients only): OVFOOD 352.29  OVAGRI 307.18 in 2 tx
onboarding: M25 active 4 min; M28 active 4 min; M26 active 4 min; M30 rejected (LICENCE_NOT_FOUND); M27 active 4 min; M29 active 4 min
redeem day  7 OVFOOD: paid 915.98
redeem day  7 OVAGRI: paid 785.97
redeem day 14 OVFOOD: paid 990.48
redeem day 14 OVAGRI: paid 704.48
redeem day 21 OVFOOD: paid 931.46; M07 MerchantNotActive
redeem day 21 OVAGRI: paid 1,182.13
redeem day 28 OVFOOD: paid 623.54; M07 MerchantNotActive, M15 Queued #0, M16 Queued #1, M23 Queued #2, M24 Queued #3, M25 Queued #4, M26 Queued #5, M27 Queued #6
redeem day 28 OVAGRI: paid 900.24
redeem day 34 OVFOOD: paid 3.87
queued after week 4: OVFOOD 267.38; after top-up and settle: 0.00
paid to merchants: OVFOOD 3,732.71  OVAGRI 3,572.82 (receipts 3,732.71 / 3,572.82)
surplus withdrawn after deadline: OVFOOD 352.29  OVAGRI 307.18
pool invariants: hold
```

The run takes about 25 s and exits 0. It exits 1 if any valid attempt is refused or a pool
invariant breaks.

What happened in the run:

- **Payments.** Every attempt went through the real approval service: payment XDR in,
  co-signed five-op sandwich out.
- **Refusals.** MERCHANT_NOT_REGISTERED is 25 attempts to unregistered addresses plus 18 to
  M30. Every refusal count equals `data/seed/expected.json`.
- **M07.** Its suspension (days 17–33) shows up in two places: 12 refused payments, and
  its redemptions refused on days 21 and 28 but paid on day 34.
- **Files.** `out/` now holds `sim-events.json`, `holdings-day28.json` and
  `sim-summary.json`. `--json` prints the summary as JSON.

## 4. Duplicate detection (staff decide)

```bash
node dist/src/cli.js dedup --csv ../data/seed/beneficiaries.csv --out out/dedup-candidates.csv
head -3 out/dedup-candidates.csv
```

```
500 rows, 15 candidate pairs (12 likely_same, 3 review) via heuristic
wrote .../app/out/dedup-candidates.csv; staff fill the decision column with same | distinct | unsure
row_a,row_b,score,band,reasons,decision
R0069,R0254,1.000,likely_same,name 1.00; phone equal after E.164 normalisation; date of birth equal; national ID equal,
R0084,R0436,1.000,likely_same,name 1.00; phone equal after E.164 normalisation; date of birth equal with day/month swapped; national ID equal,
```

- **Results.** All 12 planted duplicates are `likely_same`. The 3 hard negatives (twins,
  brothers sharing a phone) are in `review`.
- **LLM.** `--provider llm` is refused with a message unless `LLM_API_KEY` is set **and**
  `programme.json` has `llm_dedup_allowed: true`.
- **Staff decisions.** `../data/seed/dedup-decisions.csv` is the filled-in staff file
  (12 `same`, 3 `distinct`).

## 5. Disbursement plan (SDP stand-in)

```bash
node dist/src/cli.js disburse --sdp-csv ../data/seed/sdp-disbursement.csv --asset OVFOOD \
  --decisions ../data/seed/dedup-decisions.csv --dry-run
```

```
OVFOOD: 391 recipients, total 4085.00; skipped 9 duplicate row(s): R0207=R0200, R0218=R0099, R0219=R0198, R0254=R0069, R0267=R0261, R0304=R0252, R0426=R0154, R0436=R0084, R0480=R0193
dry run: built 391 authorise → payment → maintain-liabilities transactions from GCHJGF3F…NJO5; first:
AAAAAgAAAACOkxdl…
```

With `--asset OVAGRI` the result is 97 recipients, 3,880.00, with 3 duplicates skipped.
Without the decisions file, or with an undecided `likely_same` pair, the command refuses
to run.

## 6. Issuer setup, SAC commands, stellar.toml

```bash
node dist/src/cli.js issue --programme KE-PILOT-SIM --config ../data/seed/programme.json --offline
```

```
issuer GCHJGF3FFVXQPLUO43D4SYXF466IH2G7QYOMVLMAM267BLLLPJBFNJO5 for KE-PILOT-SIM
SetOptions: flags AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED, home_domain voucher.example.org
SetOptions: signer ops key GCBCWT46… weight 10; approval signer GATDNVFR… weight 1
SetOptions: master weight 20, thresholds low 1 / med 10 / high 20
  setTrustLineFlags  approval signer: yes  ops key: yes  master: yes
  payment            approval signer: no  ops key: yes  master: yes
  clawback           approval signer: no  ops key: yes  master: yes
  setOptions         approval signer: no  ops key: no  master: yes
assets: OVFOOD:GCHJ…NJO5, OVAGRI:GCHJ…NJO5
SAC deployment (run after the issuer setup):
  stellar contract asset deploy --asset OVFOOD:GCHJ…NJO5 --source agency-master --network testnet
  stellar contract invoke --id $(stellar contract id asset …) … -- set_admin --new_admin <redeem_pool for OVFOOD>
  …
stellar.toml:
…            (full text in ../docs/STELLAR-TOML.md)
offline: 4 operations, unsigned XDR (sequence placeholder):
AAAAAgAAAACOkxdl…
```

The permission table is the point of this step. The approval signer can authorise
trustlines but cannot mint, claw back or change signers.

## 7. Approval server over HTTP (demo mode)

Demo mode uses an in-memory registry with the 24 legacy merchants, loads the 500 seed
recipients from `beneficiaries.csv` and signs with simulation keys. It still verifies the
licence-registry signature before it starts.

```bash
node dist/src/cli.js serve --demo --port 8089 &
curl -s localhost:8089/health
```

```
approval server for KE-PILOT-SIM on :8089 (rules ac5d7de0cbe7, DEMO mode: in-memory registry, simulation keys)
{"ok":true,"programme":"KE-PILOT-SIM","rules_sha256":"ac5d7de0cbe79e51261c18b2cde872631e12586010fa55f49f8deab26bdd6540"}
```

Next, make payments from recipient R0001 (food). The recipient's simulation-only secret
can be recomputed by anyone:

```bash
export ISSUER_PUBLIC=GCHJGF3FFVXQPLUO43D4SYXF466IH2G7QYOMVLMAM267BLLLPJBFNJO5
export VOUCHER_SECRET_R0001=$(node --input-type=module -e "import {simKeypair} from './dist/src/keys.js'; console.log(simKeypair('recipient/R0001').secret())")
M01=GDK6P72HUZA4RSLZADIU6HK3BZJTHE4YYGDMWJBWFZSLRCE7JEIKRX4F   # food shop
M17=GANPGEXGTZLI4SOZYP6ELHRI7PL3BIJUZMCKUHGMMI23TCEHBV3OTUPS   # agro-dealer
R0002=GC4SSDS32O34GREAAQV2XB3K3ANE7Y75QVXOGYDM7VHPEEA4OPUJBZKP # another recipient
approve() {
  XDR=$(node dist/src/cli.js pay --from R0001 --merchant "$1" --asset "$2" --amount "$3" --dry-run | tail -1)
  curl -s -X POST localhost:8089/tx-approve -H 'content-type: application/json' -d "{\"tx\":\"$XDR\"}"; echo
}
approve $M01 OVFOOD 4.50
approve $M01 OVFOOD 1.00
approve $R0002 OVFOOD 0.50
approve $M17 OVFOOD 0.50
approve $M17 OVAGRI 0.50
```

```
{"status":"revised","tx":"AAAAAgAAAABl665m…","message":"Approved 4.50 OVFOOD under rules ac5d7de0cbe7; sign and submit before …"}
{"status":"rejected","error":"DAILY_CAP: daily cap 5.00 OVFOOD: 4.50 already used today, 1.00 requested","code":"DAILY_CAP"}
{"status":"rejected","error":"PEER_TO_PEER: vouchers cannot be sent to another recipient","code":"PEER_TO_PEER"}
{"status":"rejected","error":"CATEGORY_MISMATCH: merchant is not registered for food","code":"CATEGORY_MISMATCH"}
{"status":"rejected","error":"SOURCE_NOT_BENEFICIARY: source is not an enrolled OVAGRI recipient","code":"SOURCE_NOT_BENEFICIARY"}
```

Notes:

- **Reading the revised transaction.** It holds the five-op sandwich, `MEMO_HASH` = rules
  hash and the approval signer's signature. `sandwich.test.ts` decodes and checks it.
- **Stopping and resetting.** Stop the server with `kill %1`. The store persists in
  `out/approval-store.json`; delete it to reset the caps.
- **After 2026-09-29.** The seed programme ends at 2026-09-29 23:59:59 +03:00. After that
  every payment is refused `PROGRAMME_NOT_ACTIVE`. To run this step later, copy
  `../data/seed/programme.json`, move `start`/`expiry`/`redeem_deadline` forward, and start
  the server with `PROGRAMME_CONFIG=<copy>`.

## 8. Expiry clawback plan

```bash
node dist/src/cli.js expire --programme KE-PILOT-SIM --holdings out/holdings-day28.json --dry-run
```

```
clawback OVFOOD: 352.29
clawback OVAGRI: 307.178
2 transaction(s) of at most 100 Clawback ops; 1 merchant balance(s) left for redemption
```

Only recipient balances are clawed back. Merchant balances stay redeemable until the
deadline.

## 9. Donor report (draft, then staff sign-off)

```bash
node dist/src/cli.js report --programme KE-PILOT-SIM --from 2026-09-01 --to 2026-10-14 \
  --events out/sim-events.json --out out/report.md
node dist/src/cli.js report --programme KE-PILOT-SIM --from 2026-09-01 --to 2026-10-14 \
  --events out/sim-events.json --out out/report.md --approve "A. Programme Officer"
cat out/report.md
```

```
wrote DRAFT .../app/out/report.md (heuristic); figures sha256 6cfd5a04fcd55966c57929070b0298d7be7f60dfa19bd086c13dc104bbbf8620
approved .../app/out/report.md by A. Programme Officer
> APPROVED by A. Programme Officer on 2026-09-27. Figures sha256: 6cfd5a04….

# Donor report: KE-PILOT-SIM
Period: 2026-09-01 to 2026-10-14.
## Disbursement and spending
- Vouchers disbursed: OVFOOD 4,085.00 USD, OVAGRI 3,880.00 USD.
- Spent at registered merchants: food 3,732.71 USD, farm inputs 3,572.82 USD, in 3821 approved payments.
- Unspent recipient balances clawed back at expiry: OVFOOD 352.29 USD, OVAGRI 307.18 USD.
## Merchant redemption
- Paid to merchants in USDC: OVFOOD pool 3,732.71 USD, OVAGRI pool 3,572.82 USD.
- Claims still queued: OVFOOD 0.00 USD, OVAGRI 0.00 USD.
- Shortfall events: 7 (total gap 196.94 USD at the time of each claim).
## Merchants
- Active merchants: 29 (24 enrolled by the agency, 5 self-onboarded).
- Median time from application to activation for self-onboarded merchants: 4 minutes.
- Share of spending at the top 5 merchants: 37.73%.
## Refused payment attempts
| Reason code | Attempts | ...   (the 7 codes from step 3)
```

- **LLM drafts.** With `--provider llm` and an `LLM_API_KEY`, the model drafts from the
  figures JSON only. A draft with any number that is not a figure is discarded, and the
  template is used instead. The command prints the numbers it rejected.
- **Timing figure.** The "4 minutes" comes from the simulated clock. It is not a
  measurement.

## 10. Error handling

```bash
node dist/src/cli.js simulate --weeks 5             # error: --weeks: the seed covers 4 weeks          (exit 2)
node dist/src/cli.js pay --from x --merchant BAD --asset OVFOOD --amount 1
                                                    # error: --merchant must be a G… account address  (exit 2)
```

## 11. Testnet (written, not run here)

```bash
scripts/deploy-testnet.sh      # keys, issuer setup, test USDC, registry, SACs, pools, set_admin → app/.env
scripts/e2e-testnet.sh         # full journey with a short programme, expiry clawback, verify-first (a)–(c)
```

Neither script was executed: the build environment could not reach Stellar testnet,
Horizon or Friendbot. `scripts/issuer-setup.ts` loads and reaches the Horizon call, where
the sandbox proxy refused the connection. Record every transaction hash from the first real
run in `VALIDATION.md`.
