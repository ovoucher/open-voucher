// Agency-signed licence registry. The server loads licence-registry.csv only if
// licence-registry.sig (ed25519 over sha256 of the exact file bytes) verifies against
// AGENCY_PUBKEY; otherwise it refuses to start.
import { readFileSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import { parseCsv } from '../csv.js';
import { sha256 } from '../hash.js';
import { licenceKey } from './licence.js';

export interface LicenceRecord {
  licenceNo: string;
  authority: string;
  businessName: string;
  licenceClass: string;
  status: string;
  /** YYYY-MM-DD, last valid day */
  expires: string;
  county: string;
}

export class LicenceRegistryError extends Error {}

export function signRegistry(csvBytes: Uint8Array, agency: Keypair): string {
  return Buffer.from(agency.sign(sha256(csvBytes))).toString('base64');
}

export function verifyRegistry(csvBytes: Uint8Array, sigB64: string, agencyPubkey: string): boolean {
  try {
    const kp = Keypair.fromPublicKey(agencyPubkey);
    const sig = Buffer.from(sigB64.trim(), 'base64');
    if (sig.length !== 64) return false;
    return kp.verify(sha256(csvBytes), sig);
  } catch {
    return false;
  }
}

export class LicenceRegistry {
  private byKey = new Map<string, LicenceRecord>();
  readonly records: LicenceRecord[];

  private constructor(records: LicenceRecord[]) {
    this.records = records;
    for (const r of records) this.byKey.set(licenceKey(r.authority, r.licenceNo), r);
  }

  /** Verifies then parses. Throws LicenceRegistryError on a bad or missing signature. */
  static fromBytes(csvBytes: Uint8Array, sigB64: string, agencyPubkey: string): LicenceRegistry {
    if (!agencyPubkey) throw new LicenceRegistryError('AGENCY_PUBKEY is not set; refusing to load the licence registry');
    if (!verifyRegistry(csvBytes, sigB64, agencyPubkey)) {
      throw new LicenceRegistryError('licence registry signature does not verify against AGENCY_PUBKEY; refusing to start');
    }
    const { rows } = parseCsv(Buffer.from(csvBytes).toString('utf8'));
    return new LicenceRegistry(
      rows.map((r) => ({
        licenceNo: r.licence_no.trim(),
        authority: r.issuing_authority.trim(),
        businessName: r.business_name.trim(),
        licenceClass: r.licence_class.trim().toUpperCase(),
        status: r.status.trim().toLowerCase(),
        expires: r.expires.trim(),
        county: (r.county ?? '').trim(),
      })),
    );
  }

  static load(csvPath: string, sigPath: string, agencyPubkey: string): LicenceRegistry {
    let csv: Buffer;
    let sig: string;
    try {
      csv = readFileSync(csvPath);
      sig = readFileSync(sigPath, 'utf8');
    } catch (e) {
      throw new LicenceRegistryError(`cannot read licence registry: ${(e as Error).message}`);
    }
    return LicenceRegistry.fromBytes(csv, sig, agencyPubkey);
  }

  lookup(authority: string, licenceNo: string): LicenceRecord | undefined {
    return this.byKey.get(licenceKey(authority, licenceNo));
  }
}
