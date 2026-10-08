// HTTP wrapper (node:http, no framework) around the approval and onboarding services.
//   POST /tx-approve       {tx}  → 200 {status:"revised", tx, message} | 400 {status:"rejected", error}
//   POST /merchants/apply  {...} → 200 {status:"active"|"pending_review"} | 422 {status:"rejected", reason}
//   GET  /health, GET /rules
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Rules } from '../config.js';
import type { ApplyRequest, Onboarding } from '../onboarding/apply.js';
import type { ApprovalService } from './approve.js';

export interface ServerDeps {
  approval: ApprovalService;
  onboarding?: Onboarding;
  rules: Rules;
  rulesText: string;
  programmeId: string;
}

const MAX_BODY = 64 * 1024;

function send(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'access-control-allow-origin': '*' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  if (!text.trim()) return {};
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('body must be a JSON object');
  return v as Record<string, unknown>;
}

export function createApprovalServer(deps: ServerDeps): Server {
  return createServer((req, res) => {
    void handle(deps, req, res).catch((e: unknown) => send(res, 500, { status: 'rejected', error: (e as Error).message }));
  });
}

async function handle(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' });
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { ok: true, programme: deps.programmeId, rules_sha256: deps.rules.hash });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/rules') {
    send(res, 200, { rules: JSON.parse(deps.rulesText) as unknown, sha256: deps.rules.hash });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/tx-approve') {
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch (e) {
      send(res, 400, { status: 'rejected', error: (e as Error).message });
      return;
    }
    if (typeof body.tx !== 'string' || !body.tx) {
      send(res, 400, { status: 'rejected', error: 'missing "tx" (base64 XDR transaction envelope)' });
      return;
    }
    const out = await deps.approval.approve(body.tx);
    send(res, out.response.status === 'revised' ? 200 : 400, out.response);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/merchants/apply') {
    if (!deps.onboarding) {
      send(res, 503, { status: 'rejected', error: 'onboarding is not configured on this server' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch (e) {
      send(res, 400, { status: 'rejected', error: (e as Error).message });
      return;
    }
    const need = ['address', 'businessName', 'licenceNumber', 'issuingAuthority', 'signedApplyTx'];
    const missing = need.filter((k) => typeof body[k] !== 'string' || !(body[k] as string).trim());
    if (missing.length || !Array.isArray(body.categories)) {
      send(res, 400, { status: 'rejected', error: `missing or invalid fields: ${[...missing, ...(Array.isArray(body.categories) ? [] : ['categories'])].join(', ')}` });
      return;
    }
    const result = await deps.onboarding.apply(body as unknown as ApplyRequest);
    send(res, result.status === 'rejected' ? 422 : 200, result);
    return;
  }
  send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
}
