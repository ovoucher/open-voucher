# SEP-8 approval rules

The approval server (`voucher serve`, `app/src/sep8/`) is the only way a voucher moves
between two holders. Recipient and merchant trustlines rest in the
`AUTHORIZED_TO_MAINTAIN_LIABILITIES` state, so the network refuses a plain payment. A
payment goes through only when the issuer authorises both trustlines inside the same
transaction, and only the approval server co-signs that authorisation.

This file documents the rules for the simulated programme `KE-PILOT-SIM`. They are
defined in `data/seed/rules.json` and evaluated by `app/src/sep8/rules.ts`.

## Rules hash

```
sha256(data/seed/rules.json) = ac5d7de0cbe79e51261c18b2cde872631e12586010fa55f49f8deab26bdd6540
```

The hash covers the exact bytes of `rules.json`. It appears in three places:

- `MEMO_HASH` of every revised (approved) transaction, so each payment on the ledger shows
  which rule version approved it;
- `approval_criteria` in `stellar.toml` (see `STELLAR-TOML.md`);
- `GET /rules` and `GET /health` on the approval server.

Changing a cap or the licence-class map changes the hash. An auditor can then split the
payments on the ledger by rule version.

## Rules in plain language

This is the `summary` field of `rules.json`, and it is also published in `stellar.toml`:

> Vouchers can only be paid, in a single payment, by an enrolled recipient to a merchant that
> is active in the agency merchant registry for the voucher category (OVFOOD: food, OVAGRI:
> farm inputs), between the programme start and expiry. Transfers between recipients are
> refused. Per recipient, OVFOOD spending is capped at 5.00 per programme-local day and 10.00
> per rolling 7 days; OVAGRI at 25.00 per day and 40.00 per 7 days. Approved payments are
> wrapped by the approval server in an authorise, pay, de-authorise transaction whose memo is
> the hash of these rules.

| Asset | Category bit | Daily cap (programme-local day, UTC+03:00) | Rolling 7-day cap |
|---|---|---|---|
| `OVFOOD` | `food = 1` | 5.00 | 10.00 |
| `OVAGRI` | `agri = 2` | 25.00 | 40.00 |

The caps are Simulated values chosen for the seed; they are not taken from a real
programme. The researched range for food transfers is $3–13 per month (`10-R3`).

## Reason codes

`evaluate(summary, state, now)` is a pure function: it does no I/O, reads no clock and uses
no randomness. The first failing check sets the reason code, so every refusal has exactly
one code. The checks run in this order:

| # | Code | Refused when |
|---|---|---|
| 1 | `NOT_SINGLE_PAYMENT` | the transaction has anything other than exactly one `Payment` op (path payments, several ops, other op types) |
| 2 | `WRONG_ASSET` | the asset is not one of this programme's voucher assets from this issuer |
| 3 | `PROGRAMME_NOT_ACTIVE` | `now` is before the programme start or after its expiry |
| 4 | `SOURCE_NOT_BENEFICIARY` | the payer is not an enrolled recipient **of this asset** |
| 5 | `BENEFICIARY_SUSPENDED` | the recipient is suspended pending staff review |
| 6 | `PEER_TO_PEER` | the destination is an enrolled recipient |
| 7 | `MERCHANT_NOT_REGISTERED` | the destination has no `merchant_registry` record |
| 8 | `MERCHANT_NOT_ACTIVE` | the record is `Pending`, `Suspended` or `Revoked`, or its licence has expired |
| 9 | `CATEGORY_MISMATCH` | the asset's category bit is not in the merchant's categories |
| 10 | `AMOUNT_INVALID` | amount ≤ 0 |
| 11 | `DAILY_CAP` | approved spends plus live reservations today, plus this amount, exceed the daily cap |
| 12 | `WEEKLY_CAP` | the same over the previous 168 h exceeds the weekly cap |

Each code has at least one test in `app/test/rules.test.ts`. The boundaries (exactly at the
cap, one stroop over, local midnight, 168 h ± 1 s) are tested in `app/test/velocity.test.ts`.

## Caps and reservations

- **Spend.** A spend is a revised transaction that the ledger watcher
  (`sep8/ledger-watch.ts`) has seen on the ledger.
- **Reservation.** A reservation is a revised transaction that has not been seen yet and
  whose timebound has not passed. It counts against both caps, so a recipient cannot collect
  several approvals and submit them all at once.
- **Expiry.** A reservation not seen by its `maxTime` is released.
- **Idempotency.** Sending the same original transaction twice returns the cached response
  and does not count twice.
- **Day boundary.** The daily cap uses the programme-local calendar day, from
  `timezone_offset` in `programme.json`. The weekly cap is a rolling 168 h window.

## The revised transaction

An allowed payment comes back as `{status: "revised", tx, message}`, where `tx` holds these
five operations in this order:

1. `SetTrustLineFlags` (source: issuer), trustor = recipient, set `AUTHORIZED`
2. `SetTrustLineFlags` (source: issuer), trustor = merchant, set `AUTHORIZED`
3. the original `Payment` (source: recipient)
4. `SetTrustLineFlags` (source: issuer), trustor = merchant, clear `AUTHORIZED`, set `AUTHORIZED_TO_MAINTAIN_LIABILITIES`
5. the same for the recipient

The other fields of the revised transaction:

- **Source and sequence:** copied from the original.
- **Fee:** the per-op fee is the original total fee (at least `BASE_FEE`), so the new
  total covers five ops. An agency fee-bump is compatible.
- **Timebounds:** `[now, now + min(timebound_seconds, 300)]`.
- **Memo:** `MEMO_HASH = sha256(rules.json)`.
- **Signatures:** the approval signer signs. The client adds the recipient's signature and
  submits.

The approval signer has weight 1 on the issuer, and the issuer thresholds are low 1 / med 10
/ high 20. `SetTrustLineFlags` is a low-threshold op, so the approval signer's signature is
enough for ops 1, 2, 4 and 5. It is not enough for an issuer `Payment` (minting) or a
`Clawback`, which are medium-threshold ops. A compromised approval server can therefore
approve payments of vouchers that already exist, but it cannot create or seize vouchers.
`app/src/issuer/ops.ts` encodes the threshold table from the Stellar "List of operations"
page, and `app/test/ops.test.ts` asserts the classification. `app/test/sandwich.test.ts`
asserts that the sandwich never contains an issuer payment.

## Refusal

A refusal returns HTTP 400 with `{status: "rejected", error: "<CODE>: <message>", code}`.
The MVP does not use SEP-8's `pending` and `action_required` statuses. Every refusal is
written to the store's refusal log, and the donor report counts refusals by code.

## Registry reads

Merchant status comes from `merchant_registry.get`, read by RPC simulation, behind a
60-second cache (`registry_cache_seconds`). A suspension therefore reaches the approval
server within 60 s. During that window a suspended merchant can still receive payments, but
the redemption pool calls `is_active` live and refuses it.

## Test run against the demo server

These responses were observed on 2026-09-27, with `voucher serve --demo` on simulation keys
and all payments from recipient R0001 (food):

| Payment | Result |
|---|---|
| 4.50 OVFOOD to M01 (food shop) | `revised` |
| 1.00 OVFOOD to M01, same day | `DAILY_CAP: daily cap 5.00 OVFOOD: 4.50 already used today, 1.00 requested` |
| 0.50 OVFOOD to recipient R0002 | `PEER_TO_PEER` |
| 0.50 OVFOOD to M17 (agro-dealer) | `CATEGORY_MISMATCH` |
| 0.50 OVAGRI to M17 | `SOURCE_NOT_BENEFICIARY` (R0001 is enrolled for OVFOOD only) |
