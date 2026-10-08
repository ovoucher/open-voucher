#!/usr/bin/env bash
# End-to-end Open Voucher journey on Stellar testnet, including expiry clawback and the
# three verify-first checks from ARCHITECTURE.md.
#
# NOT EXECUTED in the environment this project was built in: the sandbox could not reach
# soroban-testnet.stellar.org, horizon-testnet.stellar.org or friendbot. Every step below
# is covered offline (cargo test in the Soroban host, npm test, voucher simulate), but the
# testnet-specific behaviour is exactly what this script exists to confirm.
#
# It uses a SHORT programme (spending ends EXPIRY_MIN minutes from now, redemption closes
# DEADLINE_MIN minutes after that) so expiry and the redemption deadline can be reached
# without waiting weeks. The run takes about EXPIRY_MIN + DEADLINE_MIN minutes.
# The seed licences used below expire 2026-12-31 / 2027-01-31; after about 2026-12-01 the
# 30-day minimum makes self-onboarding of M25 fail with LICENCE_EXPIRED.
#
# Prerequisites: as scripts/deploy-testnet.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
NETWORK="${NETWORK:-testnet}"
EXPIRY_MIN="${EXPIRY_MIN:-10}"
DEADLINE_MIN="${DEADLINE_MIN:-5}"
export PORT="${PORT:-8080}"
mkdir -p "$APP/out"

step() { echo; echo "== $*"; }
v() { (cd "$APP" && node --env-file=.env dist/src/cli.js "$@"); }
expect_fail() { if "$@"; then echo "UNEXPECTED SUCCESS: $*"; exit 1; else echo "refused as expected"; fi; }
wait_until() { local t=$1; while (( $(date +%s) <= t )); do echo "  waiting $(( t - $(date +%s) )) s"; sleep 30; done; }

step "0. short testnet programme"
NOW=$(date +%s)
export PROGRAMME_CONFIG="$APP/out/testnet-programme.json"
node -e "
const p=require('$ROOT/data/seed/programme.json');
const iso=s=>new Date(s*1000).toISOString();
p.label='TESTNET e2e run (short programme)';p.simulated=false;
p.start=iso($NOW-120);p.expiry=iso($NOW+$EXPIRY_MIN*60);p.redeem_deadline=iso($NOW+($EXPIRY_MIN+$DEADLINE_MIN)*60);
require('fs').writeFileSync('$PROGRAMME_CONFIG',JSON.stringify(p,null,2));
console.log('start',p.start,'expiry',p.expiry,'redeem_deadline',p.redeem_deadline)"
EXPIRY=$(( NOW + EXPIRY_MIN * 60 ))
DEADLINE=$(( NOW + (EXPIRY_MIN + DEADLINE_MIN) * 60 ))

step "1. deploy (keys, issuer, USDC, registry, SACs, pools, set_admin)"
PROGRAMME_CONFIG="$PROGRAMME_CONFIG" "$ROOT/scripts/deploy-testnet.sh"
set -a; source "$APP/.env"; set +a
rm -f "$APP/out/approval-store.json"

step "2. recipients and merchants: accounts and trustlines"
for k in r1 r2 r3 r4 r5 m01 m02 m25 m30; do
  stellar keys generate --network "$NETWORK" --fund "$k" 2>/dev/null || echo "key $k exists"
  export "VOUCHER_SECRET_${k^^}=$(stellar keys secret "$k")"
done
addr() { stellar keys address "$1"; }
node "$ROOT/scripts/issuer-setup.ts" trust OVFOOD r1 r2 r3 r4 r5 m01 m02 m25
for m in m01 m02 m25; do stellar tx new change-trust --network "$NETWORK" --source-account "$m" --line "$USDC_ASSET" >/dev/null; done

step "3. merchants: 2 legacy enrolments, 1 self-onboarding, 1 refusal"
v enrol --legacy --merchant "$(addr m01)" --licence "sbp tcg 2026 0107" --authority TCG --categories food
v enrol --legacy --merchant "$(addr m02)" --licence "SBP-TCG-2026-0114" --authority TCG --categories food

step "4. disburse OVFOOD to 5 recipients (voucher disburse stands in for SDP)"
{
  echo "phone,walletAddress,id,amount,verification,paymentID"
  i=0
  for row in R0001 R0002 R0004 R0005 R0006; do
    i=$((i + 1))
    echo "+2547000000$i,$(addr r$i),$row,6.00,,OVFOOD-E2E-$row"
  done
} > "$APP/out/e2e-sdp.csv"
# verify-first (b): these classic issuer payments run AFTER the SAC admin moved to the pool
v disburse --sdp-csv out/e2e-sdp.csv --asset OVFOOD --decisions ../data/seed/dedup-decisions.csv

step "5. approval server (reads the recipients that disburse enrolled)"
(cd "$APP" && node --env-file=.env dist/src/cli.js serve > out/e2e-serve.log 2>&1) &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf "localhost:$PORT/health" && break; sleep 1; done
echo

step "3b. self-onboarding through /merchants/apply"
VOUCHER_SECRET_MERCHANT="$VOUCHER_SECRET_M25" v enrol --merchant "$(addr m25)" --licence "SBP-TCG-2026-0925" \
  --authority "tcg " --categories food --business-name "Neema Fresh Produce Ltd."
VOUCHER_SECRET_MERCHANT="$VOUCHER_SECRET_M30" expect_fail v enrol --merchant "$(addr m30)" --licence "SBP/TCG/2026/0999" \
  --authority TCG --categories food --business-name "Quick Cash Mini Shop"

step "6. payments through the approval server"
v pay --from r1 --merchant "$(addr m01)" --asset OVFOOD --amount 4.50
expect_fail v pay --from r1 --merchant "$(addr r2)" --asset OVFOOD --amount 0.50      # PEER_TO_PEER
expect_fail v pay --from r1 --merchant "$(addr m01)" --asset OVFOOD --amount 1.00     # DAILY_CAP (5.00)
v pay --from r2 --merchant "$(addr m25)" --asset OVFOOD --amount 3.00                  # self-onboarded merchant

step "7. verify-first (c): trustlines rest in maintain-liabilities; a plain payment fails"
node "$ROOT/scripts/issuer-setup.ts" flags "$(addr r1)" OVFOOD
node "$ROOT/scripts/issuer-setup.ts" flags "$(addr m01)" OVFOOD
expect_fail stellar tx new payment --network "$NETWORK" --source-account r3 --destination "$(addr m01)" \
  --asset "OVFOOD:$ISSUER_PUBLIC" --amount 10000000

step "8. redemption: paid, then queued on shortfall, then top-up and settle"
v fund --asset OVFOOD --amount 3.00
# verify-first (a): SAC clawback on a G-account trustline in maintain-liabilities state.
# If this fails with an authorisation error, switch redeem_pool to the documented fallback.
v redeem --merchant m01 --asset OVFOOD --amount 2.00          # expect: Paid
v redeem --merchant m01 --asset OVFOOD --amount 2.50          # expect: Queued #0 (float 1.00)
v fund --asset OVFOOD --amount 5.00
v settle --asset OVFOOD                                       # pays claim #0, prints coverage
v redeem --merchant m25 --asset OVFOOD --amount 1.00          # expect: Paid

step "9. expiry: classic Clawback of recipient balances only"
wait_until "$EXPIRY"
node -e "
const h='$HORIZON_URL', a='OVFOOD:$ISSUER_PUBLIC';
const recipients=['$(addr r1)','$(addr r2)','$(addr r3)','$(addr r4)','$(addr r5)'];
fetch(h+'/accounts?asset='+a+'&limit=200').then(r=>r.json()).then(j=>{
  const holdings=j._embedded.records.map(r=>{const b=r.balances.find(x=>x.asset_code==='OVFOOD'&&x.asset_issuer==='$ISSUER_PUBLIC');return {address:r.account_id,asset:'OVFOOD',balance:b?b.balance.replace(/0+$/,'').replace(/\.$/,'')||'0':'0'}});
  require('fs').writeFileSync('$APP/out/e2e-holdings.json',JSON.stringify({recipients,holdings},null,2));
  console.log(holdings.length+' holders');
});"
v expire --programme KE-PILOT-SIM --holdings out/e2e-holdings.json --dry-run
v expire --programme KE-PILOT-SIM --holdings out/e2e-holdings.json
node "$ROOT/scripts/issuer-setup.ts" flags "$(addr r1)" OVFOOD     # expect balance 0
node "$ROOT/scripts/issuer-setup.ts" flags "$(addr m25)" OVFOOD    # merchant balance untouched (2.00)

step "10. after the redemption deadline: redeem refused, surplus withdrawn"
wait_until "$DEADLINE"
expect_fail v redeem --merchant m25 --asset OVFOOD --amount 1.00   # RedemptionClosed
COVERAGE=$(stellar contract invoke --network "$NETWORK" --id "$POOL_OVFOOD_ID" --source-account ops -- coverage)
echo "coverage: $COVERAGE"
FLOAT=$(node -e "console.log(JSON.parse(process.argv[1]).float)" "$COVERAGE")
if [[ "$FLOAT" != "0" ]]; then
  stellar contract invoke --network "$NETWORK" --id "$POOL_OVFOOD_ID" --source-account ops -- \
    withdraw_surplus --to "$OPS_PUBLIC" --amount "$FLOAT"
fi
stellar contract invoke --network "$NETWORK" --id "$POOL_OVFOOD_ID" --source-account ops -- totals

step "11. report"
echo "voucher report reads an event log; building that log from RPC events and Horizon"
echo "payments is not implemented (ARCHITECTURE.md, Limits). The pool totals above and the"
echo "approval-server store (app/out/approval-store.json) are the testnet record of this run."
echo
echo "e2e finished. Record every tx hash above in VALIDATION.md before claiming 'testnet-ready' was exercised."
