# SDP integration

The Stellar Disbursement Platform (SDP) is the disbursement engine that Open Voucher is
designed to work with. SDP pays unrestricted assets. Paying a regulated voucher asset needs
one change to SDP, described below. Until that change exists, `voucher disburse` stands in
for SDP and reads the same CSV.

## What was checked, and against what

- The SDP backend `develop` branch (commit of 2026-09-23, after release 7.0.0) defines the
  disbursement-instruction CSV in `internal/data/disbursement_instructions.go`:

  ```go
  Phone             string `csv:"phone"`
  Email             string `csv:"email"`
  ID                string `csv:"id"`
  Amount            string `csv:"amount"`
  VerificationValue string `csv:"verification"`
  ExternalPaymentID string `csv:"paymentID"`
  WalletAddress     string `csv:"walletAddress"`
  WalletAddressMemo string `csv:"walletAddressMemo"`
  ```

- SDP's own samples use headers such as `phone,id,amount,verification` and
  `phone,id,amount,walletAddress` (`dev/sample/sample-disbursement.csv` and
  `internal/integrationtests/resources/*.csv`).
- `data/seed/sdp-disbursement.csv` uses `phone,walletAddress,id,amount,verification,paymentID`.
  Every header is an SDP column name.
- **Not checked:** whether SDP accepts the seed's messy phone formats. SDP's samples use
  E.164 (`+1…`), and the seed deliberately contains `07…`, `2547…` and spaced formats. An
  export for SDP would normalise phones first (the dedup module already normalises to E.164
  internally). No upload to an SDP instance was made.
- The 7.0.0 changelog adds multiple distribution accounts, audit tables and wallet rotation.
  Neither it nor the unreleased section mentions regulated assets, SEP-8, clawback or
  vouchers. This agrees with the finding in `research/12-round2-demoted-recheck.md` §3(a).

## What `voucher disburse` does today

```
voucher disburse --sdp-csv data/seed/sdp-disbursement.csv --asset OVFOOD \
                 --decisions data/seed/dedup-decisions.csv [--dry-run]
```

1. It runs the duplicate heuristic over `beneficiaries.csv` and refuses to continue while any
   `likely_same` pair has no staff decision in `dedup-decisions.csv`.
2. For each pair decided `same`, it skips the later row.
3. It filters the rows to the asset's category.
4. It builds one transaction per recipient from the issuer, signed by the agency ops key
   (weight 10, medium threshold): `SetTrustLineFlags(AUTHORIZED)` →
   `Payment(issuer → recipient)` → `SetTrustLineFlags(MAINTAIN_LIABILITIES)`. The memo is the
   SDP `paymentID`.

On the seed this gives 391 OVFOOD recipients (4,085.00, with 9 duplicates skipped) and 97
OVAGRI recipients (3,880.00, with 3 duplicates skipped).

## The upstream change SDP would need

The text below is a draft upstream issue. It has **not** been filed. Filing it is a week-2
step in `VALIDATION.md`.

> **Title:** Support SEP-8 regulated assets as a disbursement asset
>
> **Problem.** Agencies running restricted (voucher) programmes want to disburse a regulated
> asset: one with `AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED` whose holders'
> trustlines rest in `AUTHORIZED_TO_MAINTAIN_LIABILITIES`. A plain `Payment` from the
> distribution account to such a holder fails, because the receiving trustline is not fully
> authorised.
>
> **Proposal.** An optional per-asset *submission hook* in the TSS (transaction submission
> service). Before signing a payment, the TSS calls a configured URL with the unsigned
> transaction and receives a revised transaction, in the same shape as a SEP-8 `revised`
> response, which it signs and submits. For issuer-distributed assets the revised
> transaction is `SetTrustLineFlags(AUTHORIZED)` → `Payment` →
> `SetTrustLineFlags(MAINTAIN_LIABILITIES)`.
>
> Minimum viable alternative: when the distribution account is the asset issuer, let SDP wrap
> the payment in those two `SetTrustLineFlags` ops itself, controlled by an asset-level flag.
>
> **Also needed.**
> (1) Receiver registration must create the trustline, or wallets must: the recipient signs a
> `ChangeTrust` for the voucher asset.
> (2) The distribution account's signer must be allowed to sign `SetTrustLineFlags` on the
> issuer. Either the distribution account *is* the issuer or it holds an issuer signer at
> medium weight.
> (3) Expiry clawback stays outside SDP.
>
> **Out of scope.** Recipient-to-merchant payments go through the asset's own SEP-8 approval
> server, not SDP.

## Open questions for SDP maintainers

- Do SDP embedded wallets use contract accounts (C-addresses)? If they do, they cannot hold
  classic trustlines, and this design does not cover them (see `ARCHITECTURE.md`, Limits).
- Would maintainers accept a pre-submit hook in the TSS, or do they prefer a separate
  "regulated asset" disbursement type?
- Can a tenant's distribution account be the asset issuer without weakening the
  tenant-isolation model introduced in 7.0.0?
