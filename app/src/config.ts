// Programme and rules configuration (data/seed/programme.json, data/seed/rules.json).
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAmount } from './amount.js';
import { sha256Hex } from './hash.js';

export type CategoryName = 'food' | 'agri';

export interface ProgrammeFile {
  programme_id: string;
  label: string;
  simulated: boolean;
  timezone_offset: string; // "+03:00"
  start: string; // ISO, day 0 00:00 local
  expiry: string; // ISO, end of the last spending day
  redeem_deadline: string; // ISO
  home_domain: string;
  approval_server: string;
  kes_per_usd: number;
  assets: Record<string, { category: CategoryName; entitlement: { per_household_member?: string; max?: string; fixed?: string } }>;
  issuer: {
    thresholds: { low: number; med: number; high: number };
    master_weight: number;
    ops_key_weight: number;
    approval_signer_weight: number;
  };
  llm_dedup_allowed: boolean;
  min_licence_days?: number;
}

export interface RulesFile {
  version: number;
  programme_id: string;
  category_bits: Record<string, number>;
  assets: Record<string, { category: CategoryName; daily_cap: string; weekly_cap: string }>;
  licence_classes: Record<string, CategoryName[]>;
  min_licence_days: number;
  name_match_threshold: number;
  timebound_seconds: number;
  registry_cache_seconds: number;
  summary: string;
}

export interface AssetRule {
  code: string;
  category: CategoryName;
  categoryBit: number;
  dailyCap: bigint;
  weeklyCap: bigint;
}

export interface Programme {
  id: string;
  file: ProgrammeFile;
  tzOffsetSeconds: number;
  start: number; // unix seconds
  expiry: number;
  redeemDeadline: number;
}

export interface Rules {
  file: RulesFile;
  /** sha256 of the exact rules.json bytes; goes into every revised tx as MEMO_HASH. */
  hash: string;
  assets: Map<string, AssetRule>;
}

const here = dirname(fileURLToPath(import.meta.url));
/** Project root (…/open-voucher), valid from both src/ and dist/src/. */
export const PROJECT_ROOT = resolve(here, basename(dirname(here)) === 'dist' ? '../../..' : '../..');
export const SEED_DIR = resolve(PROJECT_ROOT, 'data/seed');

export function seedPath(name: string): string {
  return resolve(SEED_DIR, name);
}

export function parseTzOffset(s: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`invalid timezone offset "${s}"`);
  const secs = Number(m[2]) * 3600 + Number(m[3]) * 60;
  return m[1] === '-' ? -secs : secs;
}

export function isoToUnix(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid date "${iso}"`);
  return Math.floor(t / 1000);
}

export function programmeFrom(file: ProgrammeFile): Programme {
  return {
    id: file.programme_id,
    file,
    tzOffsetSeconds: parseTzOffset(file.timezone_offset),
    start: isoToUnix(file.start),
    expiry: isoToUnix(file.expiry),
    redeemDeadline: isoToUnix(file.redeem_deadline),
  };
}

export function rulesFrom(text: string): Rules {
  const file = JSON.parse(text) as RulesFile;
  const assets = new Map<string, AssetRule>();
  for (const [code, a] of Object.entries(file.assets)) {
    const bit = file.category_bits[a.category];
    if (!bit) throw new Error(`rules.json: unknown category "${a.category}" for ${code}`);
    assets.set(code, {
      code,
      category: a.category,
      categoryBit: bit,
      dailyCap: parseAmount(a.daily_cap),
      weeklyCap: parseAmount(a.weekly_cap),
    });
  }
  return { file, hash: sha256Hex(text), assets };
}

export function loadProgramme(path = seedPath('programme.json')): Programme {
  return programmeFrom(JSON.parse(readFileSync(path, 'utf8')) as ProgrammeFile);
}

export function loadRules(path = seedPath('rules.json')): Rules {
  return rulesFrom(readFileSync(path, 'utf8'));
}

/** Food entitlement: min(max, per_member × household size); agri: fixed. */
export function entitlement(p: Programme, asset: string, householdSize: number): bigint {
  const e = p.file.assets[asset]?.entitlement;
  if (!e) throw new Error(`no entitlement rule for ${asset}`);
  if (e.fixed) return parseAmount(e.fixed);
  const per = parseAmount(e.per_household_member ?? '0');
  const cap = parseAmount(e.max ?? '0');
  const v = per * BigInt(Math.max(1, householdSize));
  return v < cap ? v : cap;
}

/** Programme-local calendar day number (days since 1970-01-01 in local time). */
export function localDay(unix: number, tzOffsetSeconds: number): number {
  return Math.floor((unix + tzOffsetSeconds) / 86_400);
}

/** Programme day index (day 0 = start). */
export function programmeDay(p: Programme, unix: number): number {
  return localDay(unix, p.tzOffsetSeconds) - localDay(p.start, p.tzOffsetSeconds);
}

/** Unix time of local midnight starting programme day `d`. */
export function dayStart(p: Programme, d: number): number {
  return p.start + d * 86_400;
}
