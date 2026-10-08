// CLI argument parsing: `voucher <command> [--flag value] [--switch]`.
export class UsageError extends Error {}

export interface CommandSpec {
  /** flags that take a value */
  values: string[];
  /** boolean switches */
  switches: string[];
  required?: string[];
  /** at most one of these may be given */
  exclusive?: string[];
}

export const COMMANDS: Record<string, CommandSpec> = {
  issue: { values: ['programme', 'config', 'rules'], switches: ['offline'] },
  enrol: {
    values: ['merchant', 'licence', 'authority', 'categories', 'suspend', 'revoke', 'business-name', 'expires'],
    switches: ['legacy', 'approve', 'reinstate', 'dry-run'],
    required: ['merchant'],
    exclusive: ['legacy', 'approve', 'suspend', 'reinstate', 'revoke'],
  },
  dedup: { values: ['csv', 'out', 'provider', 'programme-config'], switches: [], required: ['csv'] },
  disburse: { values: ['sdp-csv', 'asset', 'decisions', 'beneficiaries'], switches: ['dry-run'], required: ['sdp-csv', 'asset', 'decisions'] },
  pay: { values: ['from', 'merchant', 'asset', 'amount'], switches: ['dry-run'], required: ['from', 'merchant', 'asset', 'amount'] },
  fund: { values: ['asset', 'amount'], switches: ['dry-run'], required: ['asset', 'amount'] },
  redeem: { values: ['merchant', 'asset', 'amount'], switches: ['dry-run'], required: ['merchant', 'asset', 'amount'] },
  settle: { values: ['asset', 'max'], switches: ['dry-run'], required: ['asset'] },
  expire: { values: ['programme', 'holdings'], switches: ['dry-run'], required: ['programme'] },
  report: { values: ['programme', 'from', 'to', 'provider', 'approve', 'events', 'out'], switches: [], required: ['programme', 'from', 'to'] },
  serve: { values: ['port'], switches: ['demo'] },
  simulate: { values: ['weeks', 'out', 'seed-dir'], switches: ['json'] },
  help: { values: [], switches: [] },
};

export interface Parsed {
  command: string;
  flags: Record<string, string>;
  switches: Set<string>;
}

export function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help', flags: {}, switches: new Set() };
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`unknown command "${command}" (try: ${Object.keys(COMMANDS).join(', ')})`);
  const flags: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith('--')) throw new UsageError(`unexpected argument "${tok}"`);
    let name = tok.slice(2);
    let inline: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (spec.switches.includes(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
      switches.add(name);
    } else if (spec.values.includes(name)) {
      const v = inline ?? rest[++i];
      if (v === undefined || (inline === undefined && v.startsWith('--'))) throw new UsageError(`--${name} needs a value`);
      if (name in flags) throw new UsageError(`--${name} given twice`);
      flags[name] = v;
    } else {
      throw new UsageError(`unknown option --${name} for "${command}"`);
    }
  }
  for (const r of spec.required ?? []) if (!(r in flags)) throw new UsageError(`${command}: --${r} is required`);
  const ex = (spec.exclusive ?? []).filter((e) => e in flags || switches.has(e));
  if (ex.length > 1) throw new UsageError(`${command}: use only one of ${ex.map((e) => `--${e}`).join(', ')}`);
  return { command, flags, switches };
}

export function parseCategories(s: string): Array<'food' | 'agri'> {
  const out = s
    .split(/[,;]/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (out.length === 0) throw new UsageError('--categories needs at least one of food, agri');
  for (const c of out) if (c !== 'food' && c !== 'agri') throw new UsageError(`unknown category "${c}" (food, agri)`);
  return [...new Set(out)] as Array<'food' | 'agri'>;
}

export function parseAssetCode(s: string, known: Iterable<string>): string {
  const code = s.trim().toUpperCase();
  const list = [...known];
  if (!list.includes(code)) throw new UsageError(`unknown voucher asset "${s}" (${list.join(', ')})`);
  return code;
}

export function parseDate(s: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new UsageError(`--${name} must be YYYY-MM-DD`);
  return s;
}

export function parsePositiveInt(s: string, name: string): number {
  if (!/^\d+$/.test(s) || Number(s) <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return Number(s);
}

export function parseGAddress(s: string, name: string): string {
  if (!/^G[A-Z2-7]{55}$/.test(s.trim())) throw new UsageError(`--${name} must be a G… account address`);
  return s.trim();
}
