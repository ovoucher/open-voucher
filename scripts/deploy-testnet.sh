#!/usr/bin/env bash
# Deploy Open Voucher to Stellar testnet: keys, classic issuer setup, test USDC,
# merchant_registry, one voucher SAC and one redeem_pool per asset, SAC admin -> pool.
#
# NOT EXECUTED in the environment this project was built in: the sandbox could not reach
# soroban-testnet.stellar.org, horizon-testnet.stellar.org or friendbot. The contract
# interfaces are the ones `cargo test` exercises; the issuer operations are the ones
# app/test/ops.test.ts checks. Expect to adjust flags if stellar-cli changes.
#
# Prerequisites: stellar-cli 28, Rust with wasm32v1-none, Node 22,
#                `cd app && npm install && npm run build`.
# Optional env:  PROGRAMME_CONFIG (default data/seed/programme.json; e2e-testnet.sh passes a
#                short programme), USDC_ASSET (CODE:ISSUER of an existing testnet USDC; default
#                is a self-issued test "USDC"), ENV_OUT (default app/.env).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK="${NETWORK:-testnet}"
WASM="$ROOT/target/wasm32v1-none/release"
PROGRAMME_CONFIG="${PROGRAMME_CONFIG:-$ROOT/data/seed/programme.json}"
ENV_OUT="${ENV_OUT:-$ROOT/app/.env}"
RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
HORIZON_URL="${HORIZON_URL:-https://horizon-testnet.stellar.org}"
PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"

inv() { stellar contract invoke --network "$NETWORK" "$@"; }
unix() { node -e "console.log(Math.floor(Date.parse(require('$PROGRAMME_CONFIG').$1)/1000))"; }

echo "== build contracts"
(cd "$ROOT" && stellar contract build)
ls -l "$WASM/merchant_registry.wasm" "$WASM/redeem_pool.wasm"

echo "== keys (generated and funded through friendbot)"
# agency-master = issuer master key (weight 20). ops = agency ops key (issuer signer, weight 10;
# also pool admin and float funder). approval = approval signer (issuer signer, weight 1).
# admin / verifier = merchant_registry roles. usdc-issuer = issuer of the test USDC.
for k in agency-master ops approval admin verifier usdc-issuer; do
  stellar keys generate --network "$NETWORK" --fund "$k" 2>/dev/null || echo "key $k exists"
done
ISSUER=$(stellar keys address agency-master)
OPS=$(stellar keys address ops)
APPROVAL=$(stellar keys address approval)
ADMIN=$(stellar keys address admin)
VERIFIER=$(stellar keys address verifier)

echo "== classic issuer: AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED, signers, thresholds"
ISSUER_SECRET=$(stellar keys secret agency-master) OPS_PUBLIC="$OPS" APPROVAL_SIGNER_PUBLIC="$APPROVAL" \
  HORIZON_URL="$HORIZON_URL" STELLAR_NETWORK_PASSPHRASE="$PASSPHRASE" PROGRAMME_CONFIG="$PROGRAMME_CONFIG" \
  STELLAR_TOML_OUT="$ROOT/app/out/stellar.toml" node "$ROOT/scripts/issuer-setup.ts" setup

echo "== USDC"
if [[ -n "${USDC_ASSET:-}" ]]; then
  USDC="$USDC_ASSET"
  echo "using $USDC; fund the ops account with it before 'voucher fund'"
  stellar tx new change-trust --network "$NETWORK" --source-account ops --line "$USDC" >/dev/null
else
  USDC="USDC:$(stellar keys address usdc-issuer)"
  echo "self-issued test asset $USDC (not Circle USDC)"
  stellar tx new change-trust --network "$NETWORK" --source-account ops --line "$USDC" >/dev/null
  stellar tx new payment --network "$NETWORK" --source-account usdc-issuer --destination "$OPS" \
    --asset "$USDC" --amount 1000000000000 >/dev/null   # 100,000.0000000
fi
USDC_SAC=$(stellar contract asset deploy --network "$NETWORK" --source-account ops --asset "$USDC" 2>/dev/null \
  || stellar contract id asset --network "$NETWORK" --asset "$USDC")
echo "USDC SAC: $USDC_SAC"

echo "== merchant_registry"
REGISTRY=$(stellar contract deploy --network "$NETWORK" --source-account admin --wasm "$WASM/merchant_registry.wasm" --alias ov_registry)
inv --id "$REGISTRY" --source-account admin -- init --admin "$ADMIN"
inv --id "$REGISTRY" --source-account admin -- set_verifier --verifier "$VERIFIER" --enabled true
echo "registry: $REGISTRY"

DEADLINE=$(unix redeem_deadline)
declare -A POOL
for pair in OVFOOD:1 OVAGRI:2; do
  CODE="${pair%%:*}"; CAT="${pair##*:}"
  echo "== $CODE: SAC, redeem_pool (category $CAT, deadline $DEADLINE), SAC admin -> pool"
  SAC=$(stellar contract asset deploy --network "$NETWORK" --source-account agency-master --asset "$CODE:$ISSUER" 2>/dev/null \
    || stellar contract id asset --network "$NETWORK" --asset "$CODE:$ISSUER")
  P=$(stellar contract deploy --network "$NETWORK" --source-account ops --wasm "$WASM/redeem_pool.wasm" --alias "ov_pool_${CODE,,}")
  inv --id "$P" --source-account ops -- init --admin "$OPS" --registry "$REGISTRY" --voucher "$SAC" \
    --usdc "$USDC_SAC" --category "$CAT" --redeem_deadline "$DEADLINE"
  # The SAC admin is the issuer until this call; the issuer's auth is checked against its
  # medium threshold (10), which the master key (weight 20) meets.
  inv --id "$SAC" --source-account agency-master -- set_admin --new_admin "$P"
  echo "  voucher SAC $SAC  pool $P  admin: $(inv --id "$SAC" --source-account ops -- admin)"
  POOL[$CODE]="$P"
done

echo "== write $ENV_OUT (secrets for testnet keys only)"
mkdir -p "$(dirname "$ENV_OUT")"
cat > "$ENV_OUT" <<EOF
STELLAR_RPC_URL=$RPC_URL
HORIZON_URL=$HORIZON_URL
STELLAR_NETWORK_PASSPHRASE=$PASSPHRASE
REGISTRY_CONTRACT_ID=$REGISTRY
POOL_OVFOOD_ID=${POOL[OVFOOD]}
POOL_OVAGRI_ID=${POOL[OVAGRI]}
USDC_ASSET=$USDC
USDC_SAC=$USDC_SAC
ISSUER_PUBLIC=$ISSUER
OPS_PUBLIC=$OPS
OPS_SECRET=$(stellar keys secret ops)
APPROVAL_SIGNER_PUBLIC=$APPROVAL
APPROVAL_SIGNER_SECRET=$(stellar keys secret approval)
ADMIN_SECRET=$(stellar keys secret admin)
VERIFIER_SECRET=$(stellar keys secret verifier)
AGENCY_PUBKEY=$(node -e "console.log(require('$ROOT/data/seed/test-agency-key.json').public_key)")
PROGRAMME_CONFIG=$PROGRAMME_CONFIG
APPROVAL_SERVER_URL=http://localhost:${PORT:-8080}
PORT=${PORT:-8080}
STORE_PATH=out/approval-store.json
EOF
echo "done. Next: scripts/e2e-testnet.sh, or 'cd app && node --env-file=.env dist/src/cli.js serve'"
