# Seed data (all SIMULATED)

Every file here is generated deterministically by `app/src/seed/generate.ts` (seed
`20260901`), and the generated files are committed. The seed has two parts:

- food vouchers in a Kakuma/Kalobeyei-style refugee camp;
- farm-input vouchers in a western-Kenya-style county.

The names, phone numbers, IDs, licences and addresses are invented. The only researched
inputs are the shape of the problem (`research/10-round2-stellar-problems.md` §R3): food
transfers of $3–13 a month, licensed vendors, and duplicate registrations in input-subsidy
registries. The Stellar addresses come from simulation-only keys derived from public labels
(`app/src/keys.ts`), so their secrets can be recomputed. Never fund them.

Regenerate the files with `cd app && npm run seed`. Output is byte-identical for the same
seed.

| File | What it is |
|---|---|
| `programme.json` | Programme `KE-PILOT-SIM`, UTC+03:00. Start 2026-09-01; spending ends 2026-09-29 23:59:59 (end of day 28); redemption deadline 2026-10-13 23:59:59 (day 42). OVFOOD entitlement `min(13, 3 × household size)`; OVAGRI 40.00 once. Issuer thresholds and signer weights. `llm_dedup_allowed: false`. |
| `rules.json` | Caps (OVFOOD 5.00/day, 10.00/7 days; OVAGRI 25.00/day, 40.00/7 days), category bits, licence-class → category map, `min_licence_days` 30, name-match threshold 0.8, 300 s timebound, 60 s registry cache. Its sha256 is the rules hash (`docs/SEP8-RULES.md`). |
| `beneficiaries.csv` | 500 recipient rows (400 food, 100 farm-input). |
| `dedup-decisions.csv` | Staff decisions for the 15 candidate pairs: 12 `same`, 3 `distinct`. `decided_by` is labelled "(simulated)". |
| `sdp-disbursement.csv` | SDP-style disbursement CSV (`phone,walletAddress,id,amount,verification,paymentID`), one row per beneficiary, duplicates included. `voucher disburse` removes them after staff decisions. |
| `merchants.csv` | 30 merchants (see below). |
| `licence-registry.csv` | 60 licences exported from the (fictional) licensing authorities. |
| `licence-registry.sig` | Ed25519 signature over `sha256(licence-registry.csv)` by the test agency key. |
| `test-agency-key.json` | **Test-only** agency keypair used to sign the registry. Its secret is public by construction. |
| `spend-weeks-1-4.jsonl` | 4,036 payment attempts over four weeks, each labelled with the kind of attempt it plants. |
| `expected.json` | Counts the generator planted and the totals the simulator must reproduce. `app/test/scenario.test.ts` asserts them exactly. |
| `pool-plan.json` | Pool funding and weekly redemption rounds. The Rust scenario test `scenario_programme_cycle` mirrors it. |

## Planted mess

**`beneficiaries.csv`**
- **12 near-duplicate pairs** (9 food, 3 agri), listed in `expected.json`. They cover:
  - name variants and transliteration (Mohamed/Mohammed/Muhammad);
  - day/month-swapped birth dates;
  - `07…` / `+2547…` / `2547…` / spaced phone formats;
  - a transposed ID digit;
  - one pair with no date of birth.
- **3 hard negatives:** two pairs of twins, and two brothers sharing a phone. They must
  land in `review`, not `likely_same`.
- **Other mess:**
  - 23 rows with no date of birth;
  - 6 malformed national IDs;
  - mixed date formats (`27/12/2002`, `1997-02-23`);
  - stray whitespace and mixed case.

**`merchants.csv`**
- **M01–M16** food, **M17–M22** agri and **M23–M24** both: 24 legacy vendors enrolled by
  the agency.
- **M25–M27** food and **M28–M29** agri: 5 merchants that self-onboard in week 1.
- **M30** claims a food licence number that is not in the registry and is refused with
  `LICENCE_NOT_FOUND`.
- **M07** is suspended on day 17 (a price complaint under review) and reinstated on day 33.
- Licence numbers are typed inconsistently: `sbp tcg 2026 0107`, `SBP-TCG-2026-0114`,
  ` SBP/ TCG/ 2026/ 0121`.

**`licence-registry.csv`**
- Three licences have status `expired`.
- One has status `valid` but an expiry date in the past.
- One expires on 2026-09-20, inside the `min_licence_days` window.
- There are classes with no voucher category (`PHARMACY`, `EATING_HOUSE`) and lower-case
  authority codes.

**`spend-weeks-1-4.jsonl`**
- Amounts have 2–3 decimals, from KES prices at 129.3 KES/USD.
- Exactly these invalid attempts are planted:

  | Kind | Attempts | Expected code |
  |---|---|---|
  | peer-to-peer | 40 | `PEER_TO_PEER` |
  | unregistered address | 25 | `MERCHANT_NOT_REGISTERED` |
  | to M30 (never activated) | 18 | `MERCHANT_NOT_REGISTERED` |
  | over the daily cap | 60 | `DAILY_CAP` |
  | over the weekly cap | 35 | `WEEKLY_CAP` |
  | wrong category | 15 | `CATEGORY_MISMATCH` |
  | to M07 while suspended | 12 | `MERCHANT_NOT_ACTIVE` |
  | after expiry | 10 | `PROGRAMME_NOT_ACTIVE` |

- The remaining 3,821 attempts are valid and must all be approved: no false refusals.

**`pool-plan.json`**
- The food pool is funded on day 1 at 85% of food disbursed (3,472.25 of 4,085.00), so the
  week-4 redemptions run short and queue.
- The food pool is topped up by 612.75 on day 30, and the queue settles.
- The agri pool is fully funded.
