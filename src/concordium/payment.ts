// src/concordium/payment.ts
// x402 payments on Concordium with the official @x402/concordium package.
// APIX runs its own facilitator in-process: the client agent signs a transfer to the
// APIX attester account, the sponsor account (owner) adds its signature and pays the fee.
import { AccountAddress } from '@concordium/web-sdk';
import { ExactConcordiumScheme as FacilitatorScheme } from '@x402/concordium/exact/facilitator';
import { ExactConcordiumScheme as ClientScheme } from '@x402/concordium/exact/client';
import { toConcordiumFacilitatorSigner, CONCORDIUM_TESTNET_CAIP2, CONCORDIUM_MAINNET_CAIP2 } from '@x402/concordium';
import {
  decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader,
  encodePaymentResponseHeader, encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { NetworkConfig } from './config';
import { Wallet } from './chain';

export const X402_VERSION = 2;

export function caip2(cfg: NetworkConfig): `${string}:${string}` {
  return (cfg.network === 'mainnet' ? CONCORDIUM_MAINNET_CAIP2 : CONCORDIUM_TESTNET_CAIP2) as `${string}:${string}`;
}

/** Explorer link in the format the x402 package (and the hackathon) uses: ccdexplorer.io */
export function ccdExplorerTx(cfg: NetworkConfig, txHash: string): string {
  return cfg.network === 'mainnet'
    ? `https://ccdexplorer.io/mainnet/transaction/${txHash}`
    : `https://ccdexplorer.io/testnet/transaction/${txHash}`;
}

export interface PriceConfig {
  /** Atomic units: microCCD for CCD (6 decimals) */
  amount: string;
  /** 'CCD', or a PLT token id */
  asset: string;
  payTo: string;
}

export function buildRequirements(cfg: NetworkConfig, price: PriceConfig, sponsor: string): PaymentRequirements {
  return {
    scheme: 'exact',
    network: caip2(cfg),
    asset: price.asset,
    amount: price.amount,
    payTo: price.payTo,
    maxTimeoutSeconds: 300,
    extra: { feePayer: sponsor },
  };
}

export function paymentRequired(requirements: PaymentRequirements, url: string, description: string): { body: PaymentRequired; header: string } {
  const body: PaymentRequired = {
    x402Version: X402_VERSION,
    error: 'Payment required',
    resource: { url, description, mimeType: 'application/json' },
    accepts: [requirements],
  };
  return { body, header: encodePaymentRequiredHeader(body) };
}

/** The facilitator: verifies the client's signed transfer, co-signs as sponsor, submits, waits for finality. */
export class LocalFacilitator {
  private readonly scheme: FacilitatorScheme;
  readonly sponsor: string;

  constructor(cfg: NetworkConfig, sponsorWallet: Wallet) {
    this.sponsor = AccountAddress.toBase58(sponsorWallet.sender);
    const signer = toConcordiumFacilitatorSigner(this.sponsor, sponsorWallet.signer, {
      host: cfg.grpcHost, port: cfg.grpcPort, useTls: true, network: caip2(cfg),
    } as Parameters<typeof toConcordiumFacilitatorSigner>[2]);
    this.scheme = new FacilitatorScheme({ signer, requireFinalization: true } as ConstructorParameters<typeof FacilitatorScheme>[0]);
  }

  decode(header: string): PaymentPayload {
    return decodePaymentSignatureHeader(header);
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements) {
    return this.scheme.verify(payload, requirements);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ result: SettleResponse; header: string }> {
    const result = await this.scheme.settle(payload, requirements);
    return { result, header: encodePaymentResponseHeader(result) };
  }
}

/** Client side: answers a 402 by signing the requested transfer (the client never broadcasts). */
export async function payFor(
  cfg: NetworkConfig, clientWallet: Wallet, paymentRequiredHeader: string, resourceUrl: string
): Promise<{ header: string; requirements: PaymentRequirements }> {
  const required = decodePaymentRequiredHeader(paymentRequiredHeader);
  const requirements = required.accepts.find((r: PaymentRequirements) => r.scheme === 'exact' && r.network === caip2(cfg));
  if (!requirements) throw new Error(`The server asks for a payment we cannot make: ${JSON.stringify(required.accepts)}`);
  const scheme = new ClientScheme(
    { accountAddress: clientWallet.sender, signer: clientWallet.signer } as ConstructorParameters<typeof ClientScheme>[0],
    { grpcUrl: `${cfg.grpcHost}:${cfg.grpcPort}`, useTls: true } as ConstructorParameters<typeof ClientScheme>[1]
  );
  const partial = await scheme.createPaymentPayload(X402_VERSION, requirements);
  const payload: PaymentPayload = {
    x402Version: partial.x402Version,
    resource: required.resource ?? { url: resourceUrl, description: '', mimeType: 'application/json' },
    accepted: requirements,
    payload: partial.payload,
  };
  return { header: encodePaymentSignatureHeader(payload), requirements };
}
