// src/concordium/server.ts
// APIX Verifier as a web service: other agents send a public GitHub repo,
// APIX checks the code and records the verdict on Concordium.
// POST /verify  {"repo": "https://github.com/owner/repo", "ref"?: "...", "subject"?: "<badge>"}
// GET  /attestation/<txHash>   read an attestation back and decode it
// GET  /                       what this agent is and how to call it
// Payment (x402) will gate POST /verify: see requirePayment.
import fs from 'fs';
import http from 'http';
import { AccountAddress } from '@concordium/web-sdk';
import { NetworkConfig } from './config';
import { buildRequirements, ccdExplorerTx, LocalFacilitator, paymentRequired, PriceConfig } from './payment';
import { Wallet, bigintSafe } from './chain';
import { attestOnConcordium, readAttestation } from './attest';
import { fetchGithubRepo, parseGithubUrl } from './github-source';
import { verifyConcordiumProject } from '../verify';
import { reportHash } from '../verify/report';

export interface ServerOptions {
  cfg: NetworkConfig;
  attester: Wallet;
  apixVersion: string;
  badge?: string;
  agentCardUrl?: string;
  /** Write attestations on-chain (false = verify only, for local tests) */
  attest: boolean;
  /** Where to keep the list of attestations this service wrote (a pointer index; the chain is the source of truth) */
  indexFile?: string;
  /** x402: when set, POST /verify requires a payment, settled by our own facilitator */
  payment?: { price: PriceConfig; facilitator: LocalFacilitator };
}

const MAX_BODY_BYTES = 16 * 1024;

/** One line per step, so whoever runs the service can follow each request */
function log(id: string, message: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} [${id}] ${message}`);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body, bigintSafe, 2));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Body must be JSON'), { status: 400 });
  }
}

export interface IndexEntry {
  repo: string;
  ref?: string;
  commit?: string;
  verdict: string;
  txHash: string;
  subject?: string;
  at: string;
}

function readIndex(file: string): IndexEntry[] {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as IndexEntry[];
  } catch {
    return [];
  }
}

let busy = false; // one verification at a time: the attester signs sequentially (nonces)

export function createVerifierServer(options: ServerOptions): http.Server {
  const attesterAddress = AccountAddress.toBase58(options.attester.sender);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-payment, payment-signature', 'access-control-expose-headers': 'payment-required, payment-response', 'access-control-allow-methods': 'GET, POST' });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, {
          agent: 'APIX Verifier',
          badge: options.badge ?? null,
          agentCard: options.agentCardUrl ?? null,
          network: options.cfg.network,
          attester: attesterAddress,
          price: options.payment ? { ...options.payment.price, network: options.cfg.network, protocol: 'x402 exact (Concordium, sponsored fees)', sponsor: options.payment.facilitator.sponsor } : 'free',
          usage: { attestations: 'GET /attestations?app=https://github.com/owner/repo', verify: 'POST /verify {"repo":"https://github.com/owner/repo","ref":"optional","subject":"optional badge"}', attestation: 'GET /attestation/<txHash>' },
        });
      }
      if (req.method === 'GET' && url.pathname === '/attestations') {
        const app = url.searchParams.get('app');
        const all = readIndex(options.indexFile ?? 'apix-attestations.json');
        const list = (app ? all.filter(e => e.repo === parseGithubUrl(app).url) : all).slice().reverse();
        return send(res, 200, { attester: attesterAddress, network: options.cfg.network, attestations: list.slice(0, 50) });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/attestation/')) {
        const tx = url.pathname.split('/')[2] ?? '';
        if (!/^[0-9a-fA-F]{64}$/.test(tx)) return send(res, 400, { error: 'Expected a 64-character transaction hash' });
        const found = await readAttestation(options.cfg, tx);
        return send(res, 200, { ...found, trustedAttester: found.attester === attesterAddress });
      }
      if (req.method === 'POST' && url.pathname === '/verify') {
        const id = Math.random().toString(36).slice(2, 7);
        const body = await readJson(req);
        log(id, `POST /verify ${typeof body.repo === 'string' ? body.repo : '(no repo)'}`);
        if (typeof body.repo !== 'string') return send(res, 400, { error: 'repo is required: https://github.com/owner/repo' });
        const repo = parseGithubUrl(body.repo, typeof body.ref === 'string' ? body.ref : undefined);
        const subject = typeof body.subject === 'string' && /^[1-9A-HJ-NP-Za-km-z]{8,40}$/.test(body.subject) ? body.subject : undefined;

        // x402: no payment header -> 402 with what to pay
        const paymentHeader = (req.headers['payment-signature'] ?? req.headers['x-payment']) as string | undefined;
        const requirements = options.payment
          ? buildRequirements(options.cfg, options.payment.price, options.payment.facilitator.sponsor)
          : undefined;
        if (requirements && !paymentHeader) {
          const required = paymentRequired(requirements, `${url.origin}/verify`, 'APIX Verifier: one code verification + on-chain attestation');
          res.setHeader('PAYMENT-REQUIRED', required.header);
          const shown = requirements.asset === 'CCD' ? `${Number(requirements.amount) / 1_000_000} CCD` : `${requirements.amount} ${requirements.asset} (atomic units)`;
          log(id, `402 Payment Required: ${shown} to ${requirements.payTo}`);
          return send(res, 402, required.body);
        }

        if (busy) return send(res, 429, { error: 'A verification is already running, retry in a minute' });
        busy = true;
        // Download first: a bad repo link must not cost the client anything
        log(id, `downloading ${repo.url}${repo.ref ? '@' + repo.ref : ''}`);
        const source = await fetchGithubRepo(repo).catch(e => { busy = false; log(id, `download failed: ${e.message}`); throw Object.assign(e, { status: 400 }); });
        try {
          let payment: unknown = null;
          if (requirements && options.payment && paymentHeader) {
            const facilitator = options.payment.facilitator;
            let payload;
            try {
              payload = facilitator.decode(paymentHeader);
            } catch {
              return send(res, 400, { error: 'Unreadable payment header' });
            }
            const check = await facilitator.verify(payload, requirements);
            if (!check.isValid) {
              log(id, `payment rejected: ${check.invalidReason ?? 'invalid'}`);
              const required = paymentRequired(requirements, `${url.origin}/verify`, 'APIX Verifier');
              res.setHeader('PAYMENT-REQUIRED', required.header);
              return send(res, 402, { ...required.body, error: `Payment rejected: ${check.invalidReason ?? 'invalid'} ${check.invalidMessage ?? ''}`.trim() });
            }
            log(id, 'payment valid, settling (sponsored)…');
            const settled = await facilitator.settle(payload, requirements);
            if (!settled.result.success) {
              log(id, `settlement failed: ${settled.result.errorReason ?? ''}`);
              return send(res, 402, { error: `Payment failed: ${settled.result.errorReason ?? ''} ${settled.result.errorMessage ?? ''}`.trim() });
            }
            res.setHeader('PAYMENT-RESPONSE', settled.header);
            log(id, `paid by ${settled.result.payer}: ${ccdExplorerTx(options.cfg, settled.result.transaction)}`);
            payment = {
              txHash: settled.result.transaction, payer: settled.result.payer,
              amount: requirements.amount, asset: requirements.asset, payTo: requirements.payTo,
              sponsor: facilitator.sponsor, explorer: ccdExplorerTx(options.cfg, settled.result.transaction),
            };
          }
          const appId = repo.ref ? `${repo.url}@${repo.ref}` : repo.url;
          const report = await verifyConcordiumProject({
            directory: source.dir, appId, network: options.cfg.network, apixVersion: options.apixVersion, archive: { commit: source.commit },
          });
          const hash = reportHash(report);
          log(id, `verdict ${report.summary.verdict.toUpperCase()} (${report.filesScanned} files, report ${hash.slice(0, 12)}…)`);
          let attestation: unknown = null;
          if (options.attest) {
            log(id, 'writing the attestation on Concordium…');
            const tx = await attestOnConcordium(options.cfg, options.attester, report, hash, subject);
            if (tx.outcome === 'success') {
              const file = options.indexFile ?? 'apix-attestations.json';
              const entry: IndexEntry = {
                repo: repo.url, ...(repo.ref ? { ref: repo.ref } : {}), ...(source.commit ? { commit: source.commit } : {}),
                verdict: report.summary.verdict, txHash: tx.txHash, ...(subject ? { subject } : {}), at: new Date().toISOString(),
              };
              fs.writeFileSync(file, JSON.stringify([...readIndex(file), entry], null, 2) + '\n');
            }
            attestation = tx.outcome === 'success'
              ? { txHash: tx.txHash, explorer: ccdExplorerTx(options.cfg, tx.txHash), attester: attesterAddress, onChain: tx.attestation }
              : { error: 'Attestation transaction rejected', txHash: tx.txHash };
          }
          const tx = (attestation as { explorer?: string } | null)?.explorer;
          log(id, tx ? `attested: ${tx}` : 'done (no attestation)');
          return send(res, 200, { verdict: report.summary.verdict, reportHash: hash, payment, attestation, report });
        } finally {
          source.cleanup();
          busy = false;
        }
      }
      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      return send(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
