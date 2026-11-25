// src/concordium/attest.ts
// APIX attestations on Concordium: a RegisterData transaction from the APIX attester
// account, holding the verdict and the SHA-256 of the full report. No smart contract.
// Anyone can read it back by transaction hash and check the report against it.
import { AccountAddress, TransactionHash } from '@concordium/web-sdk';
import { NetworkConfig } from './config';
import { client, registerData, Submitted, Wallet } from './chain';
import { VerifyReport } from '../verify/types';
import { Attestation, ATTESTATION_FORMAT, buildAttestation, decodeCborText } from './attestation-format';

export { Attestation, ATTESTATION_FORMAT, buildAttestation };

export async function attestOnConcordium(
  cfg: NetworkConfig, wallet: Wallet, report: VerifyReport, reportHash: string, subject?: string
): Promise<Submitted & { attestation: Attestation }> {
  const { attestation, bytes } = buildAttestation(report, reportHash, subject);
  const result = await registerData(cfg, wallet, bytes);
  return { ...result, attestation };
}

export interface ReadAttestation {
  txHash: string;
  blockHash: string;
  attester: string;
  attestation: Attestation;
}

/** Reads an attestation back from the chain by transaction hash. */
export async function readAttestation(cfg: NetworkConfig, txHash: string): Promise<ReadAttestation> {
  const status = await client(cfg).getBlockItemStatus(TransactionHash.fromHexString(txHash));
  if (status.status !== 'finalized') throw new Error(`Transaction ${txHash} is not finalized yet (status: ${status.status}).`);
  const summary = status.outcome.summary as {
    sender?: AccountAddress.Type; transactionType?: string; dataRegistered?: { data: string };
  } | null;
  if (!summary?.dataRegistered) {
    throw new Error(`Transaction ${txHash} is not a RegisterData transaction (type: ${summary?.transactionType ?? 'unknown'}).`);
  }
  const raw = Buffer.from(summary.dataRegistered.data, 'hex');
  const text = decodeCborText(raw) ?? raw.toString('utf8');
  let attestation: Attestation;
  try {
    attestation = JSON.parse(text);
  } catch {
    throw new Error(`Transaction ${txHash} holds data that is not an APIX attestation.`);
  }
  if (attestation.p !== ATTESTATION_FORMAT) throw new Error(`Transaction ${txHash} holds data in another format (${attestation.p}).`);
  return {
    txHash,
    blockHash: String(status.outcome.blockHash),
    attester: summary.sender ? AccountAddress.toBase58(summary.sender) : 'unknown',
    attestation,
  };
}
