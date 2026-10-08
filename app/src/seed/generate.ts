// Deterministic seed generator for the simulated programme KE-PILOT-SIM.
//
// Everything written to data/seed/ is SIMULATED: people, phone numbers, IDs, licences,
// merchants and payments are invented. `generateSeed()` is pure (fixed PRNG seed); the
// CLI entry point writes the files, and a test re-runs it to prove the committed files
// are exactly what the generator produces.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAmount, toStellarAmount, kesToUsd, formatAmount } from '../amount.js';
import {
  type ProgrammeFile,
  type RulesFile,
  programmeFrom,
  rulesFrom,
  entitlement,
  SEED_DIR,
  type Programme,
  type Rules,
} from '../config.js';
import { toCsv } from '../csv.js';
import { Rng } from '../rng.js';
import { SIM, simAddress } from '../keys.js';
import { signRegistry } from '../onboarding/licence-registry.js';
import { licenceExpiryUnix } from '../onboarding/apply.js';
import { evaluate } from '../sep8/rules.js';
import type { MerchantView, ReasonCode, SpendEntry } from '../sep8/types.js';

export const SEED = 20260901;
const DAY = 86_400;

// ------------------------------------------------------------------ static config

export const PROGRAMME: ProgrammeFile = {
  programme_id: 'KE-PILOT-SIM',
  label: 'Simulated pilot: food vouchers (Kakuma/Kalobeyei-style camp) and farm-input vouchers (western Kenya-style county). SIMULATED DATA.',
  simulated: true,
  timezone_offset: '+03:00',
  start: '2026-09-01T00:00:00+03:00',
  expiry: '2026-09-29T23:59:59+03:00',
  redeem_deadline: '2026-10-13T23:59:59+03:00',
  home_domain: 'voucher.example.org',
  approval_server: 'https://voucher.example.org/tx-approve',
  kes_per_usd: 129.3,
  assets: {
    OVFOOD: { category: 'food', entitlement: { per_household_member: '3.00', max: '13.00' } },
    OVAGRI: { category: 'agri', entitlement: { fixed: '40.00' } },
  },
  issuer: { thresholds: { low: 1, med: 10, high: 20 }, master_weight: 20, ops_key_weight: 10, approval_signer_weight: 1 },
  llm_dedup_allowed: false,
  min_licence_days: 30,
};

export const RULES: RulesFile = {
  version: 1,
  programme_id: 'KE-PILOT-SIM',
  category_bits: { food: 1, agri: 2 },
  assets: {
    OVFOOD: { category: 'food', daily_cap: '5.00', weekly_cap: '10.00' },
    OVAGRI: { category: 'agri', daily_cap: '25.00', weekly_cap: '40.00' },
  },
  licence_classes: {
    RETAIL_FOOD: ['food'],
    GENERAL_TRADER: ['food', 'agri'],
    AGRO_DEALER: ['agri'],
    PHARMACY: [],
    EATING_HOUSE: [],
  },
  min_licence_days: 30,
  name_match_threshold: 0.8,
  timebound_seconds: 300,
  registry_cache_seconds: 60,
  summary:
    'Vouchers can only be paid, in a single payment, by an enrolled recipient to a merchant that is active in the agency merchant registry for the voucher category (OVFOOD: food, OVAGRI: farm inputs), between the programme start and expiry. Transfers between recipients are refused. Per recipient, OVFOOD spending is capped at 5.00 per programme-local day and 10.00 per rolling 7 days; OVAGRI at 25.00 per day and 40.00 per 7 days. Approved payments are wrapped by the approval server in an authorise, pay, de-authorise transaction whose memo is the hash of these rules.',
};

// ------------------------------------------------------------------ names

const FOOD_FIRST_F = ['Amina', 'Halima', 'Fatuma', 'Khadija', 'Hodan', 'Sahra', 'Faadumo', 'Asha', 'Maryan', 'Ubah', 'Deqa', 'Nasra', 'Ayan', 'Nyakuoth', 'Nyabol', 'Achol', 'Adut', 'Awut', 'Nyandeng', 'Aluel', 'Mary', 'Grace', 'Espérance', 'Solange', 'Furaha', 'Neema', 'Aline', 'Divine', 'Claudine', 'Mercy', 'Hawa', 'Idil', 'Sagal', 'Rahma'];
const FOOD_FIRST_M = ['Abdi', 'Hassan', 'Ali', 'Omar', 'Yusuf', 'Ibrahim', 'Abdullahi', 'Abdirahman', 'Ahmed', 'Hussein', 'Mohamed', 'Farah', 'Garang', 'Deng', 'Majok', 'Mabior', 'Kuol', 'Chol', 'Lual', 'Machar', 'Jean', 'Pierre', 'Emmanuel', 'Innocent', 'Bahati', 'Amani', 'Patrick', 'Joseph', 'Tesfaye', 'Dawit', 'Bashir', 'Salah'];
const FOOD_MIDDLE = ['Abdi', 'Hassan', 'Ali', 'Omar', 'Mohamed', 'Yusuf', 'Ibrahim', 'Jama', 'Aden', 'Osman', 'Nur', 'Dahir', 'Deng', 'Garang', 'Kuol', 'Majok', 'Bol', 'Akol'];
const FOOD_SURNAME = ['Hassan', 'Warsame', 'Farah', 'Jama', 'Hirsi', 'Aden', 'Osman', 'Dahir', 'Nur', 'Mohamud', 'Guled', 'Egal', 'Deng', 'Garang', 'Majok', 'Akol', 'Bol', 'Kuol', 'Ajak', 'Malual', 'Mayen', 'Nhial', 'Makuei', 'Mukendi', 'Ilunga', 'Kalonji', 'Mbuyi', 'Nshimirimana', 'Niyonzima', 'Hakizimana', 'Bizimana', 'Habimana', 'Uwimana', 'Gebre', 'Alemu', 'Tadesse', 'Bekele', 'Isse', 'Samatar', 'Barre'];
const AGRI_FIRST = ['Moses', 'Geoffrey', 'Peter', 'John', 'Christine', 'Mary', 'Everlyne', 'Beatrice', 'Rose', 'Caroline', 'Nekesa', 'Nafula', 'Naliaka', 'Nasimiyu', 'Juma', 'Fredrick', 'Dorcas', 'Janet', 'Wycliffe', 'Benard', 'Lilian', 'Violet', 'Metrine', 'Sylvester'];
const AGRI_SURNAME = ['Wafula', 'Wanjala', 'Barasa', 'Simiyu', 'Wekesa', 'Makokha', 'Khisa', 'Masinde', 'Wamalwa', 'Mukhwana', 'Shikuku', 'Were', 'Wangila', 'Kituyi', 'Opicho', 'Lusweti', 'Namisi', 'Sifuna', 'Mutali', 'Nyongesa'];
const FOOD_LOCATIONS = ['KKM-K1', 'KKM-K2', 'KKM-K3', 'KKM-K4', 'KLB-V2', 'KLB-V3'];
const AGRI_LOCATIONS = ['BGM-KBC', 'KKG-LUR', 'KKG-MUM'];

const FOOD_KES = [55, 60, 75, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200, 220, 240, 260, 300, 340];
const AGRI_KES = [650, 700, 850, 950, 1200, 1450, 1800, 2100, 2350, 2500, 2800, 3100];

// ------------------------------------------------------------------ types

export interface Person {
  key: string;
  category: 'food' | 'agri';
  fullName: string;
  dob: string;
  phone: string;
  nationalId: string;
  householdSize: number;
  location: string;
}

export interface BeneficiaryRow extends Person {
  rowId: string;
  address: string;
}

export interface MerchantRow {
  id: string;
  businessName: string;
  licenceNo: string;
  authority: string;
  categories: Array<'food' | 'agri'>;
  onboarding: 'legacy' | 'self' | 'refused';
  location: string;
  address: string;
  onboardDay: number;
  notes: string;
}

export interface LicenceRow {
  licence_no: string;
  issuing_authority: string;
  business_name: string;
  licence_class: string;
  status: string;
  expires: string;
  county: string;
}

export type Plant =
  | 'valid'
  | 'p2p'
  | 'unregistered'
  | 'm30'
  | 'daily_cap'
  | 'weekly_cap'
  | 'category_mismatch'
  | 'm07_suspended'
  | 'after_expiry';

export interface Attempt {
  i: number;
  at: string;
  ts: number;
  from: string;
  from_row: string;
  to: string;
  to_label: string;
  asset: 'OVFOOD' | 'OVAGRI';
  amount: string;
  plant: Plant;
}

export const PLANT_EXPECTED: Record<Exclude<Plant, 'valid'>, { count: number; code: ReasonCode }> = {
  p2p: { count: 40, code: 'PEER_TO_PEER' },
  unregistered: { count: 25, code: 'MERCHANT_NOT_REGISTERED' },
  m30: { count: 18, code: 'MERCHANT_NOT_REGISTERED' },
  daily_cap: { count: 60, code: 'DAILY_CAP' },
  weekly_cap: { count: 35, code: 'WEEKLY_CAP' },
  category_mismatch: { count: 15, code: 'CATEGORY_MISMATCH' },
  m07_suspended: { count: 12, code: 'MERCHANT_NOT_ACTIVE' },
  after_expiry: { count: 10, code: 'PROGRAMME_NOT_ACTIVE' },
};

// ------------------------------------------------------------------ helpers

export function isoLocal(unix: number, tzOffsetSeconds = 3 * 3600): string {
  const d = new Date((unix + tzOffsetSeconds) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  const sign = tzOffsetSeconds >= 0 ? '+' : '-';
  const off = Math.abs(tzOffsetSeconds);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${sign}${p(Math.floor(off / 3600))}:${p(Math.floor((off % 3600) / 60))}`;
}

function formatPhone(rng: Rng, nine: string): string {
  switch (rng.int(0, 4)) {
    case 0:
      return `+254${nine}`;
    case 1:
      return `254${nine}`;
    case 2:
      return `0${nine.slice(0, 3)} ${nine.slice(3, 6)} ${nine.slice(6)}`;
    default:
      return `0${nine}`;
  }
}

function formatDob(rng: Rng, y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return rng.chance(0.1) ? `${p(d)}/${p(m)}/${y}` : `${y}-${p(m)}-${p(d)}`;
}

function messyCase(rng: Rng, name: string): string {
  const r = rng.next();
  if (r < 0.04) return name.toUpperCase();
  if (r < 0.07) return name.toLowerCase();
  if (r < 0.1) return ` ${name}  `;
  if (r < 0.12) return name.replace(' ', '  ');
  return name;
}

// ------------------------------------------------------------------ beneficiaries

interface DupSpec {
  kind: string;
  category: 'food' | 'agri';
  make(rng: Rng, p: Person): Person;
  needs(p: Person): boolean;
}

function withPhoneFormat(rng: Rng, phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const nine = digits.slice(-9);
  let out = phone;
  for (let k = 0; k < 10 && out === phone; k++) out = formatPhone(rng, nine);
  return out;
}

function dobParts(dob: string): [number, number, number] {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (m) return [+m[1], +m[2], +m[3]];
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dob);
  if (m) return [+m[3], +m[2], +m[1]];
  throw new Error(`bad dob ${dob}`);
}

function transposeId(id: string): string {
  const chars = id.split('');
  for (let i = chars.length - 2; i >= 0; i--) {
    if (/\d/.test(chars[i]) && /\d/.test(chars[i + 1]) && chars[i] !== chars[i + 1]) {
      [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
      return chars.join('');
    }
  }
  throw new Error('cannot transpose');
}

const DUPS: DupSpec[] = [
  {
    kind: 'transliteration Mohamed/Mohammed + phone format',
    category: 'food',
    needs: (p) => /\bMohamed\b/.test(p.fullName) && !!p.dob,
    make: (rng, p) => ({ ...p, fullName: p.fullName.replace('Mohamed', 'Mohammed'), phone: withPhoneFormat(rng, p.phone) }),
  },
  {
    kind: 'day/month swap in date of birth',
    category: 'food',
    needs: (p) => !!p.dob && dobParts(p.dob)[2] <= 12 && dobParts(p.dob)[1] !== dobParts(p.dob)[2],
    make: (rng, p) => {
      const [y, m, d] = dobParts(p.dob);
      return { ...p, dob: formatDob(rng, y, d, m), householdSize: p.householdSize + 1 };
    },
  },
  {
    kind: 'transposed digits in ID + phone format',
    category: 'food',
    needs: (p) => /^RF\d{8}$/.test(p.nationalId) && !!p.dob,
    make: (rng, p) => ({ ...p, nationalId: transposeId(p.nationalId), phone: withPhoneFormat(rng, p.phone) }),
  },
  {
    kind: 'no date of birth on the second registration + first-name typo',
    category: 'food',
    needs: (p) => !!p.dob && /^RF\d{8}$/.test(p.nationalId),
    make: (rng, p) => {
      const parts = p.fullName.split(' ');
      const f = parts[0];
      parts[0] = f.length > 3 ? f.slice(0, 2) + f[2] + f.slice(2) : f + 'a';
      return { ...p, fullName: parts.join(' '), dob: '', phone: withPhoneFormat(rng, p.phone) };
    },
  },
  {
    kind: 'case and whitespace only',
    category: 'food',
    needs: (p) => !!p.dob,
    make: (_rng, p) => ({ ...p, fullName: `  ${p.fullName.toUpperCase().replace(' ', '   ')} ` }),
  },
  {
    kind: 'transliteration Hussein/Husein',
    category: 'food',
    needs: (p) => /\bHussein\b/.test(p.fullName) && !!p.dob,
    make: (rng, p) => ({ ...p, fullName: p.fullName.replace('Hussein', 'Husein'), phone: withPhoneFormat(rng, p.phone) }),
  },
  {
    kind: 'spelling Nyakuoth/Nyakwoth',
    category: 'food',
    needs: (p) => /\bNyakuoth\b/.test(p.fullName) && !!p.dob,
    make: (_rng, p) => ({ ...p, fullName: p.fullName.replace('Nyakuoth', 'Nyakwoth') }),
  },
  {
    kind: 'hyphenated vs spaced first name',
    category: 'food',
    needs: (p) => /^Jean-/.test(p.fullName) && !!p.dob,
    make: (rng, p) => ({ ...p, fullName: p.fullName.replace('Jean-', 'Jean '), phone: withPhoneFormat(rng, p.phone) }),
  },
  {
    kind: 'surname written first',
    category: 'food',
    needs: (p) => !!p.dob && p.fullName.split(' ').length === 3,
    make: (_rng, p) => {
      const t = p.fullName.split(' ');
      return { ...p, fullName: `${t[2]} ${t[0]} ${t[1]}` };
    },
  },
  {
    kind: 'surname spelling (extra letter) + phone format',
    category: 'agri',
    needs: (p) => !!p.dob,
    make: (rng, p) => {
      const t = p.fullName.split(' ');
      t[t.length - 1] = t[t.length - 1] + 'h';
      return { ...p, fullName: t.join(' '), phone: withPhoneFormat(rng, p.phone) };
    },
  },
  {
    kind: 'day/month swap + household size differs',
    category: 'agri',
    needs: (p) => !!p.dob && dobParts(p.dob)[2] <= 12 && dobParts(p.dob)[1] !== dobParts(p.dob)[2],
    make: (rng, p) => {
      const [y, m, d] = dobParts(p.dob);
      return { ...p, dob: formatDob(rng, y, d, m), householdSize: Math.max(1, p.householdSize - 1) };
    },
  },
  {
    kind: 'transposed ID digits + name order swapped',
    category: 'agri',
    needs: (p) => /^\d{8}$/.test(p.nationalId) && !!p.dob && p.fullName.split(' ').length === 2,
    make: (_rng, p) => {
      const t = p.fullName.split(' ');
      return { ...p, fullName: `${t[1]} ${t[0]}`, nationalId: transposeId(p.nationalId) };
    },
  },
];

export interface BeneficiarySet {
  rows: BeneficiaryRow[];
  planted: Array<{ a: string; b: string; kind: string }>;
  hardNegatives: Array<{ a: string; b: string; kind: string }>;
}

export function makeBeneficiaries(rng: Rng): BeneficiarySet {
  const persons: Person[] = [];
  const usedNames = new Set<string>();
  const usedPhones = new Set<string>();
  const usedIds = new Set<string>();
  const newPhone = (): string => {
    for (;;) {
      const nine = `7${rng.int(0, 9)}${String(rng.int(0, 9_999_999)).padStart(7, '0')}`;
      const last7 = nine.slice(-7);
      if (!usedPhones.has(last7)) {
        usedPhones.add(last7);
        return nine;
      }
    }
  };
  const newId = (cat: 'food' | 'agri'): string => {
    for (;;) {
      const id = cat === 'food' ? `RF${String(rng.int(10_000_000, 99_999_999))}` : String(rng.int(20_000_000, 39_999_999));
      if (!usedIds.has(id)) {
        usedIds.add(id);
        return id;
      }
    }
  };
  const person = (cat: 'food' | 'agri', i: number, forced?: string): Person => {
    let name = forced ?? '';
    while (!name || usedNames.has(name.toLowerCase())) {
      if (cat === 'food') {
        const female = rng.chance(0.62);
        const first = female ? rng.pick(FOOD_FIRST_F) : rng.pick(FOOD_FIRST_M);
        name = rng.chance(0.6) ? `${first} ${rng.pick(FOOD_MIDDLE)} ${rng.pick(FOOD_SURNAME)}` : `${first} ${rng.pick(FOOD_SURNAME)}`;
        if (first === 'Jean' && rng.chance(0.5)) name = name.replace('Jean ', 'Jean-Baptiste ');
      } else {
        name = rng.chance(0.3) ? `${rng.pick(AGRI_FIRST)} ${rng.pick(AGRI_FIRST.filter((f) => /^N/.test(f)))} ${rng.pick(AGRI_SURNAME)}` : `${rng.pick(AGRI_FIRST)} ${rng.pick(AGRI_SURNAME)}`;
      }
    }
    usedNames.add(name.toLowerCase());
    const y = cat === 'food' ? rng.int(1958, 2006) : rng.int(1955, 2000);
    const m = rng.int(1, 12);
    const d = rng.int(1, 28);
    const hh = cat === 'food' ? rng.pick([1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 9]) : rng.int(2, 8);
    return {
      key: `${cat}-${i}`,
      category: cat,
      fullName: name,
      dob: formatDob(rng, y, m, d),
      phone: formatPhone(rng, newPhone()),
      nationalId: newId(cat),
      householdSize: hh,
      location: cat === 'food' ? rng.pick(FOOD_LOCATIONS) : rng.pick(AGRI_LOCATIONS),
    };
  };

  // 391 unique food + 97 unique agri people; a few forced names guarantee the variants exist.
  const forcedFood = ['Mohamed Abdi Warsame', 'Hussein Ali Jama', 'Nyakuoth Deng Malual', 'Jean-Baptiste Niyonzima'];
  for (let i = 0; i < 391; i++) persons.push(person('food', i, forcedFood[i]));
  for (let i = 0; i < 97; i++) persons.push(person('agri', i));

  // Hard negatives: siblings/twins or household members sharing a phone and surname.
  const hardNeg: Array<[Person, Person, string]> = [];
  const twin = (a: Person, first: string, sameDob: boolean, kind: string) => {
    const t = a.fullName.split(' ');
    const name = [first, ...t.slice(1)].join(' ');
    usedNames.add(name.toLowerCase());
    const b: Person = {
      ...a,
      key: `${a.key}-sib`,
      fullName: name,
      nationalId: newId(a.category),
      dob: sameDob ? a.dob : formatDob(rng, dobParts(a.dob)[0] + 3, rng.int(1, 12), rng.int(13, 28)),
      phone: withPhoneFormat(rng, a.phone),
      householdSize: a.householdSize,
    };
    hardNeg.push([a, b, kind]);
    return b;
  };
  // Replace three existing people by sibling pairs so the unique count stays 488.
  const hn1 = persons.findIndex((p) => p.category === 'food' && p.fullName.split(' ').length === 3 && !/^(Hodan|Ubah|Mohamed|Hussein|Nyakuoth|Jean)/.test(p.fullName));
  persons[hn1] = { ...persons[hn1], fullName: `Hodan ${persons[hn1].fullName.split(' ').slice(1).join(' ')}` };
  persons[hn1 + 1] = twin(persons[hn1], 'Ubah', true, 'twins sharing phone, surname and date of birth');
  const hn2 = persons.findIndex((p, i) => i > hn1 + 2 && p.category === 'food' && p.fullName.split(' ').length === 3 && !/^(Achol|Adut|Mohamed|Hussein|Nyakuoth|Jean)/.test(p.fullName));
  persons[hn2] = { ...persons[hn2], fullName: `Achol ${persons[hn2].fullName.split(' ').slice(1).join(' ')}` };
  persons[hn2 + 1] = twin(persons[hn2], 'Adut', true, 'twins sharing phone, surname and date of birth');
  const hn3 = persons.findIndex((p) => p.category === 'agri' && p.fullName.split(' ').length === 3);
  persons[hn3] = { ...persons[hn3], fullName: `Peter ${persons[hn3].fullName.split(' ').slice(1).join(' ')}` };
  persons[hn3 + 1] = twin(persons[hn3], 'Moses', false, 'brothers in one household sharing phone and surnames');

  // Missing DOB (22 here + 1 planted duplicate = 23) and 6 malformed IDs, on rows not used above.
  const protectedKeys = new Set(hardNeg.flatMap(([a, b]) => [a.key, b.key]));
  const dupOriginals: Array<[Person, DupSpec]> = [];
  for (const spec of DUPS) {
    const cand = persons.filter(
      (p) => p.category === spec.category && !protectedKeys.has(p.key) && !dupOriginals.some(([o]) => o.key === p.key) && spec.needs(p),
    );
    if (cand.length === 0) throw new Error(`no candidate for duplicate "${spec.kind}"`);
    const o = rng.pick(cand);
    dupOriginals.push([o, spec]);
    protectedKeys.add(o.key);
  }
  const free = persons.filter((p) => !protectedKeys.has(p.key));
  rng.shuffle(free);
  free.slice(0, 22).forEach((p) => (p.dob = ''));
  const malformed = ['N/A', '12345', 'RF1234567O', 'unknown', '0', 'RF-pending'];
  free.slice(22, 28).forEach((p, i) => (p.nationalId = malformed[i]));
  for (const p of persons) p.fullName = messyCase(rng, p.fullName);

  const dupRows: Array<[Person, Person, string]> = dupOriginals.map(([o, spec]) => {
    const clean = { ...o, fullName: o.fullName.trim().replace(/\s+/g, ' ') };
    const d = spec.make(rng, clean);
    return [o, { ...d, key: `${o.key}-dup` }, spec.kind];
  });

  const all = [...persons, ...dupRows.map(([, d]) => d)];
  rng.shuffle(all);
  // Duplicates are registered later than their originals: give originals the lower row ids.
  const order = all.map((p) => p.key);
  for (const [o, d] of dupRows) {
    const io = order.indexOf(o.key);
    const id = order.indexOf(d.key);
    if (io > id) {
      [all[io], all[id]] = [all[id], all[io]];
      [order[io], order[id]] = [order[id], order[io]];
    }
  }
  const rowOf = new Map<string, string>();
  const rows: BeneficiaryRow[] = all.map((p, i) => {
    const rowId = `R${String(i + 1).padStart(4, '0')}`;
    rowOf.set(p.key, rowId);
    return { ...p, rowId, address: simAddress(`recipient/${rowId}`) };
  });
  return {
    rows,
    planted: dupRows.map(([o, d, kind]) => ({ a: rowOf.get(o.key)!, b: rowOf.get(d.key)!, kind })),
    hardNegatives: hardNeg.map(([a, b, kind]) => {
      const [x, y] = [rowOf.get(a.key)!, rowOf.get(b.key)!].sort();
      return { a: x, b: y, kind };
    }),
  };
}

// ------------------------------------------------------------------ merchants and licences

const FOOD_SHOPS = [
  'Mama Neema General Shop', 'Hodan Minimart', 'Kakuma Fresh Grocers', 'Al-Amin Wholesalers', 'Twiga Retail Kiosk', 'Upendo Duka',
  'Bismillahi Shop', 'Nuru Cereals', 'Deng Brothers Store', 'Faraja Foods', 'Barwaqo Supermarket', 'Kalobeyei Maize Millers',
  'Amani Vegetable Stall', 'Salama Butchery & Grocery', 'Hope Traders', 'Ilham Provisions',
];
const AGRI_SHOPS = ['Kabuchai Agrovet', 'Lurambi Farmers Centre', 'Mumias Agro Supplies', 'Shikuku Seeds & Fertiliser', 'Wamalwa Agrovet', 'Namisi Farm Inputs'];

export function makeMerchants(): { merchants: MerchantRow[]; licences: LicenceRow[] } {
  const rng = new Rng(SEED + 7);
  const merchants: MerchantRow[] = [];
  const licences: LicenceRow[] = [];
  const foodNo = (n: number) => `SBP/TCG/2026/${String(n).padStart(4, '0')}`;
  const agriNo = (n: number) => `PCPB/AD/2026/${String(n).padStart(4, '0')}`;
  const messyNo = (no: string, k: number): string => {
    switch (k % 4) {
      case 0:
        return no;
      case 1:
        return no.toLowerCase().replace(/\//g, ' ');
      case 2:
        return no.replace(/\//g, '-');
      default:
        return ` ${no.replace(/\//g, '/ ')}`;
    }
  };
  const add = (m: Omit<MerchantRow, 'address'>, lic: Omit<LicenceRow, 'licence_no' | 'issuing_authority'> | null, regNo?: string) => {
    merchants.push({ ...m, address: simAddress(`merchant/${m.id}`) });
    if (lic) licences.push({ licence_no: regNo ?? m.licenceNo, issuing_authority: m.authority, ...lic });
  };
  for (let i = 1; i <= 30; i++) {
    const id = `M${String(i).padStart(2, '0')}`;
    if (i <= 16) {
      const name = FOOD_SHOPS[i - 1];
      add(
        { id, businessName: name, licenceNo: messyNo(foodNo(100 + i * 7), i), authority: i % 5 === 0 ? 'tcg' : 'TCG', categories: ['food'], onboarding: 'legacy', location: FOOD_LOCATIONS[(i - 1) % 6], onboardDay: 0, notes: i === 7 ? 'suspended day 17 (price-gouging complaint under review), reinstated day 33' : '' },
        { business_name: name.toUpperCase(), licence_class: 'RETAIL_FOOD', status: 'valid', expires: '2026-12-31', county: 'Turkana' },
        foodNo(100 + i * 7),
      );
    } else if (i <= 22) {
      const name = AGRI_SHOPS[i - 17];
      add(
        { id, businessName: name, licenceNo: messyNo(agriNo(400 + i * 3), i), authority: 'PCPB', categories: ['agri'], onboarding: 'legacy', location: AGRI_LOCATIONS[(i - 17) % 3], onboardDay: 0, notes: '' },
        { business_name: name, licence_class: 'AGRO_DEALER', status: 'valid', expires: '2027-06-30', county: i % 2 ? 'Bungoma' : 'Kakamega' },
        agriNo(400 + i * 3),
      );
    } else if (i <= 24) {
      const name = i === 23 ? 'Lodwar Road General Traders' : 'Bungoma Mjini General Stores';
      add(
        { id, businessName: name, licenceNo: messyNo(foodNo(700 + i), i), authority: 'TCG', categories: ['food', 'agri'], onboarding: 'legacy', location: i === 23 ? 'KKM-K2' : 'BGM-KBC', onboardDay: 0, notes: 'sells both food and farm inputs' },
        { business_name: name, licence_class: 'GENERAL_TRADER', status: 'valid', expires: '2027-03-31', county: i === 23 ? 'Turkana' : 'Bungoma' },
        foodNo(700 + i),
      );
    } else if (i <= 27) {
      const regNames = ['NEEMA FRESH PRODUCE', "ADUT'S KITCHEN SUPPLIES", 'KALOBEYEI SUNRISE GROCERY'];
      const typed = ['Neema Fresh Produce Ltd.', 'Aduts Kitchen Supplies', 'Kalobeyei Sunrise Grocery'];
      add(
        { id, businessName: typed[i - 25], licenceNo: messyNo(foodNo(900 + i), i + 1), authority: 'tcg ', categories: ['food'], onboarding: 'self', location: FOOD_LOCATIONS[(i + 1) % 6], onboardDay: [3, 5, 9][i - 25], notes: 'self-onboarded against the licence registry' },
        { business_name: regNames[i - 25], licence_class: 'RETAIL_FOOD', status: 'valid', expires: '2027-01-31', county: 'Turkana' },
        foodNo(900 + i),
      );
    } else if (i <= 29) {
      const name = i === 28 ? 'Lusweti Agrovet' : 'Sifuna Farm Inputs';
      add(
        { id, businessName: name, licenceNo: messyNo(agriNo(800 + i), i), authority: 'PCPB', categories: ['agri'], onboarding: 'self', location: AGRI_LOCATIONS[i - 28], onboardDay: i === 28 ? 4 : 11, notes: 'self-onboarded against the licence registry' },
        { business_name: name + (i === 29 ? ' Ltd' : ''), licence_class: 'AGRO_DEALER', status: 'valid', expires: '2027-02-28', county: 'Kakamega' },
        agriNo(800 + i),
      );
    } else {
      add(
        { id, businessName: 'Quick Cash Mini Shop', licenceNo: 'SBP/TCG/2026/0999', authority: 'TCG', categories: ['food'], onboarding: 'refused', location: 'KKM-K3', onboardDay: 6, notes: 'licence number not in the agency registry: refused LICENCE_NOT_FOUND' },
        null,
      );
    }
  }
  // 31 more licences that are not programme merchants: filler, 4 expired (two by status,
  // one lapsed by date with a stale status, one more by status), one with fewer than
  // min_licence_days left, a pharmacy and an eating house (classes not allowed).
  const counties = ['Turkana', 'Bungoma', 'Kakamega'];
  const extraNames = ['Kakuma Pharmacy', 'Loima Hotel & Eating House', 'Upendo Mini Mart', 'Nadapal Traders', 'Songot Grocers', 'Tarach Retail', 'Kanamkemer Store', 'Kalokol Fish & Grains', 'Lokichoggio Wholesale', 'Letea Duka'];
  for (let k = 0; k < 31; k++) {
    const isAgri = k % 3 === 2;
    const no = isAgri ? agriNo(1000 + k * 11) : foodNo(1000 + k * 13);
    let status = 'valid';
    let expires = rng.pick(['2026-12-31', '2027-03-31', '2027-06-30']);
    let cls = isAgri ? 'AGRO_DEALER' : rng.pick(['RETAIL_FOOD', 'RETAIL_FOOD', 'GENERAL_TRADER']);
    let name = isAgri ? `${rng.pick(AGRI_SURNAME)} Agrovet` : k < extraNames.length ? extraNames[k] : `${rng.pick(FOOD_SURNAME)} Shop`;
    if (k === 0) cls = 'PHARMACY';
    if (k === 1) cls = 'EATING_HOUSE';
    if (k === 3) {
      status = 'expired';
      expires = '2026-06-30';
    }
    if (k === 4) {
      status = 'valid';
      expires = '2026-08-31'; // lapsed but status not updated by the authority
    }
    if (k === 5) {
      status = 'valid';
      expires = '2026-09-20'; // fewer than min_licence_days left at onboarding
    }
    if (k === 6) {
      status = 'expired';
      expires = '2026-03-31';
    }
    if (k === 7) {
      status = 'expired';
      expires = '2025-12-31';
      name = name.toUpperCase();
    }
    licences.push({
      licence_no: k % 4 === 1 ? no.toLowerCase().replace(/\//g, ' ') : no,
      issuing_authority: isAgri ? 'PCPB' : k % 6 === 0 ? 'tcg' : 'TCG',
      business_name: name,
      licence_class: cls,
      status,
      expires,
      county: isAgri ? rng.pick(counties.slice(1)) : 'Turkana',
    });
  }
  new Rng(SEED + 11).shuffle(licences);
  return { merchants, licences };
}

// ------------------------------------------------------------------ registry timeline

export interface Timeline {
  programme: Programme;
  suspendAt: number; // M07
  reinstateAt: number; // M07
  activation: Map<string, number>; // merchant id → unix activation
  licenceExpires: Map<string, number>;
}

export function makeTimeline(programme: Programme, merchants: MerchantRow[], licences: LicenceRow[]): Timeline {
  const activation = new Map<string, number>();
  const licenceExpires = new Map<string, number>();
  for (const m of merchants) {
    if (m.onboarding === 'refused') continue;
    const at = m.onboarding === 'legacy' ? programme.start - 2 * DAY : programme.start + m.onboardDay * DAY + 10 * 3600 + 17 * 60;
    activation.set(m.id, at);
    const lic = licences.find((l) => l.licence_no.toUpperCase().replace(/[^A-Z0-9]/g, '') === m.licenceNo.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (!lic) throw new Error(`no licence for ${m.id}`);
    licenceExpires.set(m.id, licenceExpiryUnix(lic.expires, programme.tzOffsetSeconds));
  }
  return {
    programme,
    suspendAt: programme.start + 17 * DAY + 10 * 3600,
    reinstateAt: programme.start + 33 * DAY + 9 * 3600,
    activation,
    licenceExpires,
  };
}

const BIT = { food: 1, agri: 2 } as const;

export function merchantViewAt(t: Timeline, m: MerchantRow, at: number): MerchantView | undefined {
  const act = t.activation.get(m.id);
  if (act === undefined || at < act) return undefined;
  let status: MerchantView['status'] = 'Active';
  if (m.id === 'M07' && at >= t.suspendAt && at < t.reinstateAt) status = 'Suspended';
  return {
    status,
    categories: m.categories.reduce((a, c) => a | BIT[c], 0),
    licenceExpires: t.licenceExpires.get(m.id)!,
    selfOnboarded: m.onboarding === 'self',
  };
}

// ------------------------------------------------------------------ spending

export interface Recipient {
  row: BeneficiaryRow;
  asset: 'OVFOOD' | 'OVAGRI';
  entitlement: bigint;
}

export function enrolledRecipients(programme: Programme, rows: BeneficiaryRow[], sameLater: Set<string>): Recipient[] {
  return rows
    .filter((r) => !sameLater.has(r.rowId))
    .map((r) => {
      const asset = r.category === 'food' ? 'OVFOOD' : 'OVAGRI';
      return { row: r, asset, entitlement: entitlement(programme, asset, r.householdSize) } as Recipient;
    });
}

interface GenCtx {
  rng: Rng;
  programme: Programme;
  rules: Rules;
  timeline: Timeline;
  merchants: MerchantRow[];
  recipients: Recipient[];
  byAddress: Map<string, Recipient>;
  history: Map<string, SpendEntry[]>;
  attempts: Omit<Attempt, 'i' | 'at'>[];
  issuer: string;
}

function eligibleMerchants(ctx: GenCtx, r: Recipient, at: number, preferLocal: boolean): MerchantRow[] {
  const cat = r.asset === 'OVFOOD' ? 'food' : 'agri';
  const ok = ctx.merchants.filter((m) => {
    const v = merchantViewAt(ctx.timeline, m, at);
    return v && v.status === 'Active' && m.categories.includes(cat) && at < v.licenceExpires;
  });
  const local = ok.filter((m) => m.location === r.row.location);
  return preferLocal && local.length > 0 ? local : ok;
}

/** Popularity weights make spending concentrate on some merchants (top-5 share metric). */
function pickMerchant(ctx: GenCtx, list: MerchantRow[]): MerchantRow {
  const weights = list.map((m) => (['M01', 'M03', 'M09', 'M23', 'M17'].includes(m.id) ? 3 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let x = ctx.rng.next() * total;
  for (let i = 0; i < list.length; i++) {
    x -= weights[i];
    if (x < 0) return list[i];
  }
  return list[list.length - 1];
}

function check(ctx: GenCtx, r: Recipient, to: string, amount: bigint, at: number): ReturnType<typeof evaluate> {
  const m = ctx.merchants.find((x) => x.address === to);
  return evaluate(
    {
      source: r.row.address,
      ops: [{ type: 'payment', destination: to, assetCode: r.asset, assetIssuer: ctx.issuer, amount }],
    },
    {
      programme: { start: ctx.programme.start, expiry: ctx.programme.expiry, tzOffsetSeconds: ctx.programme.tzOffsetSeconds },
      issuer: ctx.issuer,
      assets: ctx.rules.assets,
      recipient: (a) => {
        const x = ctx.byAddress.get(a);
        return x ? { address: a, assets: [x.asset], suspended: false } : undefined;
      },
      merchant: () => (m ? merchantViewAt(ctx.timeline, m, at) : undefined),
      history: ctx.history.get(r.row.address) ?? [],
    },
    at,
  );
}

function push(ctx: GenCtx, r: Recipient, to: string, label: string, amount: bigint, at: number, plant: Plant): void {
  const d = check(ctx, r, to, amount, at);
  if (plant === 'valid') {
    if (!d.ok) throw new Error(`generator bug: valid attempt refused ${d.code} (${r.row.rowId} → ${label} ${formatAmount(amount)})`);
    const h = ctx.history.get(r.row.address) ?? [];
    h.push({ key: `g${ctx.attempts.length}`, source: r.row.address, destination: to, asset: r.asset, amount, at, kind: 'spend' });
    ctx.history.set(r.row.address, h);
  } else {
    const want = PLANT_EXPECTED[plant].code;
    if (d.ok || d.code !== want) throw new Error(`generator bug: planted ${plant} gave ${d.ok ? 'approval' : d.code}`);
  }
  ctx.attempts.push({ ts: at, from: r.row.address, from_row: r.row.rowId, to, to_label: label, asset: r.asset, amount: toStellarAmount(amount), plant });
}

function used(ctx: GenCtx, r: Recipient, at: number): { day: bigint; week: bigint } {
  const h = ctx.history.get(r.row.address) ?? [];
  const tz = ctx.programme.tzOffsetSeconds;
  const day = Math.floor((at + tz) / DAY);
  let d = 0n;
  let w = 0n;
  for (const e of h) {
    if (e.at > at) continue;
    if (Math.floor((e.at + tz) / DAY) === day) d += e.amount;
    if (e.at > at - 7 * DAY) w += e.amount;
  }
  return { day: d, week: w };
}

function spent(ctx: GenCtx, r: Recipient): bigint {
  return (ctx.history.get(r.row.address) ?? []).reduce((a, e) => a + e.amount, 0n);
}

function randomTimeOnDay(ctx: GenCtx, day: number, fromHour = 7, toHour = 19): number {
  return ctx.programme.start + day * DAY + ctx.rng.int(fromHour * 3600, toHour * 3600);
}

/**
 * Valid purchases for one recipient between `fromDay` and day 28, adding up to about
 * `target`: N shopping days drawn uniformly (so spending spreads over the four weeks),
 * KES-denominated basket prices converted at the programme rate, clipped to the daily
 * and weekly caps; whatever the caps or the calendar leave over stays unspent.
 */
function planPurchases(ctx: GenCtx, r: Recipient, target: bigint, fromDay: number): void {
  const asset = ctx.rules.assets.get(r.asset)!;
  const food = r.asset === 'OVFOOD';
  const remainingAtStart = target - spent(ctx, r);
  if (remainingAtStart <= 0n) return;
  const span = 28 - fromDay + 1;
  const nFull = food ? ctx.rng.int(8, 12) : ctx.rng.int(2, 4);
  const n = Math.max(1, Math.round((nFull * span) / 28));
  // chronological order matters: the caps are checked against earlier purchases only
  const times: number[] = [];
  for (let k = 0; k < n; k++) times.push(randomTimeOnDay(ctx, ctx.rng.int(fromDay, 28)));
  times.sort((a, b) => a - b);
  const mean = remainingAtStart / BigInt(n);
  for (let k = 0; k < times.length; k++) {
    const at = times[k];
    const u = used(ctx, r, at);
    const remaining = target - spent(ctx, r);
    if (remaining <= 0n) break;
    // a basket price around the per-purchase mean, in KES, rounded like a till would
    const kesMean = Number(mean) / 1e7 * ctx.programme.file.kes_per_usd;
    const kes = Math.max(20, Math.round((kesMean * (0.5 + ctx.rng.next())) / 5) * 5);
    let amt = kesToUsd(kes, ctx.programme.file.kes_per_usd, ctx.rng.chance(0.5) ? 2 : 3);
    if (k === times.length - 1 || amt > remaining || remaining - amt < parseAmount('0.30')) amt = remaining;
    const capRoom = [asset.dailyCap - u.day, asset.weeklyCap - u.week].reduce((a, b) => (a < b ? a : b));
    if (amt > capRoom) amt = capRoom;
    if (amt < parseAmount('0.05') && amt !== remaining) continue;
    if (amt <= 0n) continue;
    const list = eligibleMerchants(ctx, r, at, ctx.rng.chance(0.85));
    const m = pickMerchant(ctx, list);
    push(ctx, r, m.address, m.id, amt, at, 'valid');
  }
}

export interface SpendSet {
  attempts: Attempt[];
  planted: Record<string, number>;
}

export function makeSpending(programme: Programme, rules: Rules, timeline: Timeline, merchants: MerchantRow[], recipients: Recipient[], issuer: string): SpendSet {
  const ctx: GenCtx = {
    rng: new Rng(SEED + 99),
    programme,
    rules,
    timeline,
    merchants,
    recipients,
    byAddress: new Map(recipients.map((r) => [r.row.address, r])),
    history: new Map(),
    attempts: [],
    issuer,
  };
  const rng = ctx.rng;
  const food = recipients.filter((r) => r.asset === 'OVFOOD');
  const agri = recipients.filter((r) => r.asset === 'OVAGRI');

  // Weekly-cap plants: 35 food recipients with entitlement ≥ 12 spend ~9 in two days,
  // then try again on the third day.
  const heavy = rng.shuffle(food.filter((r) => r.entitlement >= parseAmount('12'))).slice(0, 35);
  const heavySet = new Set(heavy.map((r) => r.row.rowId));
  for (const r of heavy) {
    const d = rng.int(1, 16);
    const t1 = randomTimeOnDay(ctx, d, 8, 12);
    const m1 = pickMerchant(ctx, eligibleMerchants(ctx, r, t1, true));
    const a1 = parseAmount(`4.${rng.int(10, 95)}`);
    push(ctx, r, m1.address, m1.id, a1, t1, 'valid');
    const t2 = randomTimeOnDay(ctx, d + 1, 8, 12);
    const m2 = pickMerchant(ctx, eligibleMerchants(ctx, r, t2, true));
    const a2 = parseAmount(`4.${rng.int(10, 90)}`);
    push(ctx, r, m2.address, m2.id, a2, t2, 'valid');
    const t3 = randomTimeOnDay(ctx, d + 2, 9, 18);
    const room = parseAmount('10') - (a1 + a2);
    const over = room + parseAmount(`0.${String(rng.int(1, 99)).padStart(2, '0')}`) + BigInt(rng.int(0, 1)) * parseAmount('1');
    const m3 = pickMerchant(ctx, eligibleMerchants(ctx, r, t3, true));
    push(ctx, r, m3.address, m3.id, over, t3, 'weekly_cap');
    planPurchases(ctx, r, r.entitlement - (rng.chance(0.2) ? parseAmount('0.5') : 0n), d + 8);
  }

  // Ordinary spending: 3% spend nothing, 80% (nearly) everything, 17% part.
  for (const r of [...food, ...agri]) {
    if (heavySet.has(r.row.rowId)) continue;
    const x = rng.next();
    if (x < 0.03) continue;
    const target = x < 0.83 ? r.entitlement : (r.entitlement * BigInt(rng.int(60, 95))) / 100n;
    planPurchases(ctx, r, target, 1);
  }

  // Daily-cap plants: right after a valid purchase, the same recipient tries more than
  // the rest of today's cap.
  const valid = ctx.attempts.filter((a) => a.plant === 'valid');
  const dailyPicks = rng.shuffle([...valid]).filter((a) => {
    const local = (a.ts + programme.tzOffsetSeconds) % DAY;
    return local < 19 * 3600;
  });
  let dailyDone = 0;
  const usedFor = new Set<string>();
  for (const a of dailyPicks) {
    if (dailyDone >= 60) break;
    const key = `${a.from}|${Math.floor((a.ts + programme.tzOffsetSeconds) / DAY)}`;
    if (usedFor.has(key)) continue;
    usedFor.add(key);
    const r = ctx.byAddress.get(a.from)!;
    const t = a.ts + rng.int(600, 5400);
    const cap = rules.assets.get(r.asset)!.dailyCap;
    const u = used(ctx, r, t);
    const amt = cap - u.day + parseAmount(`${rng.int(0, 1)}.${String(rng.int(1, 99)).padStart(2, '0')}`);
    const m = pickMerchant(ctx, eligibleMerchants(ctx, r, t, true));
    push(ctx, r, m.address, m.id, amt, t, 'daily_cap');
    dailyDone++;
  }

  const anyTime = () => ctx.programme.start + rng.int(1, 27) * DAY + rng.int(7 * 3600, 20 * 3600);
  const smallAmount = (r: Recipient) => (r.asset === 'OVFOOD' ? kesToUsd(rng.pick(FOOD_KES), programme.file.kes_per_usd) : kesToUsd(rng.pick(AGRI_KES), programme.file.kes_per_usd));

  for (let k = 0; k < 40; k++) {
    const r = rng.pick(recipients);
    let other = rng.pick(recipients);
    while (other.row.address === r.row.address) other = rng.pick(recipients);
    push(ctx, r, other.row.address, `recipient ${other.row.rowId}`, smallAmount(r), anyTime(), 'p2p');
  }
  for (let k = 0; k < 25; k++) {
    const r = rng.pick(recipients);
    push(ctx, r, simAddress(`unregistered/${k}`), 'unregistered address', smallAmount(r), anyTime(), 'unregistered');
  }
  const m30 = merchants.find((m) => m.id === 'M30')!;
  for (let k = 0; k < 18; k++) {
    const r = rng.pick(food);
    push(ctx, r, m30.address, 'M30', smallAmount(r), ctx.programme.start + rng.int(6, 27) * DAY + rng.int(8 * 3600, 19 * 3600), 'm30');
  }
  for (let k = 0; k < 15; k++) {
    const r = rng.pick(recipients);
    const t = anyTime();
    const wrong = merchants.filter((m) => {
      const v = merchantViewAt(timeline, m, t);
      return v && v.status === 'Active' && m.categories.length === 1 && m.categories[0] !== (r.asset === 'OVFOOD' ? 'food' : 'agri');
    });
    const m = rng.pick(wrong);
    push(ctx, r, m.address, m.id, smallAmount(r), t, 'category_mismatch');
  }
  const m07 = merchants.find((m) => m.id === 'M07')!;
  for (let k = 0; k < 12; k++) {
    const r = rng.pick(food);
    const t = timeline.suspendAt + rng.int(3600, 11 * DAY);
    push(ctx, r, m07.address, 'M07', smallAmount(r), t, 'm07_suspended');
  }
  for (let k = 0; k < 10; k++) {
    const r = rng.pick(recipients);
    const t = programme.expiry + rng.int(3600, 2 * DAY);
    const m = pickMerchant(ctx, eligibleMerchants(ctx, r, programme.expiry - 3600, true));
    push(ctx, r, m.address, m.id, smallAmount(r), t, 'after_expiry');
  }

  const sorted = ctx.attempts
    .map((a, idx) => ({ a, idx }))
    .sort((x, y) => x.a.ts - y.a.ts || x.idx - y.idx)
    .map(({ a }, i) => ({ i: i + 1, at: isoLocal(a.ts, programme.tzOffsetSeconds), ...a }));
  const planted: Record<string, number> = {};
  for (const a of sorted) planted[a.plant] = (planted[a.plant] ?? 0) + 1;
  return { attempts: sorted, planted };
}

// ------------------------------------------------------------------ pool plan

export interface RedemptionRound {
  day: number;
  at: string;
  ts: number;
  redemptions: Array<{ merchant: string; amount: string; expect: 'ok' | 'MerchantNotActive' }>;
}

export function makePoolPlan(
  programme: Programme,
  timeline: Timeline,
  merchants: MerchantRow[],
  attempts: Attempt[],
  disbursed: Record<string, bigint>,
): Record<string, unknown> {
  const roundDays = [7, 14, 21, 28, 34];
  const rounds = (asset: 'OVFOOD' | 'OVAGRI'): RedemptionRound[] => {
    const bal = new Map<string, bigint>();
    const out: RedemptionRound[] = [];
    let idx = 0;
    const valid = attempts.filter((a) => a.plant === 'valid' && a.asset === asset);
    for (const day of roundDays) {
      const ts = programme.start + day * DAY + (day === 34 ? 12 : 20) * 3600;
      while (idx < valid.length && valid[idx].ts <= ts) {
        const a = valid[idx++];
        bal.set(a.to_label, (bal.get(a.to_label) ?? 0n) + parseAmount(a.amount));
      }
      const reds: RedemptionRound['redemptions'] = [];
      for (const m of merchants) {
        const b = bal.get(m.id) ?? 0n;
        if (b <= 0n) continue;
        const v = merchantViewAt(timeline, m, ts);
        const ok = v !== undefined && v.status === 'Active';
        reds.push({ merchant: m.id, amount: toStellarAmount(b), expect: ok ? 'ok' : 'MerchantNotActive' });
        if (ok) bal.set(m.id, 0n);
      }
      out.push({ day, at: isoLocal(ts, programme.tzOffsetSeconds), ts, redemptions: reds });
    }
    return out;
  };
  const pct = (v: bigint, p: bigint) => ((v * p) / 100n / 100_000n) * 100_000n; // round down to cents
  const foodFund = pct(disbursed.OVFOOD, 85n);
  return {
    simulated: true,
    note: 'Food pool funded at 85% of OVFOOD disbursed on day 1 and topped up on day 30; agri pool fully funded. Redemption rounds are derived from the valid payments in spend-weeks-1-4.jsonl and are mirrored by contracts/redeem_pool scenario_programme_cycle.',
    OVFOOD: {
      disbursed: toStellarAmount(disbursed.OVFOOD),
      fund_day1: { day: 1, amount: toStellarAmount(foodFund) },
      top_up: { day: 30, amount: toStellarAmount(disbursed.OVFOOD - foodFund) },
      rounds: rounds('OVFOOD'),
    },
    OVAGRI: {
      disbursed: toStellarAmount(disbursed.OVAGRI),
      fund_day1: { day: 1, amount: toStellarAmount(disbursed.OVAGRI) },
      top_up: null,
      rounds: rounds('OVAGRI'),
    },
    settle_day: 30,
    withdraw_day: 43,
  };
}

// ------------------------------------------------------------------ everything

export function generateSeed(): Record<string, string> {
  const files: Record<string, string> = {};
  const programmeText = JSON.stringify(PROGRAMME, null, 2) + '\n';
  const rulesText = JSON.stringify(RULES, null, 2) + '\n';
  files['programme.json'] = programmeText;
  files['rules.json'] = rulesText;
  const programme = programmeFrom(PROGRAMME);
  const rules = rulesFrom(rulesText);
  const issuer = SIM.issuer().publicKey();

  const rng = new Rng(SEED);
  const ben = makeBeneficiaries(rng);
  files['beneficiaries.csv'] = toCsv(
    ['row_id', 'full_name', 'dob', 'phone', 'national_id', 'household_size', 'location', 'category', 'wallet_address'],
    ben.rows.map((r) => ({
      row_id: r.rowId,
      full_name: r.fullName,
      dob: r.dob,
      phone: r.phone,
      national_id: r.nationalId,
      household_size: r.householdSize,
      location: r.location,
      category: r.category,
      wallet_address: r.address,
    })),
  );
  files['dedup-decisions.csv'] = toCsv(
    ['row_a', 'row_b', 'decision', 'decided_by', 'note'],
    [
      ...ben.planted.map((p) => ({ row_a: p.a, row_b: p.b, decision: 'same', decided_by: 'CVA officer (simulated)', note: p.kind })),
      ...ben.hardNegatives.map((p) => ({ row_a: p.a, row_b: p.b, decision: 'distinct', decided_by: 'CVA officer (simulated)', note: p.kind })),
    ],
  );

  const sameLater = new Set(ben.planted.map((p) => p.b));
  const recipients = enrolledRecipients(programme, ben.rows, sameLater);
  // SDP-style disbursement file: every row, including the duplicates; `voucher disburse`
  // skips the later row of each pair decided `same`.
  files['sdp-disbursement.csv'] = toCsv(
    ['phone', 'walletAddress', 'id', 'amount', 'verification', 'paymentID'],
    ben.rows.map((r, i) => {
      const asset = r.category === 'food' ? 'OVFOOD' : 'OVAGRI';
      return {
        phone: r.phone.trim(),
        walletAddress: r.address,
        id: r.rowId,
        amount: formatAmount(entitlement(programme, asset, r.householdSize)),
        verification: r.dob,
        paymentID: `${asset}-2026-09-${String(i + 1).padStart(4, '0')}`,
      };
    }),
  );

  const { merchants, licences } = makeMerchants();
  files['merchants.csv'] = toCsv(
    ['merchant_id', 'business_name', 'licence_no', 'issuing_authority', 'categories', 'onboarding', 'onboard_day', 'location', 'address', 'notes'],
    merchants.map((m) => ({
      merchant_id: m.id,
      business_name: m.businessName,
      licence_no: m.licenceNo,
      issuing_authority: m.authority,
      categories: m.categories.join(';'),
      onboarding: m.onboarding,
      onboard_day: m.onboardDay,
      location: m.location,
      address: m.address,
      notes: m.notes,
    })),
  );
  const licText = toCsv(['licence_no', 'issuing_authority', 'business_name', 'licence_class', 'status', 'expires', 'county'], licences as unknown as Array<Record<string, string>>);
  files['licence-registry.csv'] = licText;
  const agency = SIM.agency();
  files['licence-registry.sig'] = signRegistry(Buffer.from(licText, 'utf8'), agency) + '\n';
  files['test-agency-key.json'] =
    JSON.stringify(
      {
        WARNING: 'TEST-ONLY KEY. Derived from a public label; anyone can recompute the secret. Never use it for a real registry.',
        public_key: agency.publicKey(),
        secret: agency.secret(),
      },
      null,
      2,
    ) + '\n';

  const timeline = makeTimeline(programme, merchants, licences);
  const spend = makeSpending(programme, rules, timeline, merchants, recipients, issuer);
  files['spend-weeks-1-4.jsonl'] = spend.attempts.map((a) => JSON.stringify({ i: a.i, at: a.at, from: a.from, from_row: a.from_row, to: a.to, to_label: a.to_label, asset: a.asset, amount: a.amount, plant: a.plant })).join('\n') + '\n';

  const disbursed: Record<string, bigint> = { OVFOOD: 0n, OVAGRI: 0n };
  for (const r of recipients) disbursed[r.asset] += r.entitlement;
  const plan = makePoolPlan(programme, timeline, merchants, spend.attempts, disbursed);
  files['pool-plan.json'] = JSON.stringify(plan, null, 2) + '\n';

  const byCode: Record<string, number> = {};
  for (const [plant, e] of Object.entries(PLANT_EXPECTED)) byCode[e.code] = (byCode[e.code] ?? 0) + (spend.planted[plant] ?? 0);
  const validCount = spend.planted.valid ?? 0;
  const spentValid: Record<string, bigint> = { OVFOOD: 0n, OVAGRI: 0n };
  for (const a of spend.attempts) if (a.plant === 'valid') spentValid[a.asset] += parseAmount(a.amount);
  files['expected.json'] =
    JSON.stringify(
      {
        simulated: true,
        seed: SEED,
        attempts: spend.attempts.length,
        planted: Object.fromEntries(Object.entries(PLANT_EXPECTED).map(([k]) => [k, spend.planted[k] ?? 0])),
        approved: validCount,
        refusals_by_code: byCode,
        beneficiary_rows: ben.rows.length,
        enrolled_recipients: recipients.length,
        planted_duplicate_pairs: ben.planted,
        hard_negative_pairs: ben.hardNegatives,
        disbursed: { OVFOOD: toStellarAmount(disbursed.OVFOOD), OVAGRI: toStellarAmount(disbursed.OVAGRI) },
        spent: { OVFOOD: toStellarAmount(spentValid.OVFOOD), OVAGRI: toStellarAmount(spentValid.OVAGRI) },
        unspent: { OVFOOD: toStellarAmount(disbursed.OVFOOD - spentValid.OVFOOD), OVAGRI: toStellarAmount(disbursed.OVAGRI - spentValid.OVAGRI) },
      },
      null,
      2,
    ) + '\n';
  return files;
}

export function writeSeed(dir = SEED_DIR): string[] {
  const files = generateSeed();
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(resolve(dir, name), text);
  return Object.keys(files);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const names = writeSeed();
  console.log(`wrote ${names.length} files to ${SEED_DIR}: ${names.join(', ')}`);
}
