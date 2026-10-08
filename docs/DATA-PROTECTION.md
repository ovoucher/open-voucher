# Data protection

Open Voucher serves vulnerable people: refugees and smallholder farmers. The design keeps
personal data off-chain. It does not make spending private, and this file says so plainly
so that agencies can tell recipients and merchants.

## What goes on-chain

| Data | Where | Linkable to a person? |
|---|---|---|
| Recipient G-address, voucher balance, every payment (amount, merchant, time) | classic ledger, public | Pseudonymous. Anyone who learns which address is whose (the agency, a merchant who sees the phone at the till, a wallet provider) can read that person's full spending history for the programme. |
| Merchant G-address, `licence_hash`, categories, status, reason codes, timestamps | `merchant_registry`, public | Merchants are businesses, but a sole trader's licence identifies a person. The licence *number* is hashed; the hash of a short licence number with a known format can be brute-forced, so treat the hash as linkable. |
| Redemptions, shortfalls, float, clawbacks | `redeem_pool` events and SAC events, public | Per merchant address. |
| `MEMO_HASH` = rules hash, disbursement memo = SDP `paymentID` | classic ledger, public | The `paymentID` (e.g. `OVFOOD-2026-09-0001`) is an agency reference. Do not put names or phone numbers into it. |

## What stays off-chain

- **Recipient list.** Names, dates of birth, phone numbers, national IDs, household sizes
  and locations (`beneficiaries.csv`) stay in the agency's systems (Kobo/CommCare, SDP).
- **Licence registry export.** Business names and licence numbers.
- **Approval-server store.** Recipient enrolment, spends, reservations, refusals and the
  onboarding log (`STORE_PATH`). This file links addresses to recipient rows and must be
  protected like the recipient list.
- **Staff decisions.** Dedup decisions and report sign-offs.

## AI and personal data

- **Off by default.** The LLM provider is off unless `LLM_API_KEY` is set.
- **Dedup.** For dedup, the LLM path is additionally off unless `programme.json` has
  `"llm_dedup_allowed": true`. That flag is meant to record a data-protection sign-off by the
  agency. It is `false` in the seed.
- **What the model sees.** When dedup is enabled, the model sees only pseudonymised fields
  of `review`-band pairs (name tokens, birth year, location code, last 4 phone digits). It
  never sees full phone numbers, full dates of birth or national IDs. It may move a pair
  between bands. It cannot drop a pair from the staff file, and staff decide every pair.
- **Reports.** Report drafting sends only the aggregate figures JSON, never recipient rows.
  The numbers guard discards any draft containing a number that is not a computed figure.

## Recommendations to an agency (Assumptions, not tested)

- **Fresh addresses.** Use a fresh recipient address per programme, so spending histories
  do not accumulate across programmes.
- **Consent.** Tell recipients and merchants, at enrolment and in their language, that
  payments are public and pseudonymous, that the agency can freeze and claw back vouchers,
  and how to report a problem.
- **Memos.** Do not reuse phone numbers or national IDs as SDP `id` or `paymentID` values
  that end up in memos.
- **Access.** Restrict access to the approval-server store and the dedup candidate file to
  named staff, and delete them on the agency's retention schedule after the programme closes.
- **Impact assessment.** Run the agency's own data-protection impact assessment before any
  pilot. This repository does not replace one.

## What is not protected

- An observer who knows one recipient's address sees that recipient's purchases and the
  merchants they use.
- Merchant sales volumes are public through their receipts and redemptions.
- Clawback at expiry reveals each recipient's unspent balance.

These are consequences of using a public ledger. A private database with a merchant
allowlist would avoid them. `ARCHITECTURE.md` ("Why a chain at all") explains why the
design accepts them, and the problem statement in `README.md` sets out the trade-off.
