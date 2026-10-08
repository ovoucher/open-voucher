// Deterministic keys for the offline simulation and tests ONLY.
//
// Every key here is derived from a public label, so anyone can recompute its secret.
// They exist so the seed data, simulator and tests are reproducible without a network.
// Never fund them on a real network and never use them outside the simulation.
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { sha256 } from './hash.js';

export function simKeypair(label: string): Keypair {
  return Keypair.fromRawEd25519Seed(sha256(`open-voucher/SIMULATION-ONLY/${label}`));
}

export function simAddress(label: string): string {
  return simKeypair(label).publicKey();
}

/** A syntactically valid contract id (C…) derived from a label, for offline builds. */
export function simContractId(label: string): string {
  return StrKey.encodeContract(sha256(`open-voucher/SIMULATION-ONLY/contract/${label}`));
}

export const SIM = {
  issuer: () => simKeypair('issuer'),
  opsKey: () => simKeypair('agency-ops-key'),
  approvalSigner: () => simKeypair('approval-signer'),
  verifier: () => simKeypair('onboarding-verifier'),
  agency: () => simKeypair('test-agency-registry-signing-key'),
  registryId: () => simContractId('merchant_registry'),
  foodPoolId: () => simContractId('redeem_pool/OVFOOD'),
  agriPoolId: () => simContractId('redeem_pool/OVAGRI'),
};
