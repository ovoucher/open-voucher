# Open Voucher architecture

## Verify first (before any pilot)

Three behaviours of the Stellar Asset Contract (SAC) on **classic G-account trustlines**
decide whether the design works as written. The Soroban host tests exercise the same calls,
but on balances of `Address::generate` addresses, which are contract addresses. Contract
balances have only an authorised/unauthorised state; classic trustlines also have
*authorised to maintain liabilities*. So the host tests do not settle these three items.
`scripts/e2e-testnet.sh` checks each one. It has **not been run**.

| # | Must hold on testnet | Where the e2e checks it | Fallback if it does not |
|---|---|---|---|
| (a) | SAC `clawback(merchant, amount)` succeeds on a G-account trustline in the maintain-liabilities state, called by the pool as SAC admin | step 8, first `voucher redeem` | Inside `redeem`, call `set_authorized(merchant, true)`, then `burn(merchant, amount)` under the merchant's auth, then `set_authorized(merchant, false)`. The pool stays the only SAC admin. |
| (b) | After `set_admin(pool)`, classic issuer operations still work: `SetTrustLineFlags`, issuer `Payment`, `Clawback` | step 4 (`voucher disburse` after deploy), step 6 (approval sandwiches), step 9 (`voucher expire`) | Keep the SAC admin with the issuer and give the pool a narrower role. This needs a contract change and weakens the "only the pool can burn through the SAC" property. |
| (c) | An account trustline that is not fully authorised blocks payments; either the maintain-liabilities or the fully de-authorised state is acceptable | step 7: trustline flags printed; a plain `Payment` between two holders must fail | None needed if either state blocks. If neither does, the restriction does not exist, and the project stops. |

What the host tests do establish (`contracts/redeem_pool/src/test.rs`):

- `deauthorised_balances_cannot_move_vouchers_but_can_be_clawed_back`: an unauthorised
  balance cannot transfer, and the pool (as SAC admin) can claw it back.
- `redeem_fails_when_pool_is_not_the_sac_admin`: if `set_admin(pool)` is skipped, `redeem`
  fails and changes nothing.
- The issuer flags `AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED` are set before
  any balance exists, as `scripts/issuer-setup.ts` does.

## Components

```
Kobo/CommCare export ─► voucher dedup (heuristic | LLM) ─► staff decisions ─► SDP CSV
                                                                              │
                     issuer (flags: REQUIRED|REVOCABLE|CLAWBACK) ◄── agency ops key (w=10)
                                                                              ▼
 voucher disburse / SDP (future) ─► auth → issuer payment → maintain-liabilities
 recipient wallet ─ payment tx ─► SEP-8 approval server ── rules.json (hash in memo)
                                   │  reads merchant_registry.get (cache 60 s)
                                   │  velocity store (spends + reservations) ◄── ledger watcher (Horizon)
                                   └─► revised 5-op sandwich signed by approval signer (w=1) ─► network
 merchant ─ /merchants/apply ─► licence registry (agency-signed) ─► merchant_registry.apply/approve
 merchant ─ redeem_pool.redeem ─► SAC.clawback(merchant) + USDC 1:1 | FIFO queue on shortfall
 agency ─ fund / settle_queue / withdraw_surplus;  expiry ─► classic Clawback of recipient balances
 events + payments ─► figures.ts ─► report draft (numbers guard) ─► staff sign-off ─► donor
```

| Component | Code | Runs where |
|---|---|---|
| Classic issuer, one per programme | `app/src/issuer/ops.ts`, `scripts/issuer-setup.ts` | Stellar classic |
| Voucher assets `OVFOOD`, `OVAGRI` (alphanum12, 7 decimals, 1 unit = 1 USD of entitlement) and one SAC each | `scripts/deploy-testnet.sh` | Stellar classic + SAC |
| `merchant_registry` | `contracts/merchant_registry` | Soroban |
| `redeem_pool`, one per voucher asset | `contracts/redeem_pool` | Soroban |
| SEP-8 approval server and onboarding endpoint | `app/src/sep8/`, `app/src/onboarding/`, `voucher serve` | Agency-hosted Node service |
| Ledger watcher | `app/src/sep8/ledger-watch.ts` (Horizon `GET /transactions/:hash`) | Inside `voucher serve` |
| Disbursement (SDP stand-in), expiry clawback | `app/src/ops/` | Agency CLI |
| Duplicate detection, report drafting | `app/src/ai/`, `app/src/report/` | Agency CLI, staff review |
| Offline simulator | `app/src/sim/` | Local, no network |

## Classic issuer

`SetOptions` settings on the issuer (`issuerSetupOps`):

- **Flags:** `AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED`. `AUTH_IMMUTABLE` is
  not set. `home_domain` is set.
- **Thresholds:** low 1, med 10, high 20.
- **Signers:**

  | Signer | Weight | Can sign | Cannot sign |
  |---|---|---|---|
  | master | 20 | everything | – |
  | agency ops key | 10 | issuer payments (disbursement), `Clawback` (expiry) | `SetOptions` (signers, thresholds) |
  | approval signer | 1 | `SetTrustLineFlags` only | payments, `Clawback`, `SetOptions` |

  The master key is held offline.

`OP_THRESHOLD` in `issuer/ops.ts` is taken from the Stellar "List of operations" page:
`SetTrustLineFlags` is low, `Payment` and `Clawback` are medium, and `SetOptions` changing
signers is high. `app/test/ops.test.ts` asserts that the approval signer can authorise
trustlines and cannot mint, claw back or change signers. `voucher issue --offline` prints
the same table.

A trustline starts unauthorised because of `AUTH_REQUIRED`. `voucher disburse` authorises
it, pays and returns it to maintain-liabilities, all in one transaction signed by the ops
key. From then on it moves only inside an approval-server sandwich (`docs/SEP8-RULES.md`).

## Contract `merchant_registry`

```
enum MerchantStatus { Pending, Active, Suspended, Revoked }
struct Merchant { licence_hash: BytesN<32>, categories: u32, status, self_onboarded: bool,
                  applied_at: u64, activated_at: u64, licence_expires: u64, reason: u32 }
```

- **Categories.** Bits `FOOD = 1` and `AGRI = 2`. The known mask starts at 3, and
  `set_known_mask` can only add bits.
- **Licence hash.** `licence_hash = sha256(upper(authority) || ":" || normalised_licence_no)`.
  Normalisation upper-cases the number and keeps only A–Z and 0–9, so `BP/2026/00123`,
  `bp 2026 00123` and `BP-2026-00123` all give `BP202600123`. The vectors are
  shared between `licence_hash_vectors_match_typescript` (Rust) and `onboarding.test.ts`
  (TypeScript).

| Function | Auth | Effect |
|---|---|---|
| `init(admin)` | – | once |
| `set_verifier(verifier, enabled)` | admin | |
| `set_known_mask(mask)` | admin | add bits only (`MaskShrink`) |
| `enrol(merchant, licence_hash, categories, licence_expires)` | admin | legacy vendor → `Active`, `self_onboarded=false` |
| `apply(merchant, licence_hash, categories)` | merchant | → `Pending`, `self_onboarded=true`; refuses unknown/zero mask, a licence bound elsewhere, an existing non-revoked record |
| `approve(verifier, merchant, licence_expires)` | enabled verifier | `Pending → Active`; `licence_expires > now` |
| `reject(verifier, merchant, reason)` | enabled verifier | `Pending →` removed, licence freed |
| `suspend(merchant, reason)` / `reinstate(merchant)` | admin | `Active ⇄ Suspended` |
| `revoke(merchant, reason)` | admin | `Pending/Active/Suspended → Revoked` (terminal; licence stays bound) |
| `set_categories`, `renew_licence` | admin / verifier | |
| `get`, `is_active(merchant, category)`, `count`, `known_mask`, `is_verifier`, `licence_owner`, `admin` | – | views |

- **`is_active`.** It is `status == Active && now < licence_expires && categories &
  category != 0`. When a licence expires, `is_active` turns false without any change of
  state.
- **Errors:** `AlreadyInitialised=1, NotInitialised=2, NotVerifier=3, UnknownCategory=4,
  LicenceInUse=5, AlreadyExists=6, NotFound=7, BadState=8, LicenceExpired=9, MaskShrink=10`.
- **Events:** `applied`, `approved`, `enrolled`, `rejected`, `suspended`, `reinstated`,
  `revoked`.
- **Storage.** Instance storage holds `Admin`, `KnownMask` and `Count`. Persistent storage
  holds `Verifier(addr)`, `Merchant(addr)` and `Licence(hash) → addr`. Every write extends
  the TTL to about 120 days once it falls under about 30 days.

## Contract `redeem_pool` (one per voucher asset)

```
struct Config   { admin, registry, voucher /*SAC*/, usdc /*SAC*/, category: u32, redeem_deadline: u64 }
struct Totals   { funded, paid, queued, clawed, withdrawn }            // i128, cumulative except queued
struct Claim    { merchant, amount, queued_at }
enum RedeemOutcome { Paid(i128), Queued(u32) }
struct Coverage { float, queued, paid, clawed }
```

| Function | Auth | Effect |
|---|---|---|
| `init(admin, registry, voucher, usdc, category, redeem_deadline)` | – | once; the deployer then calls the voucher SAC's `set_admin(pool)` |
| `fund(from, amount)` | `from` | USDC `from → pool`; `funded += amount` |
| `redeem(merchant, amount)` | merchant | checks, in order: amount > 0, `now ≤ deadline`, `registry.is_active(merchant, category)`, voucher balance ≥ amount; then SAC `clawback` (burn), `clawed += amount`; pays USDC 1:1 if the queue is empty and the float covers it, otherwise appends a FIFO claim and emits `shortfall` |
| `settle_queue(max)` | anyone | pays claims from the head in order, stops at the first it cannot pay |
| `extend_deadline(new)` | admin | must be later |
| `withdraw_surplus(to, amount)` | admin | only after the deadline and with an empty queue |
| `coverage`, `totals`, `claim(id)`, `queue`, `config` | – | views |

- **Errors:** `AlreadyInitialised=1, NotInitialised=2, InvalidAmount=3, MerchantNotActive=4,
  InsufficientVouchers=5, RedemptionClosed=6, WindowOpen=7, QueueNotEmpty=8,
  InsufficientFloat=9, DeadlineNotLater=10`.
- **Events:** `fund`, `redeem` (amount, outcome), `shortfall` (amount, gap), `settle`,
  `withdraw`.
- **Invariants.** The property test checks these after every step of 200 seeded random
  sequences: `clawed == paid + queued`; `usdc.balance(pool) == funded - paid - withdrawn`;
  no negative balances; claims paid in id order.
- **Deliberately absent.** The pool has no `mint`, no generic `clawback` and no admin
  transfer. As SAC admin it could technically do all three, but its code exposes only
  merchant-authorised `redeem`.
- **Settling a suspended merchant.** A claim queued before its merchant was suspended is
  still paid by `settle_queue`: the vouchers were already burned, so the claim is a debt.
  The test is `settle_pays_a_claim_even_if_the_merchant_was_suspended_after_queueing`.

## Approval server and onboarding

- **Endpoints** (plain `node:http`):
  - `POST /tx-approve` `{tx}` returns 200 `revised` or 400 `rejected`.
  - `POST /merchants/apply` returns 200 `active` / `pending_review` or 422 `rejected`.
  - `GET /health` and `GET /rules`.
- **Rules.** Rules, reason codes, caps, reservations and the sandwich layout are in
  `docs/SEP8-RULES.md`.
- **Registry reads.** `RegistryReader` simulates `merchant_registry.get` over RPC, behind a
  60 s cache. Tests use an in-memory registry.
- **Store.** `MemoryStore` (tests, simulator) and `JsonFileStore` (`STORE_PATH`). The store
  holds recipients, spends and reservations, cached results, the refusal log and the
  onboarding log. `voucher disburse` enrols each recipient it pays for that asset; start
  `voucher serve` after disbursing so it loads them.
- **Ledger watcher.** Outside demo mode, `voucher serve` polls Horizon every
  `WATCH_INTERVAL_SECONDS` (default 5). A reservation whose revised transaction appears on
  the ledger becomes a spend. Once its timebound has passed without that, it is released.
- **Onboarding** (`onboarding/apply.ts`):
  - The server loads `licence-registry.csv` only if `licence-registry.sig` (Ed25519 over
    the file's sha256) verifies against `AGENCY_PUBKEY`. Otherwise it refuses to start.
  - Each application is checked in turn: licence found; status `valid` and expiry more than
    `min_licence_days` away; licence class allows every requested category; licence not
    bound to another address; business-name token-set similarity ≥ 0.8.
  - When all checks pass, the server submits the merchant-signed `apply` and then `approve`
    with the verifier key, in the same request.
  - A name mismatch submits `apply` only and returns `pending_review`. Staff finish with
    `voucher enrol --approve`.
  - Every decision is logged with timestamps. The log feeds the median apply→active metric.

## AI (supporting only)

- **Interface.** One `AiProvider` interface with two implementations. `HeuristicProvider`
  is deterministic and used by every test. `LlmProvider` (Anthropic Messages API, model from
  `LLM_MODEL`) enforces a JSON schema, validates the output locally and retries once.
- **Dedup.**
  - Candidates come from blocking on (location, surname Soundex), the last 7 phone digits,
    and IDs within one edit.
  - The score weights Jaro–Winkler name similarity 0.45, E.164 phone equality 0.25, DOB
    (including a day/month swap) 0.15 and ID within one edit 0.15, renormalised over the
    fields present.
  - Pairs scoring ≥ 0.85 are `likely_same`; 0.55–0.85 are `review`.
  - The LLM only re-judges `review` pairs, from pseudonymised fields, and only when
    `llm_dedup_allowed` is true. It cannot remove a pair. Staff decide every pair.
- **Report.**
  - `figures.ts` computes the figures deterministically.
  - The provider drafts markdown from the figures only.
  - `guard.ts` discards any draft that contains a number not among the figures and falls
    back to `template.ts`.
  - A report stays `DRAFT` until `--approve "<name>"` stamps the name, the date and the
    sha256 of the figures.
- **When the model is wrong.**
  - A missed duplicate means one extra entitlement, within caps, recoverable by clawback
    after review.
  - A false duplicate delays one person until staff mark the pair `distinct`.
  - An invented number is blocked by the guard. Wrong narrative is caught at sign-off.

## Trust assumptions

- **The agency is the operator, and this is not neutral.** It holds the issuer keys, runs
  the approval server and the verifier key, and can refuse payments, suspend merchants,
  freeze trustlines and claw back vouchers. Recipients and merchants must be told this at
  enrolment (`docs/DATA-PROTECTION.md`).
- **The approval signer is deliberately weak.** A compromised approval server can approve
  any payment of vouchers that already exist, including to non-merchants, within the
  vouchers in circulation. It cannot mint, claw back or change signers.
- **The pool is the only SAC admin,** and it exposes only merchant-authorised burn-and-pay.
- **The float is only as good as the agency's funding.** Coverage and queued shortfall are
  public at all times.
- **The licence registry is only as good as the licensing authority's data** and the
  agency's signature over the export. Self-onboarding moves fraud risk to that data.

## Why a chain at all

A single-operator database with a merchant allowlist would enforce the restriction just as
well **if the agency also ran every wallet** (Assumption). The chain case rests on three
things. (1) The restriction belongs to the asset, so it holds for every wallet that can hold
a classic asset. (2) Merchants settle to USDC and can cash out through any anchor without a
bilateral bank contract with the agency. (3) Donors can check issuance, spending at
registered merchants, redemption, float coverage and expiry clawback on the public ledger.
None of these makes the programme neutral.

## Limits and known gaps

- **G-accounts only.** SDP embedded wallets that use contract accounts (C-addresses) are
  out of scope. `voucher disburse` rejects a non-G `walletAddress`.
- **History depends on Horizon and RPC.** RPC keeps about 7 days of events, and Horizon
  faces deprecation risk (`research/01-stellar-ecosystem.md` §14). The payment history
  behind the reservation watcher and any on-chain report therefore needs an indexer or a
  long-lived Horizon for real programmes.
- **The report does not read the chain.** `voucher report` reads an event log in the
  simulator's format. Building that log from RPC events and Horizon payments is not
  implemented.
- **Expiry needs a holdings file.** `voucher expire` takes a holdings JSON. The Horizon
  `accounts?asset=` lookup that produces it exists only inside `scripts/e2e-testnet.sh`.
- **Cache staleness.** A suspension reaches the approval server within 60 s. During that
  window the suspended merchant can still be paid; the pool still refuses its redemption.
- **Watcher gap.** Between a reservation's expiry and the next watcher poll (≤ 5 s), a
  landed but not-yet-seen payment does not count against the caps.
- **One server, one store.** One approval-server instance writes one JSON file. A second
  instance for availability would need a shared store. That is not built.
- **Testnet passphrase.** `stellarToml` writes the testnet passphrase into the generated
  `stellar.toml`. A mainnet programme needs that line changed.
- **SEP-8 statuses.** `pending` and `action_required` are not used.
- **No merchant app.** There is no POS app, no offline or feature-phone payment and no live
  anchor cash-out. MoneyGram/SEP-24 cash-out is the merchant's next step and is documented
  only.
- **Two models of the pool.** The simulator runs a TypeScript model of the pool
  (`sim/pool-model.ts`) with the same checks and FIFO rule. The contract itself is tested
  separately in the Soroban host, including a scenario that mirrors `pool-plan.json`.
