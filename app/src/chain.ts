/**
 * Contract-call building (offline, tested) and RPC simulation/submission (network,
 * not exercised in tests) for merchant_registry and redeem_pool, plus classic
 * transaction submission through Horizon.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  type Operation,
  Transaction,
  TransactionBuilder,
  contract as contractNs,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { MerchantStatus, MerchantView } from './sep8/types.js';
import type { RegistryReader } from './sep8/registry-reader.js';

export interface ChainConfig {
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
}

export const NULL_ACCOUNT: string = contractNs.NULL_ACCOUNT;

export const arg = {
  u32: (n: number): xdr.ScVal => nativeToScVal(n, { type: 'u32' }),
  u64: (n: number | bigint): xdr.ScVal => nativeToScVal(n, { type: 'u64' }),
  i128: (n: bigint): xdr.ScVal => nativeToScVal(n, { type: 'i128' }),
  bool: (b: boolean): xdr.ScVal => xdr.ScVal.scvBool(b),
  address: (a: string): xdr.ScVal => new Address(a).toScVal(),
  bytes32: (hex: string): xdr.ScVal => {
    const b = Buffer.from(hex, 'hex');
    if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
    return xdr.ScVal.scvBytes(b);
  },
};

export interface Invocation {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

export function buildInvokeTx(
  source: Account,
  inv: Invocation,
  networkPassphrase: string,
  timeoutSeconds = 300,
): Transaction {
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(inv.contractId).call(inv.method, ...inv.args))
    .setTimeout(timeoutSeconds)
    .build();
}

export interface DecodedInvocation {
  contractId: string;
  method: string;
  args: unknown[];
}

/** Decodes the single invoke-host-function operation of a transaction. */
export function decodeInvocation(tx: Transaction): DecodedInvocation {
  const op = tx.operations[0] as Operation.InvokeHostFunction | undefined;
  if (!op || tx.operations.length !== 1 || op.type !== 'invokeHostFunction') {
    throw new Error('expected exactly one invoke-host-function operation');
  }
  const fn = op.func;
  if (fn.type !== 'hostFunctionTypeInvokeContract') throw new Error('not a contract invocation');
  const inv = fn.invokeContract;
  return {
    contractId: Address.fromScAddress(inv.contractAddress).toString(),
    method: String(inv.functionName),
    args: [...inv.args].map((a) => scValToNative(a)),
  };
}

// ------------------------------------------------------------------ call builders

export const registryCall = {
  enrol: (id: string, merchant: string, licenceHashHex: string, categories: number, licenceExpires: number): Invocation => ({
    contractId: id,
    method: 'enrol',
    args: [arg.address(merchant), arg.bytes32(licenceHashHex), arg.u32(categories), arg.u64(licenceExpires)],
  }),
  apply: (id: string, merchant: string, licenceHashHex: string, categories: number): Invocation => ({
    contractId: id,
    method: 'apply',
    args: [arg.address(merchant), arg.bytes32(licenceHashHex), arg.u32(categories)],
  }),
  approve: (id: string, verifier: string, merchant: string, licenceExpires: number): Invocation => ({
    contractId: id,
    method: 'approve',
    args: [arg.address(verifier), arg.address(merchant), arg.u64(licenceExpires)],
  }),
  suspend: (id: string, merchant: string, reason: number): Invocation => ({
    contractId: id,
    method: 'suspend',
    args: [arg.address(merchant), arg.u32(reason)],
  }),
  reinstate: (id: string, merchant: string): Invocation => ({ contractId: id, method: 'reinstate', args: [arg.address(merchant)] }),
  revoke: (id: string, merchant: string, reason: number): Invocation => ({
    contractId: id,
    method: 'revoke',
    args: [arg.address(merchant), arg.u32(reason)],
  }),
  get: (id: string, merchant: string): Invocation => ({ contractId: id, method: 'get', args: [arg.address(merchant)] }),
  licenceOwner: (id: string, licenceHashHex: string): Invocation => ({
    contractId: id,
    method: 'licence_owner',
    args: [arg.bytes32(licenceHashHex)],
  }),
};

export const poolCall = {
  fund: (id: string, from: string, amount: bigint): Invocation => ({
    contractId: id,
    method: 'fund',
    args: [arg.address(from), arg.i128(amount)],
  }),
  redeem: (id: string, merchant: string, amount: bigint): Invocation => ({
    contractId: id,
    method: 'redeem',
    args: [arg.address(merchant), arg.i128(amount)],
  }),
  settleQueue: (id: string, max: number): Invocation => ({ contractId: id, method: 'settle_queue', args: [arg.u32(max)] }),
  coverage: (id: string): Invocation => ({ contractId: id, method: 'coverage', args: [] }),
  withdrawSurplus: (id: string, to: string, amount: bigint): Invocation => ({
    contractId: id,
    method: 'withdraw_surplus',
    args: [arg.address(to), arg.i128(amount)],
  }),
};

/** `Option<Merchant>` as returned by scValToNative → MerchantView. */
export function toMerchantView(native: unknown): MerchantView | undefined {
  if (native === undefined || native === null) return undefined;
  const m = native as Record<string, unknown>;
  const status = Array.isArray(m.status) ? String(m.status[0]) : String(m.status);
  return {
    status: status as MerchantStatus,
    categories: Number(m.categories),
    licenceExpires: Number(m.licence_expires),
    selfOnboarded: Boolean(m.self_onboarded),
  };
}

/** Pretty-prints the outcome enum `RedeemOutcome` (`["Paid", n]` / `["Queued", id]`). */
export function describeOutcome(native: unknown): string {
  if (Array.isArray(native)) return native[0] === 'Queued' ? `Queued #${native[1]}` : `Paid ${String(native[1])}`;
  return String(native);
}

// ------------------------------------------------------------------ network (not run offline)

export function rpcServer(cfg: ChainConfig): rpc.Server {
  return new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith('http://') });
}

export async function simulateView(cfg: ChainConfig, inv: Invocation): Promise<unknown> {
  const tx = buildInvokeTx(new Account(NULL_ACCOUNT, '0'), inv, cfg.networkPassphrase);
  const sim = await rpcServer(cfg).simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation of ${inv.method} failed: ${sim.error}`);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`simulation of ${inv.method} returned no result`);
  return scValToNative(sim.result.retval);
}

export async function submitInvocation(cfg: ChainConfig, signer: Keypair, inv: Invocation): Promise<{ hash: string; returnValue?: unknown }> {
  const srv = rpcServer(cfg);
  const source = await srv.getAccount(signer.publicKey());
  const prepared = await srv.prepareTransaction(buildInvokeTx(source, inv, cfg.networkPassphrase));
  prepared.sign(signer);
  return sendPrepared(cfg, prepared);
}

export async function sendPrepared(cfg: ChainConfig, tx: Transaction): Promise<{ hash: string; returnValue?: unknown }> {
  const srv = rpcServer(cfg);
  const sent = await srv.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(`transaction rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
  const final = await srv.pollTransaction(sent.hash, { attempts: 30, sleepStrategy: () => 1500 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`transaction ${sent.hash} ended with status ${final.status}`);
  return { hash: sent.hash, returnValue: final.returnValue ? scValToNative(final.returnValue) : undefined };
}

export async function submitClassic(cfg: ChainConfig, tx: Transaction): Promise<string> {
  const res = await new Horizon.Server(cfg.horizonUrl).submitTransaction(tx);
  return res.hash;
}

export async function loadAccount(cfg: ChainConfig, address: string): Promise<Account> {
  const a = await new Horizon.Server(cfg.horizonUrl).loadAccount(address);
  return new Account(a.accountId(), a.sequenceNumber());
}

/** RegistryReader backed by RPC simulation of `get` (wrap in CachedRegistryReader). */
export class RpcRegistryReader implements RegistryReader {
  constructor(
    private readonly cfg: ChainConfig,
    private readonly registryId: string,
  ) {}
  async getMerchant(address: string): Promise<MerchantView | undefined> {
    return toMerchantView(await simulateView(this.cfg, registryCall.get(this.registryId, address)));
  }
}
