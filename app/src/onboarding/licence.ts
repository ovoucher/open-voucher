// Licence normalisation and hashing. The same vectors are asserted in
// contracts/merchant_registry/src/test.rs (licence_hash_vectors_match_typescript).
import { sha256Hex } from '../hash.js';

/**
 * Uppercase and keep only A-Z and 0-9. Registries write the same licence as
 * "BP/2026/00123", "bp 2026 00123" or "BP-2026-00123"; all normalise to "BP202600123".
 */
export function normaliseLicenceNo(no: string): string {
  return no.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normaliseAuthority(a: string): string {
  return a.trim().toUpperCase();
}

/** The string that is hashed: `upper(authority) ":" normalised_licence_no`. */
export function licenceKey(authority: string, no: string): string {
  return `${normaliseAuthority(authority)}:${normaliseLicenceNo(no)}`;
}

/** Hex sha256 of the licence key; the `licence_hash` stored on chain. */
export function licenceHash(authority: string, no: string): string {
  return sha256Hex(licenceKey(authority, no));
}
