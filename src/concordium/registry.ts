// src/concordium/registry.ts
// Agent Registry (CIS-8004) flows: build an Agent Card, register the agent, check its badge.
// Payloads come from Concordium's hosted MCP server; signing happens locally (chain.ts).
import crypto from 'crypto';
import fs from 'fs';
import { NetworkConfig } from './config';
import { BuiltPayload, callTool, rest } from './mcp';
import { Submitted, updateContract, updateContractJson, Wallet } from './chain';
import { AccountAddress } from '@concordium/web-sdk';

export function sha256Hex(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export interface CardInput {
  name: string;
  description: string;
  agentUri: string;
  ownerAccount: string;
  skills?: Array<{ id: string; name: string; description: string; tags?: string[] }>;
  provider?: { organization: string; url?: string };
  documentationUrl?: string;
  /** Set on the second pass, once register has minted the token */
  tokenId?: number;
}

/** What APIX Verifier offers, published in its Agent Card */
export const APIX_SKILLS = [
  {
    id: 'verify-agent-code',
    name: 'Verify agent code',
    description: 'Checks an agent or app repository for exposed keys, unprotected spending routes and AI models that can spend without limits. Returns a hashed PASS / WARN / FAIL report.',
    tags: ['security', 'verification', 'code-audit'],
  },
  {
    id: 'attest-on-concordium',
    name: 'Attest on Concordium',
    description: 'Records each verification result (verdict + SHA-256 of the report) on Concordium, signed by the APIX attester account, so anyone can check it.',
    tags: ['attestation', 'audit-trail'],
  },
];

export interface BuiltCard {
  /** Exact bytes to host at agent_uri (hash is computed over these) */
  text: string;
  sha256: string;
  /** Raw tool output, for debugging the first runs */
  raw: unknown;
}

/**
 * Calls build_agent_card. The docs say it "returns the JSON and its SHA-256 hash" without naming the fields,
 * so we look for them and fall back to serializing the card ourselves. Either way the hash we report is
 * computed over the exact bytes we write, which is what verify_agent_card checks.
 */
export async function buildCard(cfg: NetworkConfig, input: CardInput): Promise<BuiltCard> {
  const raw = await callTool<Record<string, unknown>>('build_agent_card', {
    network: cfg.network,
    name: input.name,
    description: input.description,
    agent_uri: input.agentUri,
    owner_account: input.ownerAccount,
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.tokenId !== undefined ? { token_id: input.tokenId } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.documentationUrl ? { documentation_url: input.documentationUrl } : {}),
  });
  const card = pickCard(raw);
  const serverHash = typeof raw.metadata_hash_hex === 'string' ? raw.metadata_hash_hex.toLowerCase().replace(/^0x/, '') : undefined;
  // Prefer the exact bytes the server hashed: a string as-is, or the serialization whose hash matches.
  const candidates = typeof card === 'string' ? [card] : [JSON.stringify(card), JSON.stringify(card, null, 2)];
  const text = (serverHash && candidates.find(c => sha256Hex(c) === serverHash)) ?? candidates[0];
  if (serverHash && sha256Hex(text) !== serverHash) {
    console.warn(
      `⚠ Our SHA-256 of the card (${sha256Hex(text)}) differs from the server's metadata_hash_hex (${serverHash}). ` +
        'We will pin the hash of the bytes we write, which is what verifiers check.'
    );
  }
  return { text, sha256: sha256Hex(text), raw };
}

function pickCard(raw: Record<string, unknown>): unknown {
  for (const key of ['agent_card_json', 'card_json_text', 'card_text', 'canonical_json', 'card_json', 'agent_card', 'card', 'json']) {
    if (raw && raw[key] !== undefined) return raw[key];
  }
  if (raw && typeof raw === 'object' && 'name' in raw && 'capabilities' in raw) return raw;
  throw new Error(`build_agent_card returned an unexpected shape (keys: ${Object.keys(raw ?? {}).join(', ')}). Paste this to Claude.`);
}

/** Fetches the hosted card and checks it is byte-identical to what we will pin on-chain. */
export async function checkHostedCard(agentUri: string, expectedSha256: string): Promise<void> {
  const res = await fetch(agentUri, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`Agent Card not reachable at ${agentUri}: HTTP ${res.status}`);
  const served = Buffer.from(await res.arrayBuffer());
  const got = sha256Hex(served);
  if (got !== expectedSha256) {
    throw new Error(
      `The card served at ${agentUri} has SHA-256 ${got}, expected ${expectedSha256}. ` +
        'Host the file exactly as written (no reformatting, no trailing newline added) and try again.'
    );
  }
}

export interface Registration extends Submitted {
  payload: BuiltPayload;
}

/** build_register on the MCP server, then sign + submit the CIS-8004 `register` entrypoint. */
export async function registerAgent(
  cfg: NetworkConfig,
  wallet: Wallet,
  agentUri: string,
  metadataHashHex: string
): Promise<Registration> {
  const payload = await callTool<BuiltPayload>('build_register', {
    network: cfg.network,
    sender: AccountAddress.toBase58(wallet.sender),
    agent_uri: agentUri,
    metadata_hash_hex: metadataHashHex,
  });
  return { ...(await submitBuilt(cfg, wallet, cfg.cis8004, 'register', payload)), payload };
}

/**
 * Submits a build_* payload. The docs describe { hex, schema_json }, but the live server returns
 * { contract_address, receive_name, parameter_json, ... }: accept a hex field when present,
 * else serialize parameter_json with the contract's on-chain schema.
 */
export async function submitBuilt(
  cfg: NetworkConfig,
  wallet: Wallet,
  fallbackContract: { index: bigint; subindex: bigint },
  fallbackEntrypoint: string,
  payload: BuiltPayload
): Promise<Submitted> {
  fs.writeFileSync('last-payload.json', JSON.stringify(payload, null, 2)); // public data only, for debugging
  const addr = payload.contract_address as { index?: number; subindex?: number } | undefined;
  const contract =
    addr && addr.index !== undefined
      ? { index: BigInt(addr.index), subindex: BigInt(addr.subindex ?? 0) }
      : fallbackContract;
  const receive = typeof payload.receive_name === 'string' ? payload.receive_name : undefined;
  const entrypoint = receive?.includes('.') ? receive.slice(receive.indexOf('.') + 1) : fallbackEntrypoint;

  const hex = ['hex', 'parameter_hex', 'parameter', 'payload_hex', 'message_hex']
    .map(k => payload[k])
    .find((v): v is string => typeof v === 'string' && /^[0-9a-fA-F]*$/.test(v));
  if (hex !== undefined) return updateContract(cfg, wallet, contract, entrypoint, hex);
  if (payload.parameter_json !== undefined) {
    return updateContractJson(cfg, wallet, contract, entrypoint, payload.parameter_json);
  }
  throw new Error(
    `Unexpected payload from the registry (keys: ${Object.keys(payload).join(', ')}). Saved to last-payload.json: send it to Claude.`
  );
}

/** Agents owned by an account (on-chain lookup, no indexer). */
export async function agentsByOwner(cfg: NetworkConfig, owner: string): Promise<unknown> {
  return callTool('agents_by_owner', { network: cfg.network, owner_account: owner });
}

/** GET /v1/check-badge/{badge or account} */
/** Second pass: pin the hash of the re-hosted card on-chain (setAgentURI), via the documented REST builder. */
export async function pinCard(cfg: NetworkConfig, wallet: Wallet, badge: string, agentUri: string, hashHex: string): Promise<Submitted> {
  const sender = AccountAddress.toBase58(wallet.sender);
  const query = new URLSearchParams({ metadata_hash_hex: hashHex, agent_uri: agentUri, sender, network: cfg.network });
  const payload = await rest<BuiltPayload>(`/v1/build-set-agent-uri/${encodeURIComponent(badge)}?${query}`);
  return submitBuilt(cfg, wallet, cfg.cis8004, 'setAgentURI', payload);
}

export async function checkBadge(id: string, network?: string): Promise<unknown> {
  return rest(`/v1/check-badge/${encodeURIComponent(id)}${network ? `?network=${network}` : ''}`);
}

export async function contractInfo(cfg: NetworkConfig): Promise<unknown> {
  return callTool('contract_info', { network: cfg.network });
}
