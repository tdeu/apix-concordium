// src/serverless.ts
// APIX Verifier as a serverless function (Vercel). Configuration comes from encrypted
// environment variables instead of key files:
//   APIX_ATTESTER_KEY_JSON  content of the attester's wallet export (receives payments, signs attestations)
//   APIX_SPONSOR_KEY_JSON   content of the sponsor's wallet export (pays x402 fees); omit for a free service
//   APIX_PRICE_CCD          price per verification in CCD (default 1)
//   APIX_BADGE, APIX_CARD_URL, APIX_NETWORK (default testnet)
// The attestation index lives in /tmp: best effort only. The chain is the source of truth.
import os from 'os';
import path from 'path';
import type http from 'http';
import { AccountAddress } from '@concordium/web-sdk';
import { networkConfig } from './concordium/config';
import { loadWalletFromJson } from './concordium/chain';
import { createVerifierHandler } from './concordium/server';
import { LocalFacilitator } from './concordium/payment';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../package.json') as { version: string };

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<unknown>;
let handler: Handler | undefined;

function build(): Handler {
  const cfg = networkConfig(process.env.APIX_NETWORK ?? 'testnet');
  if (cfg.network === 'mainnet') throw new Error('Mainnet is disabled in this build.');
  const attesterJson = process.env.APIX_ATTESTER_KEY_JSON;
  if (!attesterJson) throw new Error('APIX_ATTESTER_KEY_JSON is not set');
  const attester = loadWalletFromJson(attesterJson, 'APIX_ATTESTER_KEY_JSON');
  let payment: { price: { amount: string; asset: string; payTo: string }; facilitator: LocalFacilitator } | undefined;
  if (process.env.APIX_SPONSOR_KEY_JSON) {
    const sponsor = loadWalletFromJson(process.env.APIX_SPONSOR_KEY_JSON, 'APIX_SPONSOR_KEY_JSON');
    const micro = Math.round(Number(process.env.APIX_PRICE_CCD ?? '1') * 1_000_000);
    if (!Number.isFinite(micro) || micro <= 0) throw new Error('APIX_PRICE_CCD must be a positive number');
    payment = {
      price: { amount: String(micro), asset: 'CCD', payTo: AccountAddress.toBase58(attester.sender) },
      facilitator: new LocalFacilitator(cfg, sponsor),
    };
  }
  return createVerifierHandler({
    cfg,
    attester,
    apixVersion: packageJson.version,
    badge: process.env.APIX_BADGE,
    agentCardUrl: process.env.APIX_CARD_URL,
    attest: true,
    payment,
    indexFile: path.join(os.tmpdir(), 'apix-attestations.json'),
  });
}

export default async function apixVerifier(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    handler ??= build();
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Service not configured: ${error instanceof Error ? error.message : String(error)}` }));
    return;
  }
  await handler(req, res);
}
