// src/concordium/chain.ts
// Signing and submitting Concordium transactions from Node with @concordium/web-sdk 12.
// Keys never leave this process: they are read from a wallet export file outside the repo.
import fs from 'fs';
import {
  AccountAddress,
  buildAccountSigner,
  CcdAmount,
  ContractAddress,
  ContractName,
  DataBlob,
  Energy,
  EntrypointName,
  Parameter,
  parseWallet,
  serializeUpdateContractParameters,
  ReceiveName,
  Transaction,
  TransactionHash,
  type AccountSigner,
} from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { NetworkConfig } from './config';

export interface Wallet {
  sender: AccountAddress.Type;
  signer: AccountSigner;
}

export function client(cfg: NetworkConfig): ConcordiumGRPCNodeClient {
  return new ConcordiumGRPCNodeClient(cfg.grpcHost, cfg.grpcPort, credentials.createSsl());
}

/**
 * Loads an account from a key file exported by Concordium Wallet for Web.
 * Accepts the JSON export format (parseWallet). The address comes from the file itself.
 */
export function loadWallet(keyFile: string): Wallet {
  if (!fs.existsSync(keyFile)) throw new Error(`Key file not found: ${keyFile}`);
  return loadWalletFromJson(fs.readFileSync(keyFile, 'utf8'), keyFile);
}

/** Same, from the content of the export (e.g. an encrypted environment variable on a host). */
export function loadWalletFromJson(raw: string, label = 'the key'): Wallet {
  let parsed;
  try {
    parsed = parseWallet(raw);
  } catch (error) {
    throw new Error(
      `Could not read ${label} as a Concordium wallet export (${error instanceof Error ? error.message : error}). ` +
        'Export the account from Concordium Wallet for Web: account settings → Export private key.'
    );
  }
  return { sender: AccountAddress.fromBase58(parsed.value.address), signer: buildAccountSigner(parsed) };
}

export interface Submitted {
  txHash: string;
  blockHash: string;
  outcome: 'success' | 'rejected';
  rejectReason?: unknown;
}

async function nextNonce(cfg: NetworkConfig, wallet: Wallet) {
  return (await client(cfg).getNextAccountNonce(wallet.sender)).nonce;
}

/** Signs, submits and waits for finalization. */
async function submit(cfg: NetworkConfig, wallet: Wallet, signable: Parameters<typeof Transaction.signAndFinalize>[0]): Promise<Submitted> {
  const grpc = client(cfg);
  const finalized = await Transaction.signAndFinalize(signable, wallet.signer);
  const hash = await grpc.sendTransaction(finalized);
  const result = await grpc.waitForTransactionFinalization(hash);
  const summary = result.summary as { type?: string; transactionType?: string; rejectReason?: unknown };
  const rejected = summary.transactionType === 'failed' || summary.rejectReason !== undefined;
  return {
    txHash: TransactionHash.toHexString(hash),
    blockHash: String(result.blockHash),
    outcome: rejected ? 'rejected' : 'success',
    rejectReason: summary.rejectReason,
  };
}

/** Resolves the contract name of an instance (e.g. "cis8004_registry") from the chain. */
async function contractName(cfg: NetworkConfig, address: ContractAddress.Type): Promise<ContractName.Type> {
  const info = await client(cfg).getInstanceInfo(address);
  return ContractName.fromInitName(info.name);
}

/**
 * Sends an update to a contract entrypoint with a hex parameter produced by an MCP build_* tool.
 * Energy is estimated by dry-running the call first; a dry-run failure stops before anything is signed.
 */
export async function updateContract(
  cfg: NetworkConfig,
  wallet: Wallet,
  contract: { index: bigint; subindex: bigint },
  entrypoint: string,
  paramHex: string
): Promise<Submitted> {
  const address = ContractAddress.create(contract.index, contract.subindex);
  const receiveName = ReceiveName.create(await contractName(cfg, address), EntrypointName.fromString(entrypoint));
  const message = Parameter.fromHexString(paramHex);

  const dryRun = await client(cfg).invokeContract({
    contract: address,
    invoker: wallet.sender,
    method: receiveName,
    parameter: message,
    amount: CcdAmount.zero(),
  });
  if (dryRun.tag !== 'success') {
    throw new Error(`Dry run of ${ReceiveName.toString(receiveName)} failed: ${JSON.stringify(dryRun, bigintSafe)}`);
  }
  const energy = Energy.create((dryRun.usedEnergy.value * 12n) / 10n + 500n); // +20% margin

  const signable = Transaction.updateContract({ amount: CcdAmount.zero(), address, receiveName, message }, energy)
    .addMetadata({ sender: wallet.sender, nonce: await nextNonce(cfg, wallet) })
    .build();
  return submit(cfg, wallet, signable);
}

/**
 * Same as updateContract, for a parameter given as schema JSON (e.g. build_* tools' `parameter_json`).
 * The JSON is serialized with the schema embedded in the contract's module, read from the chain.
 */
export async function updateContractJson(
  cfg: NetworkConfig,
  wallet: Wallet,
  contract: { index: bigint; subindex: bigint },
  entrypoint: string,
  paramJson: unknown
): Promise<Submitted> {
  const grpc = client(cfg);
  const address = ContractAddress.create(contract.index, contract.subindex);
  const info = await grpc.getInstanceInfo(address);
  const schema = await grpc.getEmbeddedSchema(info.sourceModule);
  if (!schema) throw new Error('The contract has no embedded schema: cannot serialize the JSON parameter.');
  const parameter = serializeUpdateContractParameters(
    ContractName.fromInitName(info.name),
    EntrypointName.fromString(entrypoint),
    paramJson,
    schema.buffer,
    schema.type === 'unversioned' ? schema.version : undefined,
    true
  );
  return updateContract(cfg, wallet, contract, entrypoint, Parameter.toHexString(parameter));
}

/** Writes up to 256 bytes on-chain with a RegisterData transaction (no contract involved). */
export async function registerData(cfg: NetworkConfig, wallet: Wallet, data: Buffer): Promise<Submitted> {
  if (data.byteLength > 256) throw new Error(`RegisterData is limited to 256 bytes (got ${data.byteLength}).`);
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const signable = Transaction.registerData({ data: new DataBlob(bytes) })
    .addMetadata({ sender: wallet.sender, nonce: await nextNonce(cfg, wallet) })
    .build();
  return submit(cfg, wallet, signable);
}

export function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
